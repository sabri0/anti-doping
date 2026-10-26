'use strict';

/**
 * Open-loop load driver.
 *
 * A run is a plan: an ordered list of rounds, each naming a workload, an
 * offered rate, a warm-up and a measured duration. For every round:
 *
 *   1. each worker provisions the state its transactions need (untimed);
 *   2. all workers start together and submit at the offered rate on a fixed
 *      schedule, whether or not earlier transactions have finished (open
 *      loop: a slow network does not slow the offered load down);
 *   3. transactions submitted during the warm-up are excluded; the measured
 *      window is the following `duration` seconds;
 *   4. after the window, in-flight transactions are given time to finish.
 *
 * Reported per round: offered and committed throughput over the window,
 * end-to-end latency percentiles of transactions submitted in the window,
 * failures by validation code, and the committed count in every second of the
 * window (for stationarity diagnostics).
 *
 * The driver runs in its own container pinned to processors the network does
 * not use (scripts/run-evaluation.sh).
 *
 *   node bench.js --plan plans/K1.json --out ../docs/measurements/K1.json [--workers 2]
 */

const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);

if (process.argv.includes('--worker')) {
  require('./lib/worker');
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarise(round, parts, startAt) {
  const w0 = startAt + round.warmup * 1000;
  const w1 = w0 + round.duration * 1000;
  const lat = [];
  const endorse = [];
  const order = [];
  const commit = [];
  const failures = {};
  let offered = 0;
  let committedInWindow = 0;
  let skipped = 0;
  const perSecond = new Array(round.duration).fill(0);
  let lastEnd = 0;
  for (const p of parts) {
    skipped += p.skipped;
    for (let i = 0; i < p.submit.length; i += 1) {
      const s = p.submit[i];
      const e = p.end[i];
      const ok = p.ok[i] === 1;
      if (s >= w0 && s < w1) {
        offered += 1;
        if (ok) {
          lat.push(e - s);
          const ph = p.phases && p.phases[i];
          if (ph) {
            endorse.push(ph[0]);
            order.push(ph[1]);
            commit.push(ph[2]);
          }
        }
        else failures[p.code[i]] = (failures[p.code[i]] || 0) + 1;
      }
      if (ok && e >= w0 && e < w1) {
        committedInWindow += 1;
        perSecond[Math.floor((e - w0) / 1000)] += 1;
      }
      if (e > lastEnd) lastEnd = e;
    }
  }
  lat.sort((a, b) => a - b);
  const med = (xs) => percentile(xs.sort((a, b) => a - b), 50);
  const mean = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;
  return {
    id: round.id,
    workload: round.workload,
    block: round.block ?? null,
    configuredTps: round.tps ?? null,
    concurrency: round.concurrency ?? null,
    warmupS: round.warmup,
    durationS: round.duration,
    offered,
    offeredTps: offered / round.duration,
    committedTps: committedInWindow / round.duration,
    committedOfOffered: lat.length,
    failures,
    skippedAtInflightCap: skipped,
    poolExhausted: parts.some((p) => p.poolExhausted),
    latencyMs: {
      mean,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      p99: percentile(lat, 99),
      max: lat.length ? lat[lat.length - 1] : null,
    },
    phaseMedianMs: endorse.length ? { endorse: med(endorse), order: med(order), commit: med(commit) } : null,
    perSecondCommitted: perSecond,
    drainedAfterWindowS: Math.max(0, (lastEnd - w1) / 1000),
  };
}

async function main() {
  const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8'));
  const workers = Number(args.workers || plan.workers || 2);
  const out = args.out;
  const rawDir = args.raw || `${out.replace(/\.json$/, '')}-raw`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });

  const children = Array.from({ length: workers }, (_, i) => {
    const child = fork(__filename, ['--worker'], { env: { ...process.env, WORKER_INDEX: String(i), WORKERS: String(workers) } });
    child.setMaxListeners(100);
    return child;
  });
  const ask = (child, msg) =>
    new Promise((resolve, reject) => {
      const onMsg = (m) => {
        if (m.re !== msg.type) return;
        child.off('message', onMsg);
        if (m.error) reject(new Error(m.error));
        else resolve(m);
      };
      child.on('message', onMsg);
      child.send(msg);
    });

  await Promise.all(children.map((c) => ask(c, { type: 'init', plan: { name: plan.name } })));

  const results = { name: plan.name, configuration: plan.configuration || {}, startedAt: new Date().toISOString(), workers, rounds: [] };
  const persist = () => fs.writeFileSync(out, JSON.stringify(results, null, 2));

  for (const [n, round] of plan.rounds.entries()) {
    const load = round.concurrency ? `concurrency ${round.concurrency}` : `${round.tps} tps`;
    const label = `[${n + 1}/${plan.rounds.length}] ${round.id} ${round.workload} @${load}`;
    process.stdout.write(`${label}: provisioning... `);
    const t0 = Date.now();
    const provisioned = await Promise.all(children.map((c) => ask(c, { type: 'provision', round })));
    process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(0)}s; running... `);
    const startAt = Date.now() + 1000;
    const parts = await Promise.all(children.map((c) => ask(c, { type: 'run', round, startAt })));
    const summary = summarise(round, parts, startAt);
    summary.provisionS = (Date.now() - t0) / 1000;
    summary.provisioned = provisioned.reduce((n, p) => n + (p.provisioned || 0), 0);
    summary.provisionErrors = provisioned.reduce((n, p) => n + (p.provisionErrors || 0), 0);
    results.rounds.push(summary);
    persist();
    fs.writeFileSync(
      path.join(rawDir, `${String(n + 1).padStart(3, '0')}-${round.id}.json`),
      JSON.stringify({ round, startAt, parts: parts.map((p) => ({ submit: p.submit, end: p.end, ok: p.ok, code: p.code })) }),
    );
    console.log(
      `offered ${summary.offeredTps.toFixed(1)}, committed ${summary.committedTps.toFixed(1)} tps; ` +
        `p50 ${summary.latencyMs.p50?.toFixed(0)} p95 ${summary.latencyMs.p95?.toFixed(0)} ms; ` +
        `phases ${JSON.stringify(summary.phaseMedianMs)}; failures ${JSON.stringify(summary.failures)}`,
    );
    if (round.pauseAfter) await new Promise((r) => setTimeout(r, round.pauseAfter * 1000));
  }
  results.finishedAt = new Date().toISOString();
  persist();
  for (const c of children) c.send({ type: 'exit' });
  console.log(`wrote ${out}`);
}
