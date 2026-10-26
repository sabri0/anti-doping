'use strict';

/**
 * Executable regulatory scenarios.
 *
 * Each scenario drives the deployed network through the Fabric Gateway, as the
 * organisations themselves would, and asserts its expected outcome; the run
 * fails if any assertion does not hold. Results are written to
 * docs/scenario-results.json, from which Supplementary Table S3 and the
 * scenario diagrams are generated.
 *
 *   node scenarios.js            (inside the driver container, or from the host
 *                                 with PEER_HOST=localhost CRYPTO_ROOT=...)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { connectOrg, transact, query, chaincodeMessage, CHANNEL } = require('./lib/fabric');

const OUT = process.env.SCENARIO_OUT || path.resolve(__dirname, '../docs/scenario-results.json');
const LIST_VERSION = '2026-01';
const LIST_HASH = 'f'.repeat(64);
const ALL_CATEGORIES = [
  'gps_accelerometry',
  'biochemical_markers',
  'abp_haematological',
  'abp_steroidal',
  'psychological',
  'genetic',
];
const NADO_LAB = ['NADOMSP', 'LabMSP'];
const VALIDATION = { 0: 'VALID', 10: 'ENDORSEMENT_POLICY_FAILURE', 11: 'MVCC_READ_CONFLICT' };

const c = Object.fromEntries(['athlete', 'federation', 'nado', 'lab', 'research'].map((o) => [o, connectOrg(o)]));
const results = [];
let failures = 0;

const uniq = () => crypto.randomBytes(4).toString('hex');
/** Stand-in for the athlete organisation's pseudonymisation service (HMAC-SHA-256). */
const PSEUDONYM_KEY = crypto.randomBytes(32);
const pseudonym = () =>
  crypto.createHmac('sha256', PSEUDONYM_KEY).update(`antidoping/custody\u0000ADAMS-${uniq()}`).digest('hex');

/**
 * Run a transaction and report refusals instead of throwing.
 *
 * A transaction endorsed by a peer that has not yet committed the previous
 * block fails validation with MVCC_READ_CONFLICT; clients retry such
 * transactions, and so does this one, up to three times. Every other
 * validation code, and every refusal by the contract, is reported as it is.
 */
async function attempt(conn, cc, fn, opts) {
  for (let tries = 1; ; tries += 1) {
    try {
      const r = await transact(conn, cc, fn, opts);
      if (r.valid) return { ok: true, result: r.result, txId: r.txId };
      if ((r.code === 11 || r.code === 12) && tries < 4) {
        await new Promise((res) => setTimeout(res, 1000 * tries));
        continue;
      }
      return { ok: false, validation: VALIDATION[r.code] || `code ${r.code}`, txId: r.txId };
    } catch (error) {
      return { ok: false, refused: chaincodeMessage(error) };
    }
  }
}

async function must(conn, cc, fn, opts) {
  const r = await attempt(conn, cc, fn, opts);
  if (!r.ok) throw new Error(`${fn} failed: ${r.refused || r.validation}`);
  return r;
}

function record(r) {
  results.push(r);
  if (!r.passed) failures += 1;
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}`);
  console.log(`        outcome: ${r.outcome}`);
  if (!r.passed) console.log(`        EXPECTED: ${r.expected}`);
}

// ------------------------------------------------------------------ building blocks

async function open(code, athlete, seal = `seal-${code}`) {
  await must(c.nado, 'custody', 'initiateSampleCustody', {
    args: [code, athlete, seal, crypto.createHash('sha256').update(`doping control form ${code}`).digest('hex')],
    endorsers: NADO_LAB,
  });
  return seal;
}

async function acknowledge(code, seal) {
  await must(c.athlete, 'custody', 'acknowledgeSampleCollection', { args: [code, seal], endorsers: ['AthleteMSP', 'NADOMSP'] });
}

async function dispatch(code, windowHours = 48) {
  await must(c.nado, 'custody', 'proposeCustodyTransfer', { args: [code, 'LabMSP', 'true', String(windowHours)], endorsers: NADO_LAB });
}

async function receive(code, seal, sealIntact = true) {
  await must(c.lab, 'custody', 'acceptCustodyTransfer', { args: [code, '1', String(sealIntact), seal], endorsers: NADO_LAB });
}

async function fullChain(code, athlete) {
  const seal = await open(code, athlete);
  await acknowledge(code, seal);
  await dispatch(code);
  await receive(code, seal);
  return seal;
}

async function analyse(code, adverse, accreditation) {
  await must(c.lab, 'custody', 'recordSampleAnalysisResult', {
    args: [code],
    transient: {
      adverse,
      substance: adverse ? 'Erythropoietin' : '',
      prohibitedListVersion: LIST_VERSION,
      prohibitedListHash: LIST_HASH,
      laboratoryAccreditation: accreditation,
    },
    endorsers: NADO_LAB,
  });
}

async function resultsManagement(code) {
  await must(c.nado, 'custody', 'triggerResultsManagement', { args: [code], endorsers: NADO_LAB });
  return query(c.nado, 'custody', 'getResultsManagement', [code]);
}

// ------------------------------------------------------------------ scenarios

async function s1() {
  const code = `S1-${uniq()}`;
  await fullChain(code, pseudonym());
  await analyse(code, true, 'VERIFIED');
  const rm = await resultsManagement(code);
  await must(c.nado, 'custody', 'notifyAthleteOfAAF', { args: [code], endorsers: NADO_LAB });
  const nadoView = await query(c.nado, 'custody', 'getResultsManagement', [code]);
  const athleteView = await query(c.athlete, 'custody', 'enforceResultsConfidentiality', [code], ['AthleteMSP']);
  record({
    id: 'S1',
    title: 'Adverse analytical finding confirmed on an attested custody chain',
    regulation: 'WADA Code Art. 2.1, 5.4.1 (ISTI), 7.1, 7.2, 14.1.1',
    rule: rm.ruleId,
    steps: [
      'NADO initiateSampleCustody; athlete acknowledgeSampleCollection',
      'NADO proposeCustodyTransfer; laboratory acceptCustodyTransfer',
      'laboratory recordSampleAnalysisResult (private, transient input)',
      'NADO triggerResultsManagement; NADO notifyAthleteOfAAF',
    ],
    outcome: `${rm.action} (${rm.ruleId}); notified within deadline: ${nadoView.notification && nadoView.notification.withinDeadline}; athlete reads the notice: ${athleteView.granted}`,
    expected: 'AAF_CONFIRMED via R1 with a notification deadline; the athlete reads the notice from its own peer',
    passed:
      rm.action === 'AAF_CONFIRMED' &&
      Boolean(rm.notificationDeadline) &&
      nadoView.notification.withinDeadline === true &&
      athleteView.granted === true &&
      athleteView.notice.analyticalResult === 'Erythropoietin',
  });
}

async function s2() {
  const code = `S2-${uniq()}`;
  const seal = await open(code, pseudonym());
  await acknowledge(code, seal);
  await dispatch(code); // the laboratory never accepts
  await analyse(code, true, 'VERIFIED');
  const rm = await resultsManagement(code);
  const sample = await query(c.nado, 'custody', 'getSample', [code]);
  record({
    id: 'S2',
    title: 'Dispatch never accepted by the laboratory invalidates the process before any finding',
    regulation: 'ISTI chain of custody (guard on Code Art. 7.1)',
    rule: rm.ruleId,
    steps: ['custody opened and acknowledged', 'NADO dispatches; no receipt is ever recorded', 'adverse analysis', 'results management'],
    outcome: `${rm.action} (${rm.ruleId}); sample ${sample.status}; alert to ${rm.auditAlertRecipients.join(', ')}; suppressed: ${rm.concurrentMatches.join(', ')}`,
    expected: 'PROCESS_INVALIDATED; sample INVALIDATED; the adverse finding is retained as a concurrent match',
    passed: rm.action === 'PROCESS_INVALIDATED' && sample.status === 'INVALIDATED' && rm.concurrentMatches.includes('R1_AAF_CONFIRMED'),
  });
}

async function accreditationScenario(id, accreditation, expectAction, rule, title, regulation) {
  const code = `${id}-${uniq()}`;
  await fullChain(code, pseudonym());
  await analyse(code, true, accreditation);
  const rm = await resultsManagement(code);
  record({
    id,
    title,
    regulation,
    rule: rm.ruleId,
    steps: ['attested custody chain', `adverse analysis, accreditation ${accreditation}`, 'results management'],
    outcome: `${rm.action} (${rm.ruleId}); human oversight required: ${rm.humanOversightRequired}`,
    expected: `${expectAction} via ${rule}`,
    passed: rm.action === expectAction,
  });
}

async function s5() {
  const code = `S5-${uniq()}`;
  const athlete = pseudonym();
  for (const id of ['F1', 'F2', 'F3']) {
    await must(c.nado, 'custody', 'recordWhereaboutsStatus', {
      transient: { athleteHash: athlete, filingId: `${code}-${id}`, failure: true, ledgerVerified: true },
      endorsers: NADO_LAB,
    });
  }
  await fullChain(code, athlete);
  await analyse(code, false, 'VERIFIED');
  const rm = await resultsManagement(code);
  record({
    id: 'S5',
    title: 'Third ledger-verified whereabouts failure inside 12 months',
    regulation: 'WADA Code Art. 2.4, 7.1',
    rule: rm.ruleId,
    steps: ['three verified whereabouts failures (private)', 'attested custody chain', 'negative analysis', 'results management'],
    outcome: `${rm.action} (${rm.ruleId}) with a negative analysis: the violation is procedural, not analytical`,
    expected: 'WHEREABOUTS_ADRV via R4',
    passed: rm.action === 'WHEREABOUTS_ADRV',
  });
}

async function s6() {
  const code = `S6-${uniq()}`;
  const athlete = pseudonym();
  await must(c.lab, 'custody', 'recordPassportEvaluation', {
    transient: { athleteHash: athlete, anomaly: true, expertPanelRequired: true },
    endorsers: NADO_LAB,
  });
  await fullChain(code, athlete);
  await analyse(code, false, 'VERIFIED');
  const rm = await resultsManagement(code);
  record({
    id: 'S6',
    title: 'ABP anomaly escalates to the expert panel',
    regulation: 'ABP guidelines; GDPR Art. 22',
    rule: rm.ruleId,
    steps: ['passport evaluation (private)', 'attested custody chain', 'negative analysis', 'results management'],
    outcome: `${rm.action} (${rm.ruleId}); human oversight required: ${rm.humanOversightRequired}`,
    expected: 'ABP_ALERT_INITIATED via R3 with oversight required',
    passed: rm.action === 'ABP_ALERT_INITIATED' && rm.humanOversightRequired === true,
  });
}

/**
 * S7 — the insider, as the reviewer specified: a NADO client that collects
 * endorsements from both the NADO and the laboratory peers. Five attempts,
 * each against a different layer of the design.
 */
async function s7() {
  const code = `S7-${uniq()}`;
  const seal = await fullChain(code, pseudonym());
  await analyse(code, true, 'VERIFIED');
  const before = await resultsManagement(code);

  // (a) Rewrite the committed record by re-running results management with
  //     both endorsements. Both peers execute the write-once check and refuse.
  const a = await attempt(c.nado, 'custody', 'triggerResultsManagement', { args: [code], endorsers: NADO_LAB });

  // (b) Record the laboratory's side of a handover. A second sample is
  //     dispatched; the NADO then submits the acceptance itself, both endorsing.
  const code2 = `S7b-${uniq()}`;
  const seal2 = await open(code2, pseudonym());
  await acknowledge(code2, seal2);
  await dispatch(code2);
  const b = await attempt(c.nado, 'custody', 'acceptCustodyTransfer', { args: [code2, '1', 'true', seal2], endorsers: NADO_LAB });

  // (c) Amend the outcome and approve the amendment itself.
  await must(c.nado, 'custody', 'proposeResultsAmendment', {
    args: [code],
    transient: { action: 'NO_ACTION_REQUIRED', reason: 'insider attempt' },
    endorsers: NADO_LAB,
  });
  const cSelf = await attempt(c.nado, 'custody', 'approveResultsAmendment', { args: [code, '0'], endorsers: NADO_LAB });

  // (d) Endorsement pinned to the NADO alone on a key bound to both parties:
  //     the execution-integrity layer, which defends against a peer running
  //     modified chaincode rather than against the NADO's client.
  const code3 = `S7d-${uniq()}`;
  await open(code3, pseudonym());
  const d = await attempt(c.nado, 'custody', 'proposeCustodyTransfer', { args: [code3, 'LabMSP', 'true', '48'], endorsers: ['NADOMSP'] });

  // (e) A private results-collection write endorsed by one class only.
  const code4 = `S7e-${uniq()}`;
  await fullChain(code4, pseudonym());
  const e = await attempt(c.lab, 'custody', 'recordSampleAnalysisResult', {
    args: [code4],
    transient: { adverse: true, substance: 'x', prohibitedListVersion: LIST_VERSION, prohibitedListHash: LIST_HASH, laboratoryAccreditation: 'VERIFIED' },
    endorsers: ['LabMSP'],
  });

  const after = await query(c.nado, 'custody', 'getResultsManagement', [code]);
  // The legitimate path still works: the laboratory approves the open amendment.
  const legit = await attempt(c.lab, 'custody', 'approveResultsAmendment', { args: [code, '0'], endorsers: NADO_LAB });
  const amended = await query(c.nado, 'custody', 'getResultsManagement', [code]);

  const refused = (r, re) => !r.ok && re.test(r.refused || r.validation || '');
  record({
    id: 'S7',
    title: 'An insider holding both endorsements still cannot act for the other organisation',
    regulation: 'Threat model: NADO acting unilaterally (reviewer scenario)',
    steps: [
      '(a) NADO re-triggers results management, endorsed by NADO and laboratory peers',
      '(b) NADO submits the laboratory acceptance of its own dispatch, both endorsing',
      '(c) NADO approves its own amendment, both endorsing',
      '(d) NADO-only endorsement of a write to a key bound to NADO and laboratory',
      '(e) laboratory-only endorsement of a results-collection write',
      'laboratory approves the amendment (legitimate two-party path)',
    ],
    outcome:
      `(a) ${a.refused ? 'refused by chaincode' : a.validation || 'COMMITTED'}; ` +
      `(b) ${b.refused ? 'refused by chaincode' : b.validation || 'COMMITTED'}; ` +
      `(c) ${cSelf.refused ? 'refused by chaincode' : cSelf.validation || 'COMMITTED'}; ` +
      `(d) ${d.validation || d.refused || 'COMMITTED'}; (e) ${e.validation || e.refused || 'COMMITTED'}; ` +
      `record unchanged: ${after.action === before.action}; after laboratory approval: ${amended.action}`,
    expected: '(a)-(c) refused by both peers; (d)-(e) ENDORSEMENT_POLICY_FAILURE; record unchanged until the laboratory approves',
    passed:
      refused(a, /not overwritten/) &&
      refused(b, /only LabMSP may accept/) &&
      refused(cSelf, /other organisation/) &&
      d.validation === 'ENDORSEMENT_POLICY_FAILURE' &&
      e.validation === 'ENDORSEMENT_POLICY_FAILURE' &&
      after.action === before.action &&
      legit.ok &&
      amended.action === 'NO_ACTION_REQUIRED',
    detail: { a, b, c: cSelf, d, e },
  });
  void seal;
}

async function s8() {
  const code = `S8-${uniq()}`;
  await fullChain(code, pseudonym());
  await analyse(code, true, 'VERIFIED');
  await resultsManagement(code);
  const suspend = () =>
    attempt(c.nado, 'custody', 'recordProvisionalSuspension', { args: [code], transient: { groundsArticle: 'Article 7.4' }, endorsers: NADO_LAB });
  const oversight = (decision) =>
    must(c.nado, 'custody', 'enforceOversightRequirement', {
      args: [code],
      transient: { reviewerId: 'reviewer-014', decision, rationale: `recorded ${decision}` },
      endorsers: NADO_LAB,
    });
  const refused = await suspend();
  await oversight('REQUEST_FURTHER_ANALYSIS');
  const stillRefused = await suspend();
  await oversight('UPHOLD');
  const allowed = await suspend();
  record({
    id: 'S8',
    title: 'Career-affecting decision blocked until a named human upholds it',
    regulation: 'WADA Code Art. 7.4; GDPR Art. 22',
    steps: ['confirmed AAF', 'suspension attempted', 'oversight: further analysis', 'suspension attempted', 'oversight: uphold', 'suspension'],
    outcome: `refused without oversight: ${!refused.ok}; refused after REQUEST_FURTHER_ANALYSIS: ${!stillRefused.ok}; permitted after UPHOLD: ${allowed.ok}`,
    expected: 'refused twice, then permitted only after an UPHOLD by a named reviewer',
    passed: !refused.ok && !stillRefused.ok && allowed.ok,
  });
}

async function grantConsent(athlete, to, purpose, categories, special = true) {
  await must(c.athlete, 'consent', 'recordConsentTransaction', {
    transient: {
      athleteHash: athlete,
      grantedToMSP: to,
      purpose,
      categories,
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2027-12-31T00:00:00.000Z',
      specialCategoryAuthorised: special,
    },
    endorsers: ['AthleteMSP'],
  });
}

/** A request is endorsed by an athlete-organisation peer, the only class holding consent. */
async function requestAccess(conn, athlete, purpose, categories) {
  const r = await must(conn, 'consent', 'validateConsent', {
    transient: { athleteHash: athlete, declaredPurpose: purpose, requestedCategories: categories },
    endorsers: ['AthleteMSP'],
  });
  return query(conn, 'consent', 'getAccessDecision', [athlete, conn.msp, r.result.auditRef], ['AthleteMSP']);
}

async function s9() {
  const athlete = pseudonym();
  await grantConsent(athlete, 'ResearchMSP', 'cardiovascular_research', ALL_CATEGORIES);
  const d = await requestAccess(c.research, athlete, 'cardiovascular_research', ALL_CATEGORIES);
  record({
    id: 'S9',
    title: 'Purpose limitation releases two of six categories',
    regulation: 'GDPR Art. 5(1)(c), 7, 9, 25',
    steps: ['athlete consents to all six categories for the study', 'research organisation requests all six'],
    outcome: `granted: ${d.granted.join(', ')}; denied: ${d.denied.join(', ')}`,
    expected: 'granted abp_haematological and gps_accelerometry only, each refusal with a reason',
    passed:
      d.granted.length === 2 &&
      d.granted.includes('abp_haematological') &&
      d.granted.includes('gps_accelerometry') &&
      d.outcomes.every((o) => o.reason && o.gdprArticle),
    detail: { outcomes: d.outcomes },
  });
}

async function s10() {
  const athlete = pseudonym();
  await grantConsent(athlete, 'ResearchMSP', 'cardiovascular_research', ['abp_haematological', 'gps_accelerometry']);
  const before = await requestAccess(c.research, athlete, 'cardiovascular_research', ['abp_haematological', 'gps_accelerometry']);
  await must(c.athlete, 'consent', 'withdrawConsent', {
    transient: { athleteHash: athlete, grantedToMSP: 'ResearchMSP', purpose: 'cardiovascular_research' },
    endorsers: ['AthleteMSP'],
  });
  const after = await requestAccess(c.research, athlete, 'cardiovascular_research', ['abp_haematological', 'gps_accelerometry']);
  record({
    id: 'S10',
    title: 'Consent withdrawal takes effect at the next evaluation',
    regulation: 'GDPR Art. 7(3)',
    steps: ['consent granted', 'request', 'withdrawal', 'request'],
    outcome: `released before withdrawal: ${before.granted.length}; after: ${after.granted.length}`,
    expected: 'two categories before, none after',
    passed: before.granted.length === 2 && after.granted.length === 0,
  });
}

async function s11() {
  let offchain;
  try {
    offchain = require(process.env.OFFCHAIN_DIST || '../offchain/dist');
  } catch {
    offchain = null;
  }
  const cluster = offchain && new offchain.IpfsCluster(
    (process.env.IPFS_ENDPOINTS || 'http://ipfs0:5001,http://ipfs1:5001,http://ipfs2:5001').split(','),
  );
  if (!offchain || !(await cluster.isReachable())) {
    record({ id: 'S11', title: 'Off-chain storage, revocation, recovery and erasure', regulation: 'GDPR Art. 17', steps: [], outcome: 'SKIPPED: off-chain module or IPFS unavailable', expected: 'run with IPFS reachable', passed: false });
    return;
  }
  const vault = new offchain.KeyVault();
  const custody = new offchain.ShareCustody();
  const athlete = pseudonym();
  const payload = Buffer.from(JSON.stringify({ athleteHash: athlete, category: 'abp_haematological', HGB: 15.2, RET: 1.06 }));
  const { record: stored } = await offchain.storeEncrypted(payload, { cluster, vault });
  custody.deposit(offchain.splitForRecovery(vault.exportForSharing(stored.keyRef)));
  await must(c.lab, 'consent', 'registerOffchainPayload', {
    transient: { athleteHash: athlete, category: 'abp_haematological', cid: stored.cid, keyRef: stored.keyRef, commitment: stored.commitment },
    endorsers: ['AthleteMSP'],
  });
  await grantConsent(athlete, 'ResearchMSP', 'cardiovascular_research', ['abp_haematological']);
  const granted = await requestAccess(c.research, athlete, 'cardiovascular_research', ['abp_haematological']);

  const raw = await cluster.cat(stored.cid);
  const ciphertextOnly = !raw.toString('utf8').includes('HGB');

  offchain.revokeDataAccessKey(vault, stored.keyRef);
  await must(c.athlete, 'consent', 'revokeDataAccessKey', { transient: { athleteHash: athlete, category: 'abp_haematological' }, endorsers: ['AthleteMSP'] });
  let deniedAfterRevocation = false;
  try {
    await offchain.retrieveDecrypted(stored, { cluster, vault });
  } catch {
    deniedAfterRevocation = true;
  }
  let custodiansRefused = false;
  try {
    offchain.recoverDataAccessKey(vault, stored.keyRef, [...custody.produce('physician'), ...custody.produce('federation-official')]);
  } catch {
    custodiansRefused = true;
  }
  offchain.recoverDataAccessKey(vault, stored.keyRef, [...custody.produce('athlete'), ...custody.produce('physician')]);
  await must(c.athlete, 'consent', 'restoreDataAccessKey', {
    transient: { athleteHash: athlete, category: 'abp_haematological', holders: ['athlete', 'physician'] },
    endorsers: ['AthleteMSP'],
  });
  const restored = (await offchain.retrieveDecrypted(stored, { cluster, vault })).equals(payload);

  const certificate = await offchain.destroyIPFSAccessToken(stored, vault, cluster, custody);
  const erasure = await must(c.athlete, 'consent', 'destroyIPFSAccessToken', {
    transient: { athleteHash: athlete, category: 'abp_haematological', erasureCertificate: certificate },
    endorsers: ['AthleteMSP'],
  });
  const erasureRecord = await query(c.athlete, 'consent', 'getErasureRecord', [athlete, 'abp_haematological'], ['AthleteMSP']);
  let unrecoverable = false;
  try {
    await offchain.retrieveDecrypted(stored, { cluster, vault });
  } catch {
    unrecoverable = !(await cluster.isRetrievableLocally(stored.cid));
  }
  record({
    id: 'S11',
    title: 'Off-chain storage; revocation with athlete-mandatory recovery; irreversible erasure with Article 17(2) notice',
    regulation: 'GDPR Art. 17(1), 17(2)',
    steps: [
      'ciphertext stored on three nodes; pointer and keyed commitment registered (private)',
      'research organisation granted the category',
      'key revoked; access denied',
      'physician + federation official attempt recovery; athlete + physician recover',
      'erasure: key and every share destroyed, unpinned and garbage-collected on every node',
    ],
    outcome:
      `ciphertext only: ${ciphertextOnly}; denied after revocation: ${deniedAfterRevocation}; ` +
      `custodians without athlete refused: ${custodiansRefused}; athlete + physician restored: ${restored}; ` +
      `erasure complete: ${certificate.complete}; unrecoverable: ${unrecoverable}; ` +
      `Article 17(2) notice to: ${erasureRecord.article17_2Recipients.join(', ') || 'none'}`,
    expected: 'every check true; the research organisation notified',
    passed:
      granted.granted.length === 1 &&
      ciphertextOnly && deniedAfterRevocation && custodiansRefused && restored &&
      certificate.complete && unrecoverable &&
      erasure.result.recipientsNotified === 1 &&
      erasureRecord.article17_2Recipients.includes('ResearchMSP'),
  });
}

/**
 * S12 — confidentiality at two layers: the contract refuses non-entitled
 * classes, and the platform gives their peers nothing to read. The block that
 * every peer stores is inspected directly for the analysis content.
 */
async function s12() {
  const code = `S12-${uniq()}`;
  await fullChain(code, pseudonym());
  const analysis = await must(c.lab, 'custody', 'recordSampleAnalysisResult', {
    args: [code],
    transient: { adverse: true, substance: 'Erythropoietin', prohibitedListVersion: LIST_VERSION, prohibitedListHash: LIST_HASH, laboratoryAccreditation: 'VERIFIED' },
    endorsers: NADO_LAB,
  });
  await resultsManagement(code);

  // Each class asks its own peer, which holds only what its organisation may read.
  const ask = async () => {
    const view = {};
    for (const org of ['nado', 'lab', 'athlete', 'federation', 'research']) {
      const out = await query(c[org], 'custody', 'enforceResultsConfidentiality', [code], [c[org].msp]).catch((e) => ({ granted: false, error: chaincodeMessage(e) }));
      view[org] = out.granted === true;
    }
    return view;
  };
  const beforeNotice = await ask();
  await must(c.nado, 'custody', 'notifyAthleteOfAAF', { args: [code], endorsers: NADO_LAB });
  const afterNotice = await ask();

  // Platform layer: a federation peer asked for the internal record directly.
  let federationPeerHasNothing = false;
  try {
    await query(c.federation, 'custody', 'getResultsManagement', [code], ['FederationMSP']);
  } catch {
    federationPeerHasNothing = true;
  }
  // The block as the research peer stores it.
  const block = await c.research.contract('qscc').evaluate('GetBlockByTxID', { arguments: [CHANNEL, analysis.txId] });
  const blockText = Buffer.from(block).toString('latin1');
  const blockClean = !blockText.includes('Erythropoietin') && !blockText.includes('VERIFIED') && !blockText.includes('AAF_CONFIRMED');
  const granted = (v) => Object.entries(v).filter(([, g]) => g).map(([k]) => k).join(', ');

  record({
    id: 'S12',
    title: 'Results confidential to the NADO and laboratory until notice; notice reaches athlete and federation together',
    regulation: 'WADA Code Art. 14.1.1, 14.1.2, 14.1.5',
    steps: [
      'attested chain, adverse analysis, results management',
      'each class asks its own peer for the result',
      'NADO notifies the athlete',
      'each class asks again; federation peer asked for the internal record; block holding the analysis inspected',
    ],
    outcome:
      `before notice granted: ${granted(beforeNotice)}; after notice granted: ${granted(afterNotice)}; ` +
      `federation peer holds no internal record: ${federationPeerHasNothing}; analysis content absent from the shared block: ${blockClean}`,
    expected: 'before notice NADO and laboratory only; after notice also athlete and federation; research never; no analysis content in the shared block',
    passed:
      beforeNotice.nado && beforeNotice.lab && !beforeNotice.athlete && !beforeNotice.federation && !beforeNotice.research &&
      afterNotice.nado && afterNotice.lab && afterNotice.athlete && afterNotice.federation && !afterNotice.research &&
      federationPeerHasNothing && blockClean,
    detail: { beforeNotice, afterNotice },
  });
}

async function s13() {
  const code = `S13-${uniq()}`;
  const seal = await open(code, pseudonym());
  await acknowledge(code, seal);
  await dispatch(code, 0); // zero-hour window: any later receipt is late
  await new Promise((r) => setTimeout(r, 1500));
  await receive(code, seal);
  const chain = await query(c.nado, 'custody', 'getCustodyChain', [code]);
  await analyse(code, true, 'VERIFIED');
  const rm = await resultsManagement(code);
  record({
    id: 'S13',
    title: 'Late custody receipt raises an exception and invalidates the process',
    regulation: 'ISTI chain of custody',
    rule: rm.ruleId,
    steps: ['dispatch with a zero-hour window', 'receipt after the window', 'adverse analysis', 'results management'],
    outcome: `exceptions: ${chain.exceptions.map((e) => e.reason).join(', ')}; ${rm.action} (${rm.ruleId})`,
    expected: 'TRANSFER_WINDOW_EXCEEDED, then PROCESS_INVALIDATED',
    passed: chain.exceptions.some((e) => e.reason === 'TRANSFER_WINDOW_EXCEEDED') && rm.action === 'PROCESS_INVALIDATED',
  });
}

async function s14() {
  const code = `S14-${uniq()}`;
  const seal = await open(code, pseudonym());
  await acknowledge(code, seal);
  await dispatch(code);
  await receive(code, 'seal-of-a-different-container');
  const chain = await query(c.nado, 'custody', 'getCustodyChain', [code]);
  await analyse(code, true, 'VERIFIED');
  const rm = await resultsManagement(code);
  record({
    id: 'S14',
    title: 'A seal at receipt that differs from the seal the athlete acknowledged invalidates the process',
    regulation: 'ISTI chain of custody and sample integrity',
    rule: rm.ruleId,
    steps: ['athlete acknowledges seal A', 'laboratory reports seal B at receipt', 'adverse analysis', 'results management'],
    outcome: `exceptions: ${chain.exceptions.map((e) => e.reason).join(', ')}; ${rm.action} (${rm.ruleId})`,
    expected: 'CONTAINER_SEAL_MISMATCH, then PROCESS_INVALIDATED',
    passed: chain.exceptions.some((e) => e.reason === 'CONTAINER_SEAL_MISMATCH') && rm.action === 'PROCESS_INVALIDATED',
  });
}

async function main() {
  console.log(`regulatory scenarios against ${CHANNEL}`);
  await attempt(c.nado, 'custody', 'registerProhibitedList', { args: [LIST_VERSION, LIST_HASH], endorsers: NADO_LAB });
  const all = [
    s1,
    s2,
    () => accreditationScenario('S3', 'PENDING', 'AAF_PENDING_REVIEW', 'R2', 'Pending laboratory accreditation suspends automation', 'WADA Code Art. 7.1; GDPR Art. 22'),
    () => accreditationScenario('S4', 'UNVERIFIED', 'ANALYSIS_REJECTED', 'R2b', 'Result from a non-accredited laboratory is rejected and audited', 'WADA Code Art. 6.1 (case absent from the table as first specified)'),
    s5, s6, s7, s8, s9, s10, s11, s12, s13, s14,
  ];
  for (const s of all) {
    try {
      await s();
    } catch (error) {
      failures += 1;
      const msg = chaincodeMessage(error);
      console.log(`  FAIL  ${s.name || 'scenario'}  threw: ${msg}`);
      results.push({ id: s.name, passed: false, outcome: `threw: ${msg}` });
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ executedAt: new Date().toISOString(), channel: CHANNEL, passed: results.length - failures, failed: failures, scenarios: results }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} scenarios passed -> ${OUT}`);
  for (const conn of Object.values(c)) conn.close();
  process.exit(failures === 0 ? 0 : 1);
}

main();
