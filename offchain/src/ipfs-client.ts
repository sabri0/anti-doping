/**
 * Off-chain biological data storage.
 *
 * §3.5 and §4.3 of the manuscript require that biological payloads never touch
 * the ledger: the payload is encrypted with AES-256, added to IPFS, and only
 * the content identifier plus a key reference are written on-chain.
 *
 * AES-256-GCM is used rather than CBC so that ciphertext integrity is
 * authenticated: a tampered payload fails to decrypt rather than yielding
 * plausible garbage.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';

export const KEY_BYTES = 32; // AES-256
export const IV_BYTES = 12; // GCM standard nonce length

/** Kubo HTTP API endpoints; every node receives a pinned copy. */
export function defaultEndpoints(): string[] {
  return (
    process.env.IPFS_ENDPOINTS ??
    'http://127.0.0.1:5011,http://127.0.0.1:5012,http://127.0.0.1:5013'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface EncryptedEnvelope {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export interface StoredPayload {
  /** IPFS content identifier of the ciphertext. */
  cid: string;
  /** Opaque handle to the data-encryption key; the key itself stays in the vault. */
  keyRef: string;
  iv: string;
  authTag: string;
  /**
   * Keyed commitment to the plaintext: HMAC-SHA-256 under a key derived from
   * the data-encryption key. An unkeyed digest of a low-entropy payload could
   * be confirmed by anyone able to guess the payload; this cannot, and it
   * becomes unverifiable when the data-encryption key is destroyed.
   */
  commitment: string;
  sizeBytes: number;
  /** Endpoints that hold a pinned copy — erasure must reach all of them. */
  pinnedAt: string[];
}

export function encrypt(plaintext: Buffer, key: Buffer): EncryptedEnvelope {
  if (key.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes (AES-256)`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** HMAC-SHA-256 commitment to `plaintext` under a subkey of the data-encryption key. */
export function commit(plaintext: Buffer, key: Buffer): string {
  const subkey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'antidoping/payload-commitment', 32));
  return createHmac('sha256', subkey).update(plaintext).digest('hex');
}

export function decrypt(envelope: EncryptedEnvelope, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.iv);
  decipher.setAuthTag(envelope.authTag);
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
}

/**
 * Key custody.
 *
 * Operated by the athlete organisation, whose key service releases a key only
 * against a committed access decision granting that category. In the
 * prototype the vault is an object in the memory of that service's process
 * and keys are destroyed by overwriting before release; a deployment would
 * hold them in a hardware security module operated by the athlete
 * organisation. The manuscript states this as a limitation.
 * What the prototype does demonstrate is the erasure *mechanism*: once the key
 * is destroyed, the ciphertext is unrecoverable regardless of who holds it.
 */
export class KeyVault {
  private keys = new Map<string, Buffer>();
  private destroyed = new Set<string>();

  /**
   * Mint a key. Only the reference is returned: the vault owns the sole copy
   * of the key material, so `destroy` genuinely destroys it. Handing the
   * buffer out would mean `destroy` wipes a buffer the caller still holds a
   * reference to, corrupting the caller's data while leaving stray copies of
   * the key alive elsewhere.
   */
  create(): { keyRef: string } {
    const keyRef = `key-${randomUUID()}`;
    this.keys.set(keyRef, randomBytes(KEY_BYTES));
    return { keyRef };
  }

  /**
   * The only sanctioned route for key material to leave the vault: producing
   * Shamir recovery shares (§6). Returns a copy, so the vault's own buffer
   * remains the single authoritative one.
   */
  exportForSharing(keyRef: string): Buffer {
    return Buffer.from(this.get(keyRef));
  }

  get(keyRef: string): Buffer {
    const key = this.keys.get(keyRef);
    if (!key) {
      throw new Error(
        this.destroyed.has(keyRef)
          ? `key ${keyRef} was destroyed (revoked, or erased under GDPR Article 17); only the recovery shares can rebuild it`
          : `unknown key reference ${keyRef}`,
      );
    }
    return key;
  }

  has(keyRef: string): boolean {
    return this.keys.has(keyRef);
  }

  wasDestroyed(keyRef: string): boolean {
    return this.destroyed.has(keyRef);
  }

  /** Overwrite the key material in place, then drop the reference. */
  destroy(keyRef: string): boolean {
    const key = this.keys.get(keyRef);
    if (!key) return false;
    key.fill(0);
    this.keys.delete(keyRef);
    this.destroyed.add(keyRef);
    return true;
  }

  /** Restore a key recovered from Shamir shares (§6 recovery path). */
  restore(keyRef: string, key: Buffer): void {
    if (key.length !== KEY_BYTES) throw new Error('recovered key has the wrong length');
    this.keys.set(keyRef, key);
    this.destroyed.delete(keyRef);
  }
}

export class IpfsCluster {
  constructor(private endpoints: string[] = defaultEndpoints()) {
    if (this.endpoints.length === 0) throw new Error('no IPFS endpoints configured');
  }

  get nodes(): string[] {
    return [...this.endpoints];
  }

  /**
   * Every call is bounded. Kubo blocks indefinitely on content it does not
   * hold locally, so an unbounded request can hang the caller forever.
   */
  private async post(
    endpoint: string,
    path: string,
    body?: BodyInit,
    timeoutMs = 15000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${endpoint}/api/v0/${path}`, {
        method: 'POST',
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`IPFS ${path} at ${endpoint} failed: ${res.status} ${await res.text()}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.post(this.endpoints[0], 'id', undefined, 5000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Add the ciphertext directly to every node in the cluster.
   *
   * The obvious alternative — add once, then `pin/add` elsewhere — makes the
   * other nodes fetch the block over the DHT, which blocks indefinitely in a
   * private deployment and, worse, would require the cluster to be attached to
   * the public network. Athlete ciphertext must never be announced publicly,
   * so the nodes run with no bootstrap peers and each receives the bytes
   * directly. Content addressing guarantees the CID is identical everywhere,
   * which is asserted rather than assumed.
   */
  async add(data: Buffer): Promise<{ cid: string; pinnedAt: string[] }> {
    const cids: string[] = [];
    const pinnedAt: string[] = [];

    for (const endpoint of this.endpoints) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(data)]), 'payload.bin');
      const res = await this.post(endpoint, 'add?pin=true&cid-version=1', form);
      const { Hash } = (await res.json()) as { Hash: string };
      cids.push(Hash);
      pinnedAt.push(endpoint);
    }

    const unique = new Set(cids);
    if (unique.size !== 1) {
      throw new Error(`IPFS nodes disagreed on the content identifier: ${[...unique].join(', ')}`);
    }
    return { cid: cids[0], pinnedAt };
  }

  async cat(cid: string, timeoutMs = 10000): Promise<Buffer> {
    const res = await this.post(this.endpoints[0], `cat?arg=${cid}`, undefined, timeoutMs);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Whether any node still serves the content, checked locally only. */
  async isRetrievableLocally(cid: string): Promise<boolean> {
    for (const endpoint of this.endpoints) {
      try {
        await this.post(endpoint, `block/stat?arg=${cid}&offline=true`, undefined, 5000);
        return true;
      } catch {
        // this node no longer holds the block
      }
    }
    return false;
  }

  /** Unpin across every node and run garbage collection. */
  async unpinEverywhere(cid: string): Promise<{ endpoint: string; unpinned: boolean }[]> {
    const results: { endpoint: string; unpinned: boolean }[] = [];
    for (const endpoint of this.endpoints) {
      let unpinned = false;
      try {
        await this.post(endpoint, `pin/rm?arg=${cid}&recursive=true`);
        unpinned = true;
      } catch {
        unpinned = false; // already unpinned, or the node never held it
      }
      try {
        await this.post(endpoint, 'repo/gc');
      } catch {
        // GC failure does not affect cryptographic inaccessibility.
      }
      results.push({ endpoint, unpinned });
    }
    return results;
  }
}

export interface StoreOptions {
  cluster: IpfsCluster;
  vault: KeyVault;
}

/** Encrypt, store off-chain, and return exactly what belongs on the ledger. */
export async function storeEncrypted(
  plaintext: Buffer,
  { cluster, vault }: StoreOptions,
): Promise<{ record: StoredPayload }> {
  const { keyRef } = vault.create();
  const envelope = encrypt(plaintext, vault.get(keyRef));
  const { cid, pinnedAt } = await cluster.add(envelope.ciphertext);

  return {
    record: {
      cid,
      keyRef,
      iv: envelope.iv.toString('base64'),
      authTag: envelope.authTag.toString('base64'),
      commitment: commit(plaintext, vault.get(keyRef)),
      sizeBytes: envelope.ciphertext.length,
      pinnedAt,
    },
  };
}

/** Retrieve and decrypt. Throws if the key was destroyed under Article 17. */
export async function retrieveDecrypted(
  record: StoredPayload,
  { cluster, vault }: StoreOptions,
): Promise<Buffer> {
  const key = vault.get(record.keyRef); // throws once destroyed
  const ciphertext = await cluster.cat(record.cid);
  const plaintext = decrypt(
    {
      ciphertext,
      iv: Buffer.from(record.iv, 'base64'),
      authTag: Buffer.from(record.authTag, 'base64'),
    },
    key,
  );
  const expected = Buffer.from(record.commitment, 'hex');
  const actual = Buffer.from(commit(plaintext, key), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('integrity check failed: plaintext does not match the commitment on the ledger');
  }
  return plaintext;
}
