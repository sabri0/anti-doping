/**
 * GDPR Article 17 cryptographic erasure.
 *
 * Implements the manuscript's `revokeDataAccessKey()` and
 * `destroyIPFSAccessToken()`: the data-encryption key is overwritten and
 * discarded, and the content identifier is unpinned across every IPFS node.
 * The ledger is never rewritten — only the key disappears, which is what makes
 * the scheme compatible with an append-only ledger.
 *
 * HONEST LIMITATION, carried over from the manuscript unchanged: rendering
 * data cryptographically inaccessible has not been confirmed by supervisory
 * authorities to constitute erasure within the meaning of Article 17. This
 * module demonstrates the mechanism; it does not resolve the legal question.
 */

import { IpfsCluster, KeyVault, StoredPayload } from './ipfs-client';
import { Share, combine } from './shamir';

export interface ErasureCertificate {
  cid: string;
  keyRef: string;
  keyDestroyed: boolean;
  unpinResults: { endpoint: string; unpinned: boolean }[];
  /** True only when the key is gone AND no node still pins the content. */
  complete: boolean;
  erasedAt: string;
  legalCaveat: string;
}

const LEGAL_CAVEAT =
  'Cryptographic inaccessibility is not confirmed by supervisory authorities as ' +
  'erasure within the meaning of GDPR Article 17. The mechanism is demonstrated; ' +
  'the legal question remains open.';

/**
 * `revokeDataAccessKey()` — destroy the key alone.
 *
 * Sufficient on its own for inaccessibility: the ciphertext may remain pinned,
 * but without the key it is indistinguishable from random data.
 */
export function revokeDataAccessKey(vault: KeyVault, keyRef: string): boolean {
  return vault.destroy(keyRef);
}

/**
 * `destroyIPFSAccessToken()` — full Article 17 erasure.
 *
 * Destroys the key and unpins the content identifier across the whole cluster,
 * then garbage-collects. Returns a certificate suitable for the audit trail.
 */
export async function destroyIPFSAccessToken(
  record: StoredPayload,
  vault: KeyVault,
  cluster: IpfsCluster,
): Promise<ErasureCertificate> {
  const keyDestroyed = revokeDataAccessKey(vault, record.keyRef);
  const unpinResults = await cluster.unpinEverywhere(record.cid);

  return {
    cid: record.cid,
    keyRef: record.keyRef,
    keyDestroyed,
    unpinResults,
    complete: keyDestroyed && unpinResults.every((r) => r.unpinned),
    erasedAt: new Date().toISOString(),
    legalCaveat: LEGAL_CAVEAT,
  };
}

/**
 * Recover a destroyed key from Shamir shares (§6: any two of athlete,
 * physician, federation official). This is the counterpart to erasure: it
 * exists so that key loss is not irreversible for the athlete themselves,
 * while remaining impossible for any single holder acting alone.
 */
export function recoverDataAccessKey(
  vault: KeyVault,
  keyRef: string,
  shares: Share[],
): Buffer {
  if (shares.length < 2) {
    throw new Error('key recovery requires at least two of the three shares');
  }
  const key = combine(shares);
  vault.restore(keyRef, key);
  return key;
}
