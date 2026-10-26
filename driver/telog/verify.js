'use strict';

/**
 * Verify a tamper-evident log file offline: recompute the hash chain entry by
 * entry, streaming, and check that sequence numbers are contiguous and every
 * stored hash matches its recomputation. Prints the number of entries and the
 * final head, which a client holding a signed head can compare.
 *
 *   node telog/verify.js /data/log.ndjson
 */

const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');

function chain(prev, n, entry) {
  return crypto.createHash('sha256').update(prev, 'hex').update(String(n)).update(entry).digest('hex');
}

async function verify(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let h = Buffer.alloc(32).toString('hex');
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    const rec = JSON.parse(line);
    n += 1;
    h = chain(h, n, rec.entry);
    if (rec.n !== n || rec.h !== h) return { valid: false, failedAt: n };
  }
  return { valid: true, entries: n, head: h };
}

module.exports = { verify };

if (require.main === module) {
  verify(process.argv[2] || '/data/log.ndjson').then((r) => console.log(JSON.stringify(r)));
}
