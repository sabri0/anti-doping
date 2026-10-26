'use strict';

/**
 * Fabric Gateway connections, one per organisational class, each signing with
 * that organisation's own administrator identity issued by its own CA.
 *
 * Every transaction is built explicitly — proposal, endorsement, submission,
 * commit status — rather than through submitTransaction(), for two reasons:
 * the load driver times each phase separately, and the scenarios need to
 * choose exactly which organisations endorse, which is how the insider tests
 * collect endorsements from both the NADO and the laboratory peers.
 */

const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
const grpc = require('@grpc/grpc-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DOMAIN = 'antidoping.org';
const CHANNEL = process.env.CHANNEL || 'antidopingchannel';
const CRYPTO_ROOT = process.env.CRYPTO_ROOT || '/work/network/organizations';
/** Inside the network the peers are addressed by host name; from the host, via localhost. */
const PEER_HOST = process.env.PEER_HOST || '';

const ORGS = {
  athlete: { msp: 'AthleteMSP', base: 7 },
  federation: { msp: 'FederationMSP', base: 8 },
  nado: { msp: 'NADOMSP', base: 9 },
  lab: { msp: 'LabMSP', base: 10 },
  research: { msp: 'ResearchMSP', base: 11 },
};
const ORG_BY_MSP = Object.fromEntries(Object.entries(ORGS).map(([k, v]) => [v.msp, k]));

function firstFile(dir) {
  const entries = fs.readdirSync(dir).sort();
  if (entries.length === 0) throw new Error(`no file in ${dir}`);
  return path.join(dir, entries[0]);
}

function identity(org, user = 'Admin') {
  const msp = path.join(CRYPTO_ROOT, 'peerOrganizations', `${org}.${DOMAIN}`, 'users', `${user}@${org}.${DOMAIN}`, 'msp');
  return {
    identity: { mspId: ORGS[org].msp, credentials: fs.readFileSync(firstFile(path.join(msp, 'signcerts'))) },
    signer: signers.newPrivateKeySigner(crypto.createPrivateKey(fs.readFileSync(firstFile(path.join(msp, 'keystore'))))),
  };
}

/**
 * A gateway connection for `org`, through peer `peerIndex` of that
 * organisation. The gRPC channel allows enough concurrent streams for an
 * open-loop driver with thousands of transactions in flight.
 */
function connectOrg(org, peerIndex = 0, user = 'Admin') {
  const host = `peer${peerIndex}.${org}.${DOMAIN}`;
  const port = ORGS[org].base * 1000 + 51 + 10 * peerIndex;
  const tls = fs.readFileSync(path.join(CRYPTO_ROOT, 'peerOrganizations', `${org}.${DOMAIN}`, 'peers', host, 'tls', 'ca.crt'));
  const client = new grpc.Client(`${PEER_HOST || host}:${port}`, grpc.credentials.createSsl(tls), {
    'grpc.ssl_target_name_override': host,
    'grpc.max_concurrent_streams': 100000,
    'grpc.keepalive_time_ms': 120000,
    'grpc.http2.min_time_between_pings_ms': 120000,
  });
  const { identity: id, signer } = identity(org, user);
  const gateway = connect({
    client,
    identity: id,
    signer,
    hash: hash.sha256,
    evaluateOptions: () => ({ deadline: Date.now() + 30000 }),
    endorseOptions: () => ({ deadline: Date.now() + 60000 }),
    submitOptions: () => ({ deadline: Date.now() + 60000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 120000 }),
  });
  const network = gateway.getNetwork(CHANNEL);
  return {
    org,
    msp: ORGS[org].msp,
    contract: (name) => network.getContract(name),
    close: () => {
      gateway.close();
      client.close();
    },
  };
}

const decoder = new TextDecoder();
function decode(bytes) {
  const text = decoder.decode(bytes);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Endorse, submit and wait for commit, returning the result and the time each
 * phase took. A transaction that is endorsed but fails validation (for
 * example ENDORSEMENT_POLICY_FAILURE) is reported with its validation code
 * rather than thrown, because for the insider tests that code is the outcome.
 */
async function transact(conn, chaincode, fn, { args = [], transient, endorsers } = {}) {
  const t0 = performance.now();
  const options = { arguments: args.map(String) };
  if (transient) options.transientData = { input: Buffer.from(JSON.stringify(transient)) };
  if (endorsers) options.endorsingOrganizations = endorsers;
  const proposal = conn.contract(chaincode).newProposal(fn, options);
  const transaction = await proposal.endorse();
  const t1 = performance.now();
  const submitted = await transaction.submit();
  const t2 = performance.now();
  const status = await submitted.getStatus();
  const t3 = performance.now();
  return {
    txId: status.transactionId,
    valid: status.successful,
    code: status.code,
    result: status.successful ? decode(transaction.getResult()) : null,
    timing: { endorse: t1 - t0, order: t2 - t1, commit: t3 - t2, total: t3 - t0 },
    blockNumber: Number(status.blockNumber),
  };
}

/** Evaluate a read-only function, optionally on a peer of a named organisation. */
async function query(conn, chaincode, fn, args = [], endorsers) {
  const options = { arguments: args.map(String) };
  if (endorsers) options.endorsingOrganizations = endorsers;
  return decode(await conn.contract(chaincode).evaluate(fn, options));
}

/** The message the chaincode actually raised, from a gateway error's per-peer details. */
function chaincodeMessage(error) {
  const details = error && error.details;
  if (Array.isArray(details) && details.length > 0) {
    return details.map((d) => d.message).filter(Boolean).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

module.exports = { ORGS, ORG_BY_MSP, CHANNEL, connectOrg, transact, query, decode, chaincodeMessage };
