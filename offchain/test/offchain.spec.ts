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
import {
  ShareCustody,
  destroyIPFSAccessToken,
  recoverDataAccessKey,
  revokeDataAccessKey,
} from '../src/erasure';
import {
  RECOVERY_THRESHOLD,
  combine,
  holdersCanRecover,
  secretsEqual,
  split,
  splitForRecovery,
} from '../src/shamir';
import { PseudonymisationService, pseudonymise } from '../src/pseudonym';
import { commit } from '../src/ipfs-client';

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

describe('Athlete-mandatory key recovery (weighted Shamir, 3 of 4)', () => {
  const byHolder = (shares: ReturnType<typeof splitForRecovery>, ...holders: string[]) =>
    shares.filter((s) => holders.includes(s.holder!));

  it('allocates two shares to the athlete and one to each custodian', () => {
    const holders = splitForRecovery(randomBytes(32)).map((s) => s.holder);
    expect(holders).to.deep.equal(['athlete', 'athlete', 'physician', 'federation-official']);
  });

  it('the athlete with either custodian reconstructs the key', () => {
    const key = randomBytes(32);
    const shares = splitForRecovery(key);
    for (const custodian of ['physician', 'federation-official']) {
      expect(secretsEqual(combine(byHolder(shares, 'athlete', custodian)), key), custodian).to.equal(true);
    }
  });

  it('the two custodians together cannot reconstruct the key without the athlete', () => {
    const key = randomBytes(32);
    const shares = splitForRecovery(key);
    const institutional = byHolder(shares, 'physician', 'federation-official');
    expect(institutional).to.have.lengthOf(2);
    expect(holdersCanRecover(['physician', 'federation-official'])).to.equal(false);
    // Interpolating through too few points yields a wrong key, not an error.
    expect(secretsEqual(combine(institutional), key)).to.equal(false);
    expect(() => recoverDataAccessKey(new KeyVault(), 'k', institutional)).to.throw(/at least 3 shares/);
  });

  it('the athlete alone, or any single custodian, cannot reconstruct the key', () => {
    expect(holdersCanRecover(['athlete'])).to.equal(false);
    expect(holdersCanRecover(['physician'])).to.equal(false);
    expect(holdersCanRecover(['athlete', 'physician'])).to.equal(true);
    expect(RECOVERY_THRESHOLD).to.equal(3);
  });

  it('fewer shares than the threshold leak nothing: they are consistent with every secret', () => {
    // Fix two observed shares of a threshold-3 split of a one-byte secret. If
    // for every secret in GF(256) some third share reconstructs it, the two
    // observed shares exclude no secret and carry no information about it.
    const [a, b] = split(Buffer.from([0x5a]), 4, 3);
    const reachable = new Set<number>();
    for (let w = 0; w < 256; w += 1) {
      reachable.add(combine([a, b, { index: 3, value: Buffer.from([w]) }])[0]);
    }
    expect(reachable.size, 'two shares narrow the secret space').to.equal(256);
  });

  it('round-trips arbitrary secrets (property-based)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 128 }), (bytes) => {
        const secret = Buffer.from(bytes);
        const shares = split(secret, 4, 3);
        return combine([shares[0], shares[1], shares[3]]).equals(secret);
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

describe('Keyed pseudonyms and commitments', () => {
  it('a pseudonym is keyed: without the key, enumerating identifiers does not reverse it', () => {
    const service = new PseudonymisationService();
    const target = service.pseudonym('ADAMS-0004217');
    // The attack an unkeyed hash invites: hash every candidate identifier.
    const guesses = Array.from({ length: 5000 }, (_, i) => `ADAMS-${String(i).padStart(7, '0')}`);
    const attackerKey = randomBytes(32);
    expect(guesses.some((g) => pseudonymise(g, attackerKey) === target)).to.equal(false);
    // The service itself maps the identifier stably.
    expect(service.pseudonym('ADAMS-0004217')).to.equal(target);
    expect(target).to.match(/^[0-9a-f]{64}$/);
  });

  it('domains separate pseudonyms, so datasets cannot be joined on them', () => {
    const service = new PseudonymisationService();
    expect(service.pseudonym('ADAMS-1', 'antidoping/custody')).to.not.equal(
      service.pseudonym('ADAMS-1', 'research/export'),
    );
  });

  it('a payload commitment depends on the key, so a guessed payload cannot be confirmed without it', () => {
    const key = randomBytes(32);
    expect(commit(SAMPLE_PAYLOAD, key)).to.not.equal(commit(SAMPLE_PAYLOAD, randomBytes(32)));
    expect(commit(SAMPLE_PAYLOAD, key)).to.equal(commit(SAMPLE_PAYLOAD, key));
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
    expect(record.commitment).to.match(/^[0-9a-f]{64}$/);
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

  it('revocation is reversible: the athlete and one custodian restore access', async () => {
    const { record } = await storeEncrypted(SAMPLE_PAYLOAD, { cluster, vault });
    const custody = new ShareCustody();
    custody.deposit(splitForRecovery(vault.exportForSharing(record.keyRef)));
    revokeDataAccessKey(vault, record.keyRef);
    expect(() => vault.get(record.keyRef)).to.throw(/destroyed/);

    expect(() =>
      recoverDataAccessKey(vault, record.keyRef, [
        ...custody.produce('physician'),
        ...custody.produce('federation-official'),
      ]),
    ).to.throw(/at least 3 shares/);
    recoverDataAccessKey(vault, record.keyRef, [...custody.produce('athlete'), ...custody.produce('physician')]);
    expect((await retrieveDecrypted(record, { cluster, vault })).equals(SAMPLE_PAYLOAD)).to.equal(true);
  });

  it('erasure destroys the key and every share and unpins everywhere: nothing can restore access', async () => {
    const { record } = await storeEncrypted(SAMPLE_PAYLOAD, { cluster, vault });
    const custody = new ShareCustody();
    custody.deposit(splitForRecovery(vault.exportForSharing(record.keyRef)));
    const certificate = await destroyIPFSAccessToken(record, vault, cluster, custody);

    expect(certificate.keyDestroyed).to.equal(true);
    expect(certificate.sharesDestroyed).to.have.members(['athlete', 'physician', 'federation-official']);
    expect(certificate.unpinResults).to.have.lengthOf(cluster.nodes.length);
    expect(certificate.complete).to.equal(true);
    expect(certificate.legalCaveat).to.contain('not confirmed by supervisory authorities');
    expect(custody.holders()).to.be.empty;
    expect(await cluster.isRetrievableLocally(record.cid)).to.equal(false);

    let error: Error | undefined;
    try {
      await retrieveDecrypted(record, { cluster, vault });
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'retrieval succeeded after erasure').to.exist;
    expect(() => recoverDataAccessKey(vault, record.keyRef, custody.produce('athlete'))).to.throw(
      /at least 3 shares/,
    );
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
