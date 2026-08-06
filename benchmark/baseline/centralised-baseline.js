'use strict';
/**
 * Centralised control arm for the throughput measurement.
 *
 * "18 transactions per second" invites the question "compared with what?".
 * This performs the same custody-initiation write as the chaincode — the sample
 * record and its step-0 custody event, written atomically and committed to disk
 * — against a single CouchDB instance with no endorsement, no ordering, no
 * validation and no second copy of the state. It is the same host, the same
 * state-database engine and the same payload, so the difference between the two
 * measurements is the price of the governance guarantees rather than of the
 * storage technology.
 *
 * The comparison is deliberately generous to the control: a single writer, a
 * single node, no replication, no consensus, no audit trail.
 *
 * Usage (inside a container on antidoping_net):
 *   node centralised-baseline.js --url http://baseline-couchdb:5984 \
 *        --db custody-baseline --tps 50 --tx 500 --workers 2
 */

const http = require('http');
const { URL } = require('url');

const args = require('node:util').parseArgs({
  options: {
    url: { type: 'string', default: 'http://baseline-couchdb:5984' },
    db: { type: 'string', default: 'custody-baseline' },
    tps: { type: 'string', default: '50' },
    tx: { type: 'string', default: '500' },
    workers: { type: 'string', default: '2' },
    label: { type: 'string', default: 'baseline' },
    user: { type: 'string', default: 'admin' },
    pass: { type: 'string', default: 'adminpw' },
  },
}).values;

const BASE = new URL(args.url);
const DB = args.db;
const TPS = Number(args.tps);
const TX = Number(args.tx);
const WORKERS = Number(args.workers);
const AUTH = `Basic ${Buffer.from(`${args.user}:${args.pass}`).toString('base64')}`;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: BASE.hostname,
        port: BASE.port || 5984,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          authorization: AUTH,
          ...(payload ? { 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** One transaction: the sample record and its step-0 custody event, atomically. */
function docs(code, athleteHash, i) {
  const now = new Date().toISOString();
  return [
    {
      _id: `sample:${code}`,
      docType: 'sample',
      sampleCode: code,
      athleteHash,
      sealedContainerHash: `seal-${i}`,
      collectionLocation: 'Tunis National Testing Centre',
      collectionTimestamp: now,
      initiatingMSP: 'NADOMSP',
      status: 'IN_CUSTODY',
      custodySequence: 0,
    },
    {
      _id: `custody:${code}:0`,
      docType: 'custodyEvent',
      sampleCode: code,
      sequence: 0,
      phase: 'COLLECTION',
      fromMSP: 'AthleteMSP',
      toMSP: 'NADOMSP',
      transferDeadline: now,
      recordedAt: now,
      submittingMSP: 'NADOMSP',
      containerSealIntact: true,
    },
  ];
}

async function main() {
  await request('PUT', `/${DB}`);

  const athleteHash = `${'a'.repeat(56)}00000000`;
  const tag = Date.now().toString(36);
  const perWorker = Math.ceil(TX / WORKERS);
  const intervalMs = 1000 / (TPS / WORKERS);

  const latencies = [];
  let succeeded = 0;
  let failed = 0;
  let submitted = 0;

  const started = Date.now();

  async function worker(w) {
    for (let i = 0; i < perWorker; i += 1) {
      // Fixed-rate submission: the target send time does not slip when a
      // request is slow, which is how Caliper's fixed-rate control behaves.
      const due = started + i * intervalMs;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      const code = `SMP-${tag}-w${w}-${i}`;
      submitted += 1;
      const t0 = Date.now();
      try {
        // Full commit forces an fsync before the response, so the measured
        // latency covers durable storage as the ledger commit does.
        const res = await request(
          'POST',
          `/${DB}/_bulk_docs`,
          { docs: docs(code, athleteHash, i) },
          { 'x-couch-full-commit': 'true' },
        );
        if (res.status >= 200 && res.status < 300) {
          succeeded += 1;
          latencies.push((Date.now() - t0) / 1000);
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
  const elapsed = (Date.now() - started) / 1000;

  latencies.sort((a, b) => a - b);
  const mean = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);

  const result = {
    label: args.label,
    configuredSendRateTps: TPS,
    achievedSendRateTps: Number((submitted / elapsed).toFixed(1)),
    throughputTps: Number((succeeded / elapsed).toFixed(1)),
    avgLatencyS: Number(mean.toFixed(3)),
    minLatencyS: Number((latencies[0] ?? 0).toFixed(3)),
    maxLatencyS: Number((latencies[latencies.length - 1] ?? 0).toFixed(3)),
    successful: succeeded,
    failed,
    durationS: Number(elapsed.toFixed(1)),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
