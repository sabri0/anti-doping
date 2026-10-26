/**
 * Athlete pseudonymisation.
 *
 * The ledger identifies an athlete only by a pseudonym. An unkeyed hash of the
 * athlete's identifier would not do: an ADAMS identifier or a licence number
 * has a small enough space that hashing every candidate and comparing takes
 * seconds, so anyone holding the ledger could reverse it. The pseudonym is
 * therefore HMAC-SHA-256 under a secret key held by the athlete organisation's
 * pseudonymisation service, and is reversible only by that service (GDPR
 * Article 4(5): the additional information is kept separately).
 *
 * A domain label separates pseudonyms used for different purposes, so that
 * the custody ledger and, say, a research export cannot be joined on the
 * pseudonym alone.
 */

import { createHmac, randomBytes } from 'crypto';

export const PSEUDONYM_KEY_BYTES = 32;

export function pseudonymise(identifier: string, key: Buffer, domain = 'antidoping/custody'): string {
  if (key.length < PSEUDONYM_KEY_BYTES) {
    throw new Error(`pseudonymisation key must be at least ${PSEUDONYM_KEY_BYTES} bytes`);
  }
  return createHmac('sha256', key).update(`${domain}\u0000${identifier}`).digest('hex');
}

/** The athlete organisation's pseudonymisation service. The key never leaves it. */
export class PseudonymisationService {
  private readonly key: Buffer;

  constructor(key: Buffer = randomBytes(PSEUDONYM_KEY_BYTES)) {
    if (key.length < PSEUDONYM_KEY_BYTES) {
      throw new Error(`pseudonymisation key must be at least ${PSEUDONYM_KEY_BYTES} bytes`);
    }
    this.key = Buffer.from(key);
  }

  pseudonym(identifier: string, domain?: string): string {
    return pseudonymise(identifier, this.key, domain);
  }
}
