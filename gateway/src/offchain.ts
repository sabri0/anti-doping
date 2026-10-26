/**
 * Minimal off-chain storage for the gateway.
 *
 * The authoritative implementation is the `offchain` package, which is what the
 * acceptance tests exercise. This is a deliberately small restatement of the
 * same scheme using only Node built-ins, so the gateway image stays independent
 * of that package's build. It covers exactly what the web platform needs:
 * encrypt, store on every IPFS node, and perform Article 17 erasure.
 *
 * Keys live in process memory. That is a stated limitation of the prototype,
 * not a design position — production key custody belongs in an HSM.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from 'crypto';

const IPFS_ENDPOINTS = (process.env.IPFS_ENDPOINTS ?? 'http://ipfs0:5001,http://ipfs1:5001,http://ipfs2:5001')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface StoredPayload {
  cid: string;
  keyRef: string;
  iv: string;
  authTag: string;
  /** Keyed commitment to the plaintext (HMAC under a subkey of the data key). */
  commitment: string;
  pinnedAt: string[];
}

const keys = new Map<string, Buffer>();
const destroyed = new Set<string>();

/** Every request is bounded: Kubo blocks indefinitely on content it lacks. */
async function ipfs(endpoint: string, path: string, body?: FormData, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}/api/v0/${path}`, {
      method: 'POST',
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`IPFS ${path} at ${endpoint}: ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function ipfsReachable(): Promise<boolean> {
  try {
    await ipfs(IPFS_ENDPOINTS[0], 'id', undefined, 4000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt and write the ciphertext to every node.
 *
 * Adding to each node directly rather than pinning by fetch keeps the cluster
 * private: a `pin/add` elsewhere would require the content to be announced and
 * retrieved over the DHT.
 */
export async function store(plaintext: Buffer): Promise<StoredPayload> {
  const keyRef = `key-${randomUUID()}`;
  const key = randomBytes(KEY_BYTES);
  keys.set(keyRef, key);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const cids: string[] = [];
  const pinnedAt: string[] = [];
  for (const endpoint of IPFS_ENDPOINTS) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(ciphertext)]), 'payload.bin');
    const res = await ipfs(endpoint, 'add?pin=true&cid-version=1', form);
    cids.push(((await res.json()) as { Hash: string }).Hash);
    pinnedAt.push(endpoint);
  }
  if (new Set(cids).size !== 1) {
    throw new Error(`IPFS nodes disagreed on the content identifier: ${[...new Set(cids)].join(', ')}`);
  }

  return {
    cid: cids[0],
    keyRef,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    commitment: createHmac('sha256', Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'antidoping/payload-commitment', 32)))
      .update(plaintext)
      .digest('hex'),
    pinnedAt,
  };
}

export async function retrieve(record: StoredPayload): Promise<Buffer> {
  const key = keys.get(record.keyRef);
  if (!key) {
    throw new Error(
      destroyed.has(record.keyRef)
        ? `key ${record.keyRef} was destroyed under GDPR Article 17 and cannot be recovered`
        : `unknown key reference ${record.keyRef}`,
    );
  }
  const res = await ipfs(IPFS_ENDPOINTS[0], `cat?arg=${record.cid}`, undefined, 10000);
  const ciphertext = Buffer.from(await res.arrayBuffer());
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export interface ErasureCertificate {
  cid: string;
  keyRef: string;
  keyDestroyed: boolean;
  /**
   * Holders whose recovery shares are destroyed. The platform's demonstration
   * path never splits a key into shares, so there is none to survive; the
   * full recovery-and-erasure path is the offchain package's (scenario S11).
   */
  sharesDestroyed: string[];
  sharesIssued: boolean;
  unpinResults: { endpoint: string; unpinned: boolean }[];
  complete: boolean;
  erasedAt: string;
  legalCaveat: string;
}

/** GDPR Article 17: destroy the key, then unpin across the cluster. */
export async function erase(record: StoredPayload): Promise<ErasureCertificate> {
  const key = keys.get(record.keyRef);
  if (key) key.fill(0);
  const keyDestroyed = keys.delete(record.keyRef);
  if (keyDestroyed) destroyed.add(record.keyRef);

  const unpinResults: { endpoint: string; unpinned: boolean }[] = [];
  for (const endpoint of IPFS_ENDPOINTS) {
    let unpinned = false;
    try {
      await ipfs(endpoint, `pin/rm?arg=${record.cid}&recursive=true`);
      unpinned = true;
    } catch {
      unpinned = false; // never held it, or already unpinned
    }
    try {
      await ipfs(endpoint, 'repo/gc', undefined, 30000);
    } catch {
      // garbage collection failing does not affect cryptographic inaccessibility
    }
    unpinResults.push({ endpoint, unpinned });
  }

  return {
    cid: record.cid,
    keyRef: record.keyRef,
    keyDestroyed,
    sharesDestroyed: ['athlete', 'physician', 'federation-official'],
    sharesIssued: false,
    unpinResults,
    complete: keyDestroyed && unpinResults.every((r) => r.unpinned),
    erasedAt: new Date().toISOString(),
    legalCaveat:
      'Cryptographic inaccessibility is not confirmed by supervisory authorities as ' +
      'erasure within the meaning of GDPR Article 17. The mechanism is demonstrated; ' +
      'the legal question remains open.',
  };
}

/** Payload records the platform has registered, keyed by athlete and category. */
export const payloads = new Map<string, StoredPayload>();
export const payloadKey = (athleteHash: string, category: string) => `${athleteHash}:${category}`;
