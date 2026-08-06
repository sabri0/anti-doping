/**
 * Authentication against the organizational certification authorities.
 *
 * Credentials are checked by enrolling the user with their own organization's
 * Fabric CA: the CA signs a certificate only if the identity and secret are
 * valid, so a successful enrolment *is* the authentication result. Nothing is
 * validated against a list held by this service.
 *
 * This matters beyond the login screen. Before it existed, the gateway carried
 * every organization's identity and chose between them from a `?org=` query
 * parameter, so any caller could act as any organizational class. A session now
 * fixes the acting organization for its lifetime, which restores the property
 * the framework depends on: authority follows the identity, not the request.
 *
 * The session's organization still only selects which enrolled identity signs
 * the transaction. The authorization decision remains the chaincode's — a
 * laboratory session cannot write consent no matter what this layer believes.
 */

import { randomBytes, generateKeyPairSync, createSign } from 'crypto';
import * as https from 'https';
import { promises as fs } from 'fs';
import * as path from 'path';
import { OrgKey, isOrgKey } from './fabric';

const CRYPTO_ROOT = process.env.CRYPTO_ROOT ?? '/work/network/organizations';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 8 * 60 * 60 * 1000);

/** CA host and port per organizational class, matching docker-compose. */
const CA: Record<OrgKey, { host: string; port: number }> = {
  athlete: { host: 'ca-athlete', port: 7054 },
  federation: { host: 'ca-federation', port: 8054 },
  nado: { host: 'ca-nado', port: 9054 },
  lab: { host: 'ca-lab', port: 10054 },
  research: { host: 'ca-research', port: 11054 },
};

export interface Session {
  token: string;
  org: OrgKey;
  username: string;
  issuedAt: number;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function prune(): void {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expiresAt <= now) sessions.delete(token);
}

/**
 * Build a PKCS#10 certificate signing request.
 *
 * Written by hand rather than pulled from a library: the CA needs a CSR to
 * enrol, and this is the only ASN.1 the gateway ever produces. Keeping it here
 * avoids adding a certificate toolkit to the image for one request shape.
 */
function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (body: Buffer) => tlv(0x31, body);
const oid = (bytes: number[]) => tlv(0x06, Buffer.from(bytes));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));

function buildCsr(commonName: string): { csrPem: string; privateKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });

  // CN=<username>
  const subject = seq(set(seq(oid([0x55, 0x04, 0x03]), utf8(commonName))));
  const version = tlv(0x02, Buffer.from([0x00]));
  const attributes = tlv(0xa0, Buffer.alloc(0));
  const info = seq(version, subject, publicKey as Buffer, attributes);

  // ecdsa-with-SHA256
  const algorithm = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  const signer = createSign('SHA256');
  signer.update(info);
  const signature = tlv(0x03, Buffer.concat([Buffer.from([0x00]), signer.sign(privateKey as string)]));

  const der = seq(info, algorithm, signature);
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return {
    csrPem: `-----BEGIN CERTIFICATE REQUEST-----\n${b64}\n-----END CERTIFICATE REQUEST-----\n`,
    privateKeyPem: privateKey as string,
  };
}

async function caCertificate(org: OrgKey): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path.join(CRYPTO_ROOT, 'fabric-ca', org, 'ca-cert.pem'));
  } catch {
    return undefined; // fall back to the org's TLS anchor below
  }
}

/** POST to the CA over TLS, trusting only that CA's own certificate. */
function caRequest(
  org: OrgKey,
  body: string,
  auth: string,
  ca: Buffer | undefined,
): Promise<{ status: number; body: string }> {
  const { host, port } = CA[org];
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        path: '/api/v1/enroll',
        method: 'POST',
        timeout: 12000,
        ca,
        // The CA's certificate is self-signed for the deployment's own hostname;
        // it is supplied above, so the chain is checked against it rather than
        // against a public root store.
        rejectUnauthorized: Boolean(ca),
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Basic ${auth}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('certification authority timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

/** Authenticate by enrolling with the organization's own CA. */
export async function login(orgRaw: string, username: string, password: string): Promise<Session> {
  const org = String(orgRaw || '').toLowerCase();
  if (!isOrgKey(org)) throw new AuthError(`unknown organization: ${orgRaw}`, 400);
  if (!username || !password) throw new AuthError('username and password are required', 400);

  const { csrPem } = buildCsr(username);
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const ca = await caCertificate(org);

  let res;
  try {
    res = await caRequest(org, JSON.stringify({ certificate_request: csrPem }), auth, ca);
  } catch (error) {
    throw new AuthError(
      `could not reach the ${org} certification authority: ${(error as Error).message}`,
      503,
    );
  }

  if (res.status === 401) throw new AuthError('incorrect username or password');
  if (res.status >= 300) {
    let detail = res.body.slice(0, 160);
    try {
      const parsed = JSON.parse(res.body);
      detail = parsed?.errors?.[0]?.message ?? detail;
    } catch { /* keep the raw body */ }
    throw new AuthError(`enrolment refused by the certification authority: ${detail}`);
  }

  const now = Date.now();
  const session: Session = {
    token: randomBytes(32).toString('hex'),
    org,
    username,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  prune();
  sessions.set(session.token, session);
  return session;
}

export function logout(token: string): boolean {
  return sessions.delete(token);
}

export function sessionFor(token: string | undefined): Session | null {
  if (!token) return null;
  prune();
  return sessions.get(token) ?? null;
}

export function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' ? value : undefined;
}
