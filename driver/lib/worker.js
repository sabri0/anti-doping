'use strict';

/**
 * One load-driver worker. Holds its own gateway connection to each
 * organisation (through peer0 or peer1, alternating by worker index, so that
 * gateway load is spread across both peers of every organisation), provisions
 * its own keys, and submits its share of the offered rate on a fixed schedule.
 */

const crypto = require('crypto');
const { connectOrg, transact, query, chaincodeMessage } = require('./fabric');
const { WORKLOADS, step, LIST, NADO_LAB, pseudonym } = require('./workloads');

const INDEX = Number(process.env.WORKER_INDEX || 0);
const WORKERS = Number(process.env.WORKERS || 1);
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 4000);
const PROVISION_CONCURRENCY = Number(process.env.PROVISION_CONCURRENCY || 48);

let conns = null;
const tag = `${crypto.randomBytes(3).toString('hex')}w${INDEX}`;
let roundCounter = 0;
let pool = [];
let consentAthlete = null;
const athleteOf = new Map();

const ctx = {
  custody: 'custody',
  athlete: (code) => {
    if (!athleteOf.has(code)) athleteOf.set(code, pseudonym());
    return athleteOf.get(code);
  },
  get consentAthlete() {
    return consentAthlete;
  },
};

function connections() {
  if (!conns) {
    conns = {};
    for (const org of ['athlete', 'federation', 'nado', 'lab', 'research']) conns[org] = connectOrg(org, INDEX % 2);
  }
  return conns;
}

/** Run `tasks` (thunks) with bounded concurrency. */
async function bounded(tasks, limit) {
  let next = 0;
  const errors = [];
  async function lane() {
    while (next < tasks.length) {
      const i = next++;
      try {
        await tasks[i]();
      } catch (e) {
        errors.push(chaincodeMessage(e));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
  return errors;
}

async function send(tx) {
  const c = connections()[tx.org];
  const r = await transact(c, tx.cc, tx.fn, { args: tx.args, transient: tx.transient, endorsers: tx.endorsers });
  if (!r.valid) throw new Error(`${tx.fn} invalid: code ${r.code}`);
  return r;
}

/**
 * Provisioning only: retry a transaction that failed validation with an MVCC
 * or phantom-read conflict, which happens when an endorsing peer has not yet
 * committed the block holding the previous step. Measured transactions are
 * never retried.
 */
async function sendProvisioning(tx) {
  for (let tries = 1; ; tries += 1) {
    try {
      return await send(tx);
    } catch (e) {
      if (/code (11|12)$/.test(String(e.message)) && tries < 4) {
        await new Promise((res) => setTimeout(res, 1000 * tries));
        continue;
      }
      throw e;
    }
  }
}

async function provision(round) {
  const w = WORKLOADS[round.workload];
  if (w && w.setup === 'consent' && !consentAthlete) {
    consentAthlete = pseudonym();
    await send({
      org: 'athlete',
      cc: 'consent',
      fn: 'recordConsentTransaction',
      args: [],
      transient: {
        athleteHash: consentAthlete,
        grantedToMSP: 'ResearchMSP',
        purpose: 'cardiovascular_research',
        categories: ['abp_haematological', 'gps_accelerometry', 'genetic'],
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2028-01-01T00:00:00.000Z',
        specialCategoryAuthorised: true,
      },
      endorsers: ['AthleteMSP'],
    });
  }
  if (!w || !w.needsPool) {
    pool = [];
    return { provisioned: 0 };
  }
  roundCounter += 1;
  // A closed-loop round states the throughput it expects so the pool can be sized.
  const perWorkerTps = (round.tps || round.expectTps || 20) / WORKERS;
  const size = w.reusePool
    ? 60
    : Math.ceil(perWorkerTps * (round.warmup + round.duration) * 1.1) + 20;
  pool = Array.from({ length: size }, (_, i) => `SMP-${tag}-r${roundCounter}-${i}`);
  let errors = [];
  for (const name of w.provisionSteps) {
    errors = errors.concat(await bounded(pool.map((code) => () => sendProvisioning(step(name, code, ctx))), PROVISION_CONCURRENCY));
  }
  return { provisioned: pool.length, provisionErrors: errors.length, firstError: errors[0] };
}

async function httpRequest(round, i) {
  const code = `BL-${tag}-${round.id}-${i}`;
  const sample = { _id: `sample:${code}`, docType: 'sample', sampleCode: code, athleteHash: pseudonym(), sealedContainerHash: `seal-${code}`, status: 'IN_CUSTODY', custodySequence: 0, collectionTimestamp: new Date().toISOString() };
  const event = { _id: `custody:${code}:0000`, docType: 'custodyEvent', sampleCode: code, sequence: 0, phase: 'COLLECTION', fromMSP: 'AthleteMSP', toMSP: 'NADOMSP', recordedAt: sample.collectionTimestamp };
  let res;
  if (round.workload === 'baseline-couchdb') {
    res = await fetch(`${round.target}/_bulk_docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-couch-full-commit': 'true', authorization: `Basic ${Buffer.from('admin:adminpw').toString('base64')}` },
      body: JSON.stringify({ docs: [sample, event] }),
    });
  } else {
    res = await fetch(`${round.target}/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: code, docs: [sample, event] }),
    });
  }
  const body = await res.text();
  if (!res.ok || /"error"/.test(body)) throw new Error(`http ${res.status} ${body.slice(0, 120)}`);
}

async function run(round, startAt) {
  const w = WORKLOADS[round.workload];
  const http = round.workload.startsWith('baseline-');
  const perWorkerTps = (round.tps || 1) / WORKERS;
  const interval = 1000 / perWorkerTps;
  const end = startAt + (round.warmup + round.duration) * 1000;
  const submit = [];
  const finish = [];
  const ok = [];
  const code = [];
  const phases = [];
  let inflight = 0;
  let skipped = 0;
  let i = 0;
  let poolIndex = 0;
  const pending = [];

  const launch = (k) => {
    const s = Date.now();
    const idx = submit.length;
    submit.push(s);
    finish.push(0);
    ok.push(0);
    code.push('');
    phases.push(null);
    inflight += 1;
    let p;
    if (http) {
      p = httpRequest(round, k);
    } else {
      const sample = w.needsPool ? pool[(poolIndex++) % pool.length] : `SMP-${tag}-${round.id}-${k}`;
      const tx = w.build(sample, ctx, k + INDEX * 1000003);
      p = w.kind === 'read' ? query(connections()[tx.org], tx.cc, tx.fn, tx.args, tx.endorsers) : send(tx);
    }
    const settled =
      p.then(
        (r) => {
          ok[idx] = 1;
          if (r && r.timing) phases[idx] = [Math.round(r.timing.endorse), Math.round(r.timing.order), Math.round(r.timing.commit)];
        },
        (e) => {
          const m = /code (\d+)/.exec(String(e && e.message)) || [];
          code[idx] = m[1] ? `validation-${m[1]}` : chaincodeMessage(e).slice(0, 60);
        },
      ).finally(() => {
        finish[idx] = Date.now();
        inflight -= 1;
      });
    pending.push(settled);
    return settled;
  };

  if (round.concurrency) {
    // Closed loop: a fixed number of outstanding transactions, each lane
    // submitting its next transaction only when the previous one commits.
    // Throughput at a given concurrency is what the network sustains without
    // building a backlog, which an open-loop round past saturation cannot show.
    const lanes = Math.max(1, Math.round(round.concurrency / WORKERS));
    while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 1));
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        while (Date.now() < end) {
          await launch(i++);
        }
      }),
    );
    return { submit, end: finish, ok, code, phases, skipped, poolExhausted: Boolean(w && w.needsPool && !w.reusePool && poolIndex > pool.length) };
  }

  // Offset each worker's schedule by a fraction of the interval so the
  // aggregate arrivals are evenly spaced rather than bunched.
  let next = startAt + (interval * INDEX) / WORKERS;
  while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 1));
  while (true) {
    const now = Date.now();
    if (now >= end) break;
    while (next <= now && next < end) {
      if (inflight >= MAX_INFLIGHT) skipped += 1;
      else launch(i);
      i += 1;
      next += interval;
    }
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(5, next - Date.now()))));
  }
  // Drain: wait for in-flight work, bounded so a stalled network cannot hang the run.
  const drainDeadline = Date.now() + (round.drainS || 90) * 1000;
  while (inflight > 0 && Date.now() < drainDeadline) await new Promise((r) => setTimeout(r, 100));
  for (let k = 0; k < finish.length; k += 1) if (finish[k] === 0) { finish[k] = Date.now(); code[k] = code[k] || 'unfinished'; }
  return { submit, end: finish, ok, code, phases, skipped, poolExhausted: Boolean(w && w.needsPool && !w.reusePool && poolIndex > pool.length) };
}

process.on('message', async (msg) => {
  try {
    if (msg.type === 'init') {
      // Baseline runs (NO_FABRIC=1) talk only HTTP and have no network to connect to.
      if (process.env.NO_FABRIC) {
        process.send({ re: 'init' });
        return;
      }
      connections();
      // Register the Prohibited List revision the analysis workload cites (idempotent).
      try {
        await send({ org: 'nado', cc: 'custody', fn: 'registerProhibitedList', args: [LIST.version, LIST.hash], endorsers: NADO_LAB });
      } catch {
        /* already registered */
      }
      process.send({ re: 'init' });
    } else if (msg.type === 'provision') {
      process.send({ re: 'provision', ...(await provision(msg.round)) });
    } else if (msg.type === 'run') {
      process.send({ re: 'run', ...(await run(msg.round, msg.startAt)) });
    } else if (msg.type === 'exit') {
      if (conns) for (const c of Object.values(conns)) c.close();
      process.exit(0);
    }
  } catch (e) {
    process.send({ re: msg.type, error: chaincodeMessage(e) });
  }
});
