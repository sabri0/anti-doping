/**
 * Fabric Gateway connection management.
 *
 * One gateway connection per organizational class, because every transaction
 * must be submitted under the identity of the organization that is entitled to
 * perform it: a laboratory result signed by a NADO identity is refused by the
 * chaincode, which is the point of the multi-CA design in §3.2.
 */

import { connect, Gateway, Identity, Signer, signers } from '@hyperledger/fabric-gateway';
import * as grpc from '@grpc/grpc-js';
import { createPrivateKey } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

const DOMAIN = 'antidoping.org';
const CHANNEL = process.env.CHANNEL ?? 'antidopingchannel';
const CRYPTO_ROOT = process.env.CRYPTO_ROOT ?? '/work/network/organizations';

export type OrgKey = 'athlete' | 'federation' | 'nado' | 'lab' | 'research';

export const ORGS: Record<OrgKey, { msp: string; port: number }> = {
  athlete: { msp: 'AthleteMSP', port: 7051 },
  federation: { msp: 'FederationMSP', port: 8051 },
  nado: { msp: 'NADOMSP', port: 9051 },
  lab: { msp: 'LabMSP', port: 10051 },
  research: { msp: 'ResearchMSP', port: 11051 },
};

export function isOrgKey(value: string): value is OrgKey {
  return Object.prototype.hasOwnProperty.call(ORGS, value);
}

/** fabric-ca writes keys and certificates under generated filenames. */
async function firstFile(dir: string): Promise<string> {
  const entries = await fs.readdir(dir);
  if (entries.length === 0) throw new Error(`no file in ${dir}`);
  return path.join(dir, entries.sort()[0]);
}

async function identityFor(org: OrgKey): Promise<Identity> {
  const mspDir = path.join(
    CRYPTO_ROOT,
    'peerOrganizations',
    `${org}.${DOMAIN}`,
    'users',
    `Admin@${org}.${DOMAIN}`,
    'msp',
  );
  const credentials = await fs.readFile(await firstFile(path.join(mspDir, 'signcerts')));
  return { mspId: ORGS[org].msp, credentials };
}

async function signerFor(org: OrgKey): Promise<Signer> {
  const keyDir = path.join(
    CRYPTO_ROOT,
    'peerOrganizations',
    `${org}.${DOMAIN}`,
    'users',
    `Admin@${org}.${DOMAIN}`,
    'msp',
    'keystore',
  );
  const pem = await fs.readFile(await firstFile(keyDir));
  return signers.newPrivateKeySigner(createPrivateKey(pem));
}

async function grpcClientFor(org: OrgKey): Promise<grpc.Client> {
  const peer = `peer0.${org}.${DOMAIN}`;
  const tlsCert = await fs.readFile(
    path.join(CRYPTO_ROOT, 'peerOrganizations', `${org}.${DOMAIN}`, 'peers', peer, 'tls', 'ca.crt'),
  );
  return new grpc.Client(`${peer}:${ORGS[org].port}`, grpc.credentials.createSsl(tlsCert), {
    'grpc.ssl_target_name_override': peer,
  });
}

const gateways = new Map<OrgKey, Gateway>();
const clients = new Map<OrgKey, grpc.Client>();

export async function gatewayFor(org: OrgKey): Promise<Gateway> {
  const existing = gateways.get(org);
  if (existing) return existing;

  const client = await grpcClientFor(org);
  clients.set(org, client);

  const gateway = connect({
    client,
    identity: await identityFor(org),
    signer: await signerFor(org),
    evaluateOptions: () => ({ deadline: Date.now() + 15000 }),
    endorseOptions: () => ({ deadline: Date.now() + 30000 }),
    submitOptions: () => ({ deadline: Date.now() + 30000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
  });
  gateways.set(org, gateway);
  return gateway;
}

export async function contractFor(org: OrgKey, chaincode: 'custody' | 'consent') {
  const gateway = await gatewayFor(org);
  return gateway.getNetwork(CHANNEL).getContract(chaincode);
}

export function closeAll(): void {
  for (const gateway of gateways.values()) gateway.close();
  for (const client of clients.values()) client.close();
  gateways.clear();
  clients.clear();
}

const decoder = new TextDecoder();

/** Chaincode functions return JSON strings; empty payloads become null. */
export function decode(payload: Uint8Array): unknown {
  const text = decoder.decode(payload);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
