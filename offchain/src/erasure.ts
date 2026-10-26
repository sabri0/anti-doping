/**
 * Key revocation, key recovery and GDPR Article 17 erasure.
 *
 * Two operations that an earlier draft conflated are kept apart here.
 *
 *   Revocation destroys the working copy of the data-encryption key. Access
 *   stops, but the key can be reconstructed from the recovery shares, so
 *   revocation is reversible by design and is not erasure.
 *
 *   Erasure destroys the working copy AND every recovery share, then unpins
 *   the ciphertext from every node of the private IPFS cluster and garbage-
 *   collects it. Nothing remains from which the key could be rebuilt, which is
 *   what makes erasure irreversible.
 *
 * Share destruction is attested by each holder, not proven: a holder who kept
 * a copy of a share before destroying it cannot be detected by any protocol.
 * Erasure also cannot reach plaintext held outside the network — by the
 * laboratory that produced the result, or by a recipient who decrypted it
 * after an authorised release. The consent chaincode records an Article 17(2)
 * notice to every such recipient.
 *
 * Rendering data cryptographically inaccessible has not been confirmed by
 * supervisory authorities to constitute erasure within the meaning of
 * Article 17. This module demonstrates the mechanism; it does not resolve the
 * legal question.
 */

import { IpfsCluster, KeyVault, StoredPayload } from './ipfs-client';
import { RECOVERY_HOLDERS, RECOVERY_THRESHOLD, RecoveryHolder, Share, combine } from './shamir';

export interface ErasureCertificate {
  cid: string;
  keyRef: string;
  keyDestroyed: boolean;
  /** Holders who attested destruction of every share they held. */
  sharesDestroyed: RecoveryHolder[];
  unpinResults: { endpoint: string; unpinned: boolean }[];
  /** True only when the key and every share are gone AND no node still pins the content. */
  complete: boolean;
  erasedAt: string;
  legalCaveat: string;
}

const LEGAL_CAVEAT =
  'Cryptographic inaccessibility is not confirmed by supervisory authorities as ' +
  'erasure within the meaning of GDPR Article 17. The mechanism is demonstrated; ' +
  'the legal question remains open.';

/**
 * The recovery shares as their holders keep them. In deployment each holder's
 * shares live on that holder's own device; the prototype keeps them in one
 * process so that a scenario can play every holder.
 */
export class ShareCustody {
  private shares = new Map<RecoveryHolder, Share[]>();

  deposit(shares: Share[]): void {
    for (const share of shares) {
      const holder = share.holder as RecoveryHolder;
      this.shares.set(holder, [...(this.shares.get(holder) ?? []), share]);
    }
  }

  /** The shares a holder produces when asked to take part in recovery. */
  produce(holder: RecoveryHolder): Share[] {
    return (this.shares.get(holder) ?? []).map((s) => ({ ...s, value: Buffer.from(s.value) }));
  }

  /** Overwrite and discard a holder's shares, returning that holder's attestation. */
  destroy(holder: RecoveryHolder): boolean {
    const held = this.shares.get(holder);
    if (!held) return false;
    for (const s of held) s.value.fill(0);
    this.shares.delete(holder);
    return true;
  }

  holders(): RecoveryHolder[] {
    return [...this.shares.keys()];
  }
}

/** Revoke the working copy of the key. Reversible from the recovery shares; not erasure. */
export function revokeDataAccessKey(vault: KeyVault, keyRef: string): boolean {
  return vault.destroy(keyRef);
}

/**
 * Article 17 erasure: destroy the key and every recovery share, unpin the
 * ciphertext across the cluster and garbage-collect it. Returns the
 * certificate the consent chaincode requires before it records the erasure.
 */
export async function destroyIPFSAccessToken(
  record: StoredPayload,
  vault: KeyVault,
  cluster: IpfsCluster,
  custody?: ShareCustody,
): Promise<ErasureCertificate> {
  const keyDestroyed = vault.destroy(record.keyRef) || vault.wasDestroyed(record.keyRef);
  const sharesDestroyed: RecoveryHolder[] = [];
  for (const holder of RECOVERY_HOLDERS) {
    if (!custody || custody.destroy(holder)) sharesDestroyed.push(holder);
  }
  const unpinResults = await cluster.unpinEverywhere(record.cid);

  return {
    cid: record.cid,
    keyRef: record.keyRef,
    keyDestroyed,
    sharesDestroyed,
    unpinResults,
    complete:
      keyDestroyed &&
      sharesDestroyed.length === RECOVERY_HOLDERS.length &&
      unpinResults.every((r) => r.unpinned),
    erasedAt: new Date().toISOString(),
    legalCaveat: LEGAL_CAVEAT,
  };
}

/**
 * Rebuild a revoked key from recovery shares. Fewer shares than the threshold
 * are refused outright: Lagrange interpolation through too few points returns
 * a wrong key rather than an error, and a wrong key would fail only later, at
 * decryption, with a less useful message.
 */
export function recoverDataAccessKey(vault: KeyVault, keyRef: string, shares: Share[]): Buffer {
  const distinct = new Set(shares.map((s) => s.index));
  if (distinct.size < RECOVERY_THRESHOLD) {
    throw new Error(
      `key recovery requires at least ${RECOVERY_THRESHOLD} shares; ${distinct.size} supplied. ` +
        'The athlete holds two, so recovery needs the athlete and one custodian',
    );
  }
  const key = combine(shares);
  vault.restore(keyRef, key);
  return key;
}
