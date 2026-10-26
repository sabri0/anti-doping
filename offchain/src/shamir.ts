/**
 * Shamir secret sharing over GF(2^8), used to recover an athlete's
 * data-encryption key after the working copy has been revoked.
 *
 * The access structure is "the athlete AND (the physician OR the federation
 * official)", realised as a weighted threshold scheme: four shares, threshold
 * three, of which the athlete holds two. The athlete plus either custodian
 * reaches the threshold; the two custodians together hold two shares and do
 * not, so no institutional pair can reconstruct the key without the athlete.
 * A plain two-of-three split among the same three holders would have let the
 * physician and the federation official do exactly that.
 *
 * Each byte of the secret is shared independently: for a threshold t, a random
 * polynomial of degree t-1 is drawn with the secret byte as constant term, and
 * shares are evaluations of that polynomial at distinct non-zero x values.
 * Recovery is Lagrange interpolation at x = 0.
 *
 * Fewer than t shares yield no information about the secret: for any candidate
 * secret there exists a polynomial consistent with the shares held.
 */

import { randomBytes, timingSafeEqual } from 'crypto';

// GF(2^8) with the AES reduction polynomial x^8 + x^4 + x^3 + x + 1 (0x11b).
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    // Multiply by the generator 0x03.
    let next = x ^ ((x << 1) & 0xff);
    if (x & 0x80) next ^= 0x1b;
    x = next;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const gfAdd = (a: number, b: number): number => a ^ b;

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero in GF(2^8)');
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

export interface Share {
  /** Non-zero x coordinate identifying this share. */
  index: number;
  /** Share bytes, one per secret byte. */
  value: Buffer;
  /** Holder role, recorded for audit; not used in reconstruction. */
  holder?: string;
}

/** Split `secret` into `shares` pieces, any `threshold` of which recover it. */
export function split(secret: Buffer, shares: number, threshold: number): Share[] {
  if (threshold < 2) throw new Error('threshold must be at least 2');
  if (shares < threshold) throw new Error('shares must be at least the threshold');
  if (shares > 255) throw new Error('at most 255 shares are representable in GF(2^8)');
  if (secret.length === 0) throw new Error('secret must be non-empty');

  const out: Share[] = [];
  for (let i = 1; i <= shares; i += 1) {
    out.push({ index: i, value: Buffer.alloc(secret.length) });
  }

  for (let byte = 0; byte < secret.length; byte += 1) {
    // Random polynomial coefficients a_1..a_{t-1}; a_0 is the secret byte.
    const coeffs = randomBytes(threshold - 1);
    for (const share of out) {
      let acc = secret[byte];
      let xPow = 1;
      for (let d = 0; d < threshold - 1; d += 1) {
        xPow = gfMul(xPow, share.index);
        acc = gfAdd(acc, gfMul(coeffs[d], xPow));
      }
      share.value[byte] = acc;
    }
  }
  return out;
}

/** Recover the secret by Lagrange interpolation at x = 0. */
export function combine(shares: Share[]): Buffer {
  if (shares.length < 2) throw new Error('at least two shares are required');
  const indices = shares.map((s) => s.index);
  if (new Set(indices).size !== indices.length) {
    throw new Error('shares must have distinct indices');
  }
  if (indices.some((i) => i === 0)) {
    throw new Error('share index 0 is reserved for the secret itself');
  }
  const length = shares[0].value.length;
  if (shares.some((s) => s.value.length !== length)) {
    throw new Error('shares have inconsistent lengths');
  }

  const secret = Buffer.alloc(length);
  for (let byte = 0; byte < length; byte += 1) {
    let acc = 0;
    for (let i = 0; i < shares.length; i += 1) {
      let numerator = 1;
      let denominator = 1;
      for (let j = 0; j < shares.length; j += 1) {
        if (i === j) continue;
        numerator = gfMul(numerator, shares[j].index);
        denominator = gfMul(denominator, gfAdd(shares[i].index, shares[j].index));
      }
      acc = gfAdd(acc, gfMul(shares[i].value[byte], gfDiv(numerator, denominator)));
    }
    secret[byte] = acc;
  }
  return secret;
}

/** The three holders of recovery shares. */
export const RECOVERY_HOLDERS = ['athlete', 'physician', 'federation-official'] as const;
export type RecoveryHolder = (typeof RECOVERY_HOLDERS)[number];

/** Shares per holder. The athlete's weight is what makes the athlete necessary. */
export const SHARE_ALLOCATION: Record<RecoveryHolder, number> = {
  athlete: 2,
  physician: 1,
  'federation-official': 1,
};
export const RECOVERY_THRESHOLD = 3;

/** Split a key into the four weighted recovery shares, labelled by holder. */
export function splitForRecovery(key: Buffer): Share[] {
  const holders = RECOVERY_HOLDERS.flatMap((h) => Array<RecoveryHolder>(SHARE_ALLOCATION[h]).fill(h));
  return split(key, holders.length, RECOVERY_THRESHOLD).map((s, i) => ({ ...s, holder: holders[i] }));
}

/** Whether a set of holders, pooling their shares, reaches the recovery threshold. */
export function holdersCanRecover(holders: RecoveryHolder[]): boolean {
  return [...new Set(holders)].reduce((n, h) => n + SHARE_ALLOCATION[h], 0) >= RECOVERY_THRESHOLD;
}

/** Constant-time equality, so recovery checks do not leak by timing. */
export function secretsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
