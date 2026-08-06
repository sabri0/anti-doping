/**
 * Acceptance tests for off-chain storage, key sharing and Article 17 erasure.
 *
 * The IPFS suites run against the live Kubo cluster started by
 * scripts/network-up.sh. If the cluster is unreachable they are skipped with a
 * visible notice rather than silently passing — a skipped acceptance gate must
 * never read as a passing one.
 */

import { expect } from 'chai';
import { randomBytes } from 'crypto';
import fc from 'fast-check';
import {
  IpfsCluster,
  KeyVault,
  StoredPayload,
  decrypt,
  encrypt,
  retrieveDecrypted,
  storeEncrypted,
} from '../src/ipfs-client';
import { destroyIPFSAccessToken, recoverDataAccessKey, revokeDataAccessKey } from '../src/erasure';
import { RECOVERY_HOLDERS, combine, secretsEqual, split, splitForRecovery } from '../src/shamir';

/** A representative athlete biological payload (ABP haematological module). */
const SAMPLE_PAYLOAD = Buffer.from(
  JSON.stringify({
    athleteHash: 'a'.repeat(64),
    category: 'abp_haematological',
    observations: [
      { marker: 'HGB', value: 15.2, unit: 'g/dL', at: '2026-02-14T08:12:00Z' },
      { marker: 'RET%', value: 1.06, unit: '%', at: '2026-02-14T08:12:00Z' },
      { marker: 'OFF-score', value: 92.4, unit: 'score', at: '2026-02-14T08:12:00Z' },
    ],
  }),
);

describe('AES-256-GCM payload encryption', () => {
  it('round-trips a biological payload', () => {
    const key = randomBytes(32);
    expect(decrypt(encrypt(SAMPLE_PAYLOAD, key), key).equals(SAMPLE_PAYLOAD)).to.equal(true);
  });

  it('rejects a key that is not 256 bits', () => {
    expect(() => encrypt(SAMPLE_PAYLOAD, randomBytes(16))).to.throw(/AES-256/);
  });

  it('fails closed when the ciphertext is tampered with', () => {
    const key = randomBytes(32);
    const env = encrypt(SAMPLE_PAYLOAD, key);
    env.ciphertext[0] ^= 0xff;
    expect(() => decrypt(env, key)).to.throw();
  });

  it('fails closed under the wrong key', () => {
    const env = encrypt(SAMPLE_PAYLOAD, randomBytes(32));
    expect(() => decrypt(env, randomBytes(32))).to.throw();
  });

  it('never reuses a nonce across encryptions', () => {
    const key = randomBytes(32);
    const nonces = new Set(
      Array.from({ length: 500 }, () => encrypt(SAMPLE_PAYLOAD, key).iv.toString('hex')),
    );
    expect(nonces.size).to.equal(500);
  });
});

describe('Shamir 2-of-3 key recovery', () => {
  it('reconstructs the key from any two of the three shares', () => {
    const key = randomBytes(32);
    const shares = splitForRecovery(key);
    expect(shares.map((s) => s.holder)).to.deep.equal([...RECOVERY_HOLDERS]);

    for (const pair of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const recovered = combine([shares[pair[0]], shares[pair[1]]]);
      expect(secretsEqual(recovered, key), `pair ${pair} failed`).to.equal(true);
    }
  });

  it('reconstructs the key from all three shares', () => {
    const key = randomBytes(32);
    expect(secretsEqual(combine(splitForRecovery(key)), key)).to.equal(true);
  });

  it('a single holder cannot reconstruct the key', () => {
    const key = randomBytes(32);
    const shares = splitForRecovery(key);
    for (const share of shares) {
      expect(() => combine([share])).to.throw(/at least two shares/);
      // The share alone must also not equal the secret.
      expect(share.value.equals(key)).to.equal(false);
    }
  });

  it('a single share leaks nothing: it is consistent with every possible secret', () => {
    // Perfect secrecy, stated exactly rather than sampled. Fix any observed
    // share at x=1. For a 1-byte secret at threshold 2 there are 256 candidate
    // values for a second share; if for EVERY secret in GF(256) some second
    // share reconstructs it, then the observed share excludes no secret at all
    // and therefore carries zero information about it.
    const observed = split(Buffer.from([0x5a]), 3, 2)[0];

    const reachable = new Set<number>();
    for (let w = 0; w < 256; w += 1) {
      const candidate = { index: 2, value: Buffer.from([w]) };
      reachable.add(combine([observed, candidate])[0]);
    }
    expect(reachable.size, 'one share narrows the secret space').to.equal(256);
  });

  it('round-trips arbitrary secrets (property-based)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 128 }), (bytes) => {
        const secret = Buffer.from(bytes);
        const shares = split(secret, 3, 2);
        return combine([shares[0], shares[2]]).equals(secret);
      }),
      { numRuns: 500 },
    );
  });

  it('rejects malformed share sets', () => {
    const shares = splitForRecovery(randomBytes(32));
    expect(() => combine([shares[0], shares[0]])).to.throw(/distinct indices/);
    expect(() => split(randomBytes(32), 2, 3)).to.throw(/at least the threshold/);
    expect(() => split(Buffer.alloc(0), 3, 2)).to.throw(/non-empty/);
  });
});

describe('Key vault', () => {
  it('reports a destroyed key distinctly from an unknown one', () => {
    const vault = new KeyVault();
    const { keyRef } = vault.create();
    expect(vault.has(keyRef)).to.equal(true);
    revokeDataAccessKey(vault, keyRef);
    expect(vault.has(keyRef)).to.equal(false);
    expect(vault.wasDestroyed(keyRef)).to.equal(true);
    expect(() => vault.get(keyRef)).to.throw(/GDPR Article 17/);
    expect(() => vault.get('key-does-not-exist')).to.throw(/unknown key reference/);
  });
});

describe('IPFS off-chain storage and GDPR Article 17 erasure', function () {
  this.timeout(60000);
  const cluster = new IpfsCluster();
  const vault = new KeyVault();
  let reachable = false;

  before(async function () {
    reachable = await cluster.isReachable();
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(
        `\n    SKIPPED: no IPFS cluster at ${cluster.nodes.join(', ')}. ` +
          'Run scripts/network-up.sh first.\n',
      );
      this.skip();
    }
  });

  beforeEach(function () {
    if (!reachable) this.skip();
  });

  it('stores only a content identifier and a key reference for the ledger', async () => {
    const { record } = await storeEncrypted(SAMPLE_PAYLOAD, { cluster, vault });
    expect(record.cid).to.be.a('string').with.length.greaterThan(10);
    expect(record.keyRef).to.match(/^key-/);
    // Nothing that would be written on-chain may contain the payload.
    const onChain = JSON.stringify(record);
    expect(onChain).to.not.contain('OFF-score');
    expect(onChain).to.not.contain('abp_haematological');
  });

  it('pins the ciphertext on every node in the cluster', async () => {
    const { record } = await storeEncrypted(SAMPLE_PAYLOAD, { cluster, vault });
    expect(record.pinnedAt).to.have.lengthOf(cluster.nodes.length);
  });

  it('round-trips store -> retrieve -> decrypt', async () => {
    const { record } = await storeEncrypted(SAMPLE_PAYLOAD, { cluster, vault });
    const out = await retrieveDecrypted(record, { cluster, vault });
    expect(out.equals(SAMPLE_PAYLOAD)).to.equal(true);
  });

  it('what IPFS holds is ciphertext, not the payload', async () => {
    const { record } = await storeEncrypted(SAMPLE_PAYLOAD, { cluster, vault });
    const raw = await cluster.cat(record.cid);
    expect(raw.equals(SAMPLE_PAYLOAD)).to.equal(false);
    expect(raw.toString('utf8')).to.not.contain('OFF-score');
  });

  it('after destroyIPFSAccessToken the payload is unrecoverable', async () => {
    const { record } = await storeEncrypted(SAMPLE_PAYLOAD, { cluster, vault });
    const certificate = await destroyIPFSAccessToken(record, vault, cluster);

    expect(certificate.keyDestroyed).to.equal(true);
    expect(certificate.unpinResults).to.have.lengthOf(cluster.nodes.length);
    expect(certificate.legalCaveat).to.contain('not confirmed by supervisory authorities');

    let error: Error | undefined;
    try {
      await retrieveDecrypted(record, { cluster, vault });
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'retrieval succeeded after erasure').to.exist;
    expect(error!.message).to.contain('GDPR Article 17');
  });

  it('erasure is irreversible without the recovery shares', async () => {
    const { record } = await storeEncrypted(SAMPLE_PAYLOAD, { cluster, vault });
    const key = vault.exportForSharing(record.keyRef);
    const shares = splitForRecovery(key);
    await destroyIPFSAccessToken(record, vault, cluster);
    expect(() => vault.get(record.keyRef)).to.throw(/destroyed/);

    // Two of three shares restore access; this is the §6 recovery path.
    recoverDataAccessKey(vault, record.keyRef, [shares[0], shares[2]]);
    expect(vault.get(record.keyRef).equals(key)).to.equal(true);
  });

  it('a single share cannot restore access after erasure', async () => {
    const { record } = await storeEncrypted(SAMPLE_PAYLOAD, { cluster, vault });
    const shares = splitForRecovery(vault.exportForSharing(record.keyRef));
    await destroyIPFSAccessToken(record, vault, cluster);
    expect(() => recoverDataAccessKey(vault, record.keyRef, [shares[1]])).to.throw(
      /at least two of the three shares/,
    );
    expect(vault.wasDestroyed(record.keyRef)).to.equal(true);
  });

  it('a ledger record alone is not enough to read the payload', async () => {
    const { record } = await storeEncrypted(SAMPLE_PAYLOAD, { cluster, vault });
    // An attacker holding the full on-chain record but not the vault key.
    const attackerVault = new KeyVault();
    const stolen: StoredPayload = JSON.parse(JSON.stringify(record));
    let error: Error | undefined;
    try {
      await retrieveDecrypted(stolen, { cluster, vault: attackerVault });
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'ledger record alone granted access').to.exist;
  });
});
