'use strict';

/**
 * Tamper-evident log run by a single trusted operator: the baseline the
 * ledger has to beat.
 *
 * Every entry is appended to a file and chained: h_n = SHA-256(h_{n-1} || n ||
 * entry). Appends are group-committed — whatever is queued is written in one
 * batch, fsync'd, and the new head (n, h_n) is signed by the operator with
 * Ed25519 before any request in the batch is acknowledged. A client keeping
 * the signed heads it receives can later prove that the operator rewrote
 * history, because no later head will be consistent with an earlier one.
 *
 * What the log does not provide is what the comparison is about: the operator
 * alone decides what is appended (any entry, on anyone's behalf), can refuse
 * or delay an entry, and can show different clients different logs unless
 * the heads are cross-checked by independent witnesses. The ledger replaces
 * each of these with a multi-organisation check.
 *
 *   node telog/server.js [--port 8080] [--file /data/log.ndjson]
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const PORT = Number(args.port || 8080);
const FILE = args.file || '/data/log.ndjson';
const MAX_BATCH = 500;

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const fd = fs.openSync(FILE, 'a');
let head = { n: 0, h: Buffer.alloc(32).toString('hex') };
const keys = new Set();
let queue = [];
let flushing = false;

function chain(prev, n, entry) {
  return crypto.createHash('sha256').update(prev, 'hex').update(String(n)).update(entry).digest('hex');
}

function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.slice(0, MAX_BATCH);
  queue = queue.slice(MAX_BATCH);
  const lines = [];
  const accepted = [];
  for (const item of batch) {
    if (keys.has(item.key)) {
      item.res.writeHead(409, { 'content-type': 'application/json' });
      item.res.end(JSON.stringify({ error: `${item.key} already exists` }));
      continue;
    }
    keys.add(item.key);
    const n = head.n + 1;
    const entry = JSON.stringify({ n, key: item.key, docs: item.docs, at: new Date().toISOString() });
    const h = chain(head.h, n, entry);
    head = { n, h };
    lines.push(`${JSON.stringify({ n, h, entry })}\n`);
    accepted.push({ item, n, h });
  }
  const signedHead = { n: head.n, h: head.h };
  signedHead.signature = crypto.sign(null, Buffer.from(`${signedHead.n}:${signedHead.h}`), privateKey).toString('base64');
  fs.write(fd, lines.join(''), (err) => {
    if (err) throw err;
    fs.fsync(fd, (err2) => {
      if (err2) throw err2;
      for (const { item, n, h } of accepted) {
        item.res.writeHead(200, { 'content-type': 'application/json' });
        item.res.end(JSON.stringify({ n, h, head: signedHead }));
      }
      flushing = false;
      setImmediate(flush);
    });
  });
}

const { verify } = require('./verify');

http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/append') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const { key, docs } = JSON.parse(body);
          queue.push({ key, docs, res });
          flush();
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    } else if (req.url === '/verify') {
      // Streams the file, so a log of any length can be checked.
      verify(FILE).then((v) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...v, headMatchesSigned: v.head === head.h && v.entries === head.n,
          operatorKey: publicKey.export({ type: 'spki', format: 'pem' }) }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(PORT, () => console.log(`[telog] tamper-evident log on :${PORT}, file ${FILE}`));
