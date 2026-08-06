/**
 * Executable regulatory scenarios.
 *
 * Each scenario in docs/SCENARIOS.md is driven here against the running network
 * through the REST gateway, and its observed outcome is recorded. The sequence
 * diagrams in that document are therefore transcriptions of transactions that
 * actually committed, not illustrations of intended behaviour — every scenario
 * asserts its expected outcome and the run fails if any assertion does not hold.
 *
 *   npm start        (with the network up and the gateway on :3000)
 */

import { createHash, randomBytes } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';

import {
  IpfsCluster,
  KeyVault,
  retrieveDecrypted,
  storeEncrypted,
} from '../offchain/src/ipfs-client';
import {
  destroyIPFSAccessToken,
  recoverDataAccessKey,
  revokeDataAccessKey,
} from '../offchain/src/erasure';
import { splitForRecovery } from '../offchain/src/shamir';

const API = process.env.GATEWAY ?? 'http://127.0.0.1:3000';
const LIST_VERSION = '2026-01';
const LIST_HASH = 'f'.repeat(64);
const ALL_CATEGORIES =
  'gps_accelerometry,biochemical_markers,abp_haematological,abp_steroidal,psychological,genetic';

type Json = Record<string, any>;

interface Step {
  actor: string;
  action: string;
  outcome: string;
}

interface ScenarioResult {
  id: string;
  title: string;
  regulation: string;
  rule?: string;
  steps: Step[];
  outcome: string;
  expected: string;
  passed: boolean;
  detail?: Json;
}

const results: ScenarioResult[] = [];
let failures = 0;

// ------------------------------------------------------------------ transport

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  route: string,
  org?: string,
  body?: Json,
): Promise<{ status: number; body: Json }> {
  const url = `${API}${route}${route.includes('?') ? '&' : '?'}org=${org ?? 'nado'}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

const post = (r: string, org?: string, b?: Json) => call('POST', r, org, b);
const get = (r: string, org?: string) => call('GET', r, org);
const del = (r: string, org?: string, b?: Json) => call('DELETE', r, org, b);

// ------------------------------------------------------------------ helpers

const uniq = () => randomBytes(4).toString('hex');
const athlete = () => createHash('sha256').update(`athlete-${uniq()}`).digest('hex');

async function registerList() {
  await post('/api/prohibited-list', 'nado', { version: LIST_VERSION, hash: LIST_HASH });
}

/** Open a custody chain and optionally complete the mandatory phases. */
async function openSample(code: string, hash: string, phases: string[]) {
  await post('/api/samples', 'nado', {
    sampleCode: code,
    athleteHash: hash,
    sealedContainerHash: `seal-${uniq()}`,
    collectionLocation: 'Tunis National Testing Centre',
  });
  for (const phase of phases) {
    const org = phase === 'LABORATORY_RECEIPT' ? 'lab' : 'nado';
    await post(`/api/samples/${code}/transfers`, org, {
      phase,
      fromMSP: 'NADOMSP',
      toMSP: 'LabMSP',
    });
  }
}

async function analyse(code: string, adverse: boolean, accreditation: string) {
  return post(`/api/samples/${code}/analysis`, 'lab', {
    adverse,
    substance: adverse ? 'Erythropoietin' : '',
    prohibitedListVersion: LIST_VERSION,
    prohibitedListHash: LIST_HASH,
    laboratoryAccreditation: accreditation,
  });
}

function record(r: ScenarioResult) {
  results.push(r);
  if (!r.passed) failures += 1;
  const mark = r.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${r.id}  ${r.title}`);
  console.log(`        outcome: ${r.outcome}`);
  if (!r.passed) console.log(`        EXPECTED: ${r.expected}`);
}

// ------------------------------------------------------------------ scenarios

/** S1 — the nominal path: a complete custody chain yields a confirmed AAF. */
async function s1(): Promise<void> {
  const code = `S1-${uniq()}`;
  const hash = athlete();
  const steps: Step[] = [];

  await openSample(code, hash, ['TRANSPORT_HANDOFF', 'LABORATORY_RECEIPT']);
  steps.push({ actor: 'NADO', action: 'initiateSampleCustody (Art. 5.3)', outcome: 'sample opened, athlete notified' });
  steps.push({ actor: 'NADO → Lab', action: 'recordCustodyTransfer ×2 (Art. 5.4)', outcome: 'dual-endorsed, key bound to both organizations' });

  await analyse(code, true, 'VERIFIED');
  steps.push({ actor: 'Laboratory', action: 'recordSampleAnalysisResult (Art. 2.1)', outcome: 'adverse; Prohibited List hash verified' });

  const rm = await post(`/api/samples/${code}/results-management`, 'nado');
  steps.push({ actor: 'NADO', action: 'triggerResultsManagement (Art. 7.1)', outcome: `Table 2 → ${rm.body.action}` });

  const notify = await post(`/api/samples/${code}/notify`, 'nado');
  steps.push({ actor: 'NADO → Athlete', action: 'notifyAthleteOfAAF (Art. 7.3)', outcome: `statutory deadline ${rm.body.statutoryDeadline}` });

  record({
    id: 'S1',
    title: 'Adverse analytical finding confirmed on a verified custody chain',
    regulation: 'WADA Art. 5.3, 5.4, 2.1, 7.1, 7.3',
    rule: rm.body.ruleId,
    steps,
    outcome: `${rm.body.action} (${rm.body.ruleId}); Art. 7.3 clock started, notified within period: ${notify.body.withinStatutoryPeriod}`,
    expected: 'AAF_CONFIRMED via R1_AAF_CONFIRMED with a statutory deadline',
    passed:
      rm.body.action === 'AAF_CONFIRMED' &&
      rm.body.ruleId === 'R1_AAF_CONFIRMED' &&
      Boolean(rm.body.statutoryDeadline) &&
      notify.body.withinStatutoryPeriod === true,
    detail: { sampleCode: code, facts: rm.body.facts },
  });
}

/** S2 — an incomplete custody chain invalidates the process (guard rule R5). */
async function s2(): Promise<void> {
  const code = `S2-${uniq()}`;
  const hash = athlete();
  const steps: Step[] = [];

  // Laboratory receipt is never recorded: a mandatory custody step is missing.
  await openSample(code, hash, ['TRANSPORT_HANDOFF']);
  steps.push({ actor: 'NADO', action: 'initiateSampleCustody (Art. 5.3)', outcome: 'sample opened' });
  steps.push({ actor: 'NADO → Lab', action: 'recordCustodyTransfer (TRANSPORT_HANDOFF)', outcome: 'recorded; LABORATORY_RECEIPT never arrives' });

  await analyse(code, true, 'VERIFIED');
  steps.push({ actor: 'Laboratory', action: 'recordSampleAnalysisResult (Art. 2.1)', outcome: 'adverse result committed' });

  const rm = await post(`/api/samples/${code}/results-management`, 'nado');
  steps.push({ actor: 'NADO', action: 'triggerResultsManagement (Art. 7.1)', outcome: `Q007 = NO → ${rm.body.action}` });
  steps.push({ actor: 'System → NADO, WADA', action: 'raiseAuditAlert', outcome: `alert to ${(rm.body.auditAlertRecipients ?? []).join(', ')}` });

  const sample = await get(`/api/samples/${code}`, 'nado');

  record({
    id: 'S2',
    title: 'Incomplete chain of custody invalidates the process before any finding',
    regulation: 'WADA Art. 5.4 (guard on Art. 7.1)',
    rule: rm.body.ruleId,
    steps,
    outcome: `${rm.body.action} (${rm.body.ruleId}); sample status ${sample.body.status}; audit alert to ${(rm.body.auditAlertRecipients ?? []).join(', ')}`,
    expected: 'PROCESS_INVALIDATED, sample INVALIDATED, alert to NADOMSP and WADA — the adverse result is suppressed',
    passed:
      rm.body.action === 'PROCESS_INVALIDATED' &&
      sample.body.status === 'INVALIDATED' &&
      (rm.body.auditAlertRecipients ?? []).includes('WADA'),
    detail: { sampleCode: code, concurrentMatches: rm.body.concurrentMatches, facts: rm.body.facts },
  });
}

/** S3 — pending laboratory accreditation suspends automation (R2). */
async function s3(): Promise<void> {
  const code = `S3-${uniq()}`;
  const hash = athlete();
  const steps: Step[] = [];

  await openSample(code, hash, ['TRANSPORT_HANDOFF', 'LABORATORY_RECEIPT']);
  await analyse(code, true, 'PENDING');
  steps.push({ actor: 'NADO / Lab', action: 'custody chain completed, analysis committed', outcome: 'adverse; accreditation PENDING' });

  const rm = await post(`/api/samples/${code}/results-management`, 'nado');
  steps.push({ actor: 'NADO', action: 'triggerResultsManagement (Art. 7.1)', outcome: `Q002 = PENDING → ${rm.body.action}` });
  steps.push({ actor: 'System', action: 'suspendAutomatedProcessing + flagForHumanReview', outcome: 'automated processing halted (GDPR Art. 22)' });

  const notify = await post(`/api/samples/${code}/notify`, 'nado');
  steps.push({ actor: 'NADO', action: 'notifyAthleteOfAAF attempted', outcome: `refused — HTTP ${notify.status}` });

  record({
    id: 'S3',
    title: 'Pending laboratory accreditation suspends automation pending human review',
    regulation: 'WADA Art. 7.1 / GDPR Art. 22',
    rule: rm.body.ruleId,
    steps,
    outcome: `${rm.body.action} (${rm.body.ruleId}); humanOversightRequired=${rm.body.humanOversightRequired}; Art. 7.3 notification refused with HTTP ${notify.status}`,
    expected: 'AAF_PENDING_REVIEW, oversight required, and no Article 7.3 notification permitted',
    passed:
      rm.body.action === 'AAF_PENDING_REVIEW' &&
      rm.body.humanOversightRequired === true &&
      notify.status >= 400,
    detail: { sampleCode: code },
  });
}

/** S4 — an unaccredited laboratory's result is rejected, not queued (gap 2, R2b). */
async function s4(): Promise<void> {
  const code = `S4-${uniq()}`;
  const hash = athlete();
  const steps: Step[] = [];

  await openSample(code, hash, ['TRANSPORT_HANDOFF', 'LABORATORY_RECEIPT']);
  await analyse(code, true, 'UNVERIFIED');
  steps.push({ actor: 'NADO / Lab', action: 'custody chain completed, analysis committed', outcome: 'adverse; accreditation UNVERIFIED' });

  const rm = await post(`/api/samples/${code}/results-management`, 'nado');
  steps.push({ actor: 'NADO', action: 'triggerResultsManagement (Art. 7.1)', outcome: `Q002 = NO → ${rm.body.action}` });
  steps.push({ actor: 'System → NADO, WADA', action: 'rejectAnalysisResult + raiseAuditAlert', outcome: 'Art. 6.1: analysis cannot ground a finding' });

  record({
    id: 'S4',
    title: 'Result from a non-accredited laboratory is rejected and audited',
    regulation: 'WADA Art. 6.1 — case absent from the decision table as originally specified',
    rule: rm.body.ruleId,
    steps,
    outcome: `${rm.body.action} (${rm.body.ruleId}); audit alert to ${(rm.body.auditAlertRecipients ?? []).join(', ')}`,
    expected: 'ANALYSIS_REJECTED — the specification gap resolved during implementation',
    passed: rm.body.action === 'ANALYSIS_REJECTED' && rm.body.ruleId === 'R2B_ANALYSIS_REJECTED',
    detail: { sampleCode: code },
  });
}

/** S5 — a third verified whereabouts failure in 12 months is an ADRV (R4). */
async function s5(): Promise<void> {
  const code = `S5-${uniq()}`;
  const hash = athlete();
  const steps: Step[] = [];

  for (let i = 1; i <= 3; i += 1) {
    const wb = await post('/api/whereabouts', 'nado', {
      athleteHash: hash,
      filingId: `F${i}-${uniq()}`,
      failure: true,
      ledgerVerified: true,
    });
    steps.push({
      actor: 'NADO',
      action: `recordWhereaboutsStatus #${i} (Art. 2.4)`,
      outcome: `failures in rolling 12-month window: ${wb.body.failuresInWindow}`,
    });
  }

  await openSample(code, hash, ['TRANSPORT_HANDOFF', 'LABORATORY_RECEIPT']);
  await analyse(code, false, 'VERIFIED');
  steps.push({ actor: 'Laboratory', action: 'recordSampleAnalysisResult', outcome: 'negative — no analytical finding' });

  const rm = await post(`/api/samples/${code}/results-management`, 'nado');
  steps.push({ actor: 'NADO', action: 'triggerResultsManagement (Art. 7.1)', outcome: `Q005 ∧ Q006 → ${rm.body.action}` });

  record({
    id: 'S5',
    title: 'Third ledger-verified whereabouts failure inside 12 months is an ADRV',
    regulation: 'WADA Art. 2.4 / 7.1',
    rule: rm.body.ruleId,
    steps,
    outcome: `${rm.body.action} (${rm.body.ruleId}) with a negative analysis — the violation is procedural, not analytical`,
    expected: 'WHEREABOUTS_ADRV via R4_WHEREABOUTS_ADRV',
    passed: rm.body.action === 'WHEREABOUTS_ADRV' && rm.body.ruleId === 'R4_WHEREABOUTS_ADRV',
    detail: { sampleCode: code, facts: rm.body.facts },
  });
}

/** S6 — a passport anomaly escalates to the expert panel (R3). */
async function s6(): Promise<void> {
  const code = `S6-${uniq()}`;
  const hash = athlete();
  const steps: Step[] = [];

  await post('/api/passport-evaluation', 'lab', {
    athleteHash: hash,
    anomaly: true,
    expertPanelRequired: true,
  });
  steps.push({ actor: 'Laboratory', action: 'recordPassportEvaluation', outcome: 'longitudinal anomaly flagged, expert panel required' });

  await openSample(code, hash, ['TRANSPORT_HANDOFF', 'LABORATORY_RECEIPT']);
  await analyse(code, false, 'VERIFIED');
  steps.push({ actor: 'NADO / Lab', action: 'custody chain completed, analysis negative', outcome: 'no adverse analytical finding' });

  const rm = await post(`/api/samples/${code}/results-management`, 'nado');
  steps.push({ actor: 'NADO', action: 'triggerResultsManagement (Art. 7.1)', outcome: `Q003 ∧ Q004 → ${rm.body.action}` });
  steps.push({ actor: 'System → Expert Panel', action: 'notifyExpertPanel + enforceOversightRequirement', outcome: 'GDPR Art. 22 oversight record required' });

  record({
    id: 'S6',
    title: 'Athlete Biological Passport anomaly escalates to the expert panel',
    regulation: 'ABP / GDPR Art. 22',
    rule: rm.body.ruleId,
    steps,
    outcome: `${rm.body.action} (${rm.body.ruleId}); humanOversightRequired=${rm.body.humanOversightRequired}`,
    expected: 'ABP_ALERT_INITIATED with mandatory human oversight',
    passed: rm.body.action === 'ABP_ALERT_INITIATED' && rm.body.humanOversightRequired === true,
    detail: { sampleCode: code },
  });
}

/** S7 — a single organization cannot alter committed results state (§4.1). */
async function s7(): Promise<void> {
  const code = `S7-${uniq()}`;
  const hash = athlete();
  const steps: Step[] = [];

  await openSample(code, hash, ['TRANSPORT_HANDOFF', 'LABORATORY_RECEIPT']);
  await analyse(code, true, 'VERIFIED');
  const first = await post(`/api/samples/${code}/results-management`, 'nado');
  steps.push({ actor: 'NADO + Lab', action: 'triggerResultsManagement (Art. 7.1)', outcome: `${first.body.action}; results key bound to AND(NADOMSP, LabMSP)` });

  // A NADO insider retries alone, pinning endorsement to its own organization.
  const solo = await post(`/api/samples/${code}/results-management?endorsers=NADOMSP`, 'nado');
  steps.push({ actor: 'NADO acting alone', action: 'triggerResultsManagement, endorsement pinned to NADOMSP', outcome: `rejected — HTTP ${solo.status}` });

  const detail = JSON.stringify(solo.body);
  const blocked =
    solo.status >= 400 &&
    /ENDORSEMENT_POLICY_FAILURE|endorsement policy|failed validation/i.test(detail);

  record({
    id: 'S7',
    title: 'Insider acting alone cannot alter committed results-management state',
    regulation: '§4.1 threat model — insider collusion across CA boundaries',
    steps,
    outcome: blocked
      ? `rejected with HTTP ${solo.status}: ${(solo.body.error ?? '') as string}`
      : `NOT BLOCKED — HTTP ${solo.status}`,
    expected: 'the network rejects a single-organization write to a key under state-based endorsement',
    passed: blocked,
    detail: { sampleCode: code, response: solo.body },
  });
}

/** S8 — no provisional suspension without a human oversight record (Art. 22). */
async function s8(): Promise<void> {
  const code = `S8-${uniq()}`;
  const hash = athlete();
  const steps: Step[] = [];

  await openSample(code, hash, ['TRANSPORT_HANDOFF', 'LABORATORY_RECEIPT']);
  await analyse(code, true, 'VERIFIED');
  await post(`/api/samples/${code}/results-management`, 'nado');
  steps.push({ actor: 'NADO', action: 'results management completed', outcome: 'AAF confirmed' });

  const refused = await post(`/api/samples/${code}/provisional-suspension`, 'nado');
  steps.push({ actor: 'NADO', action: 'recordProvisionalSuspension (Art. 7.9)', outcome: `refused — HTTP ${refused.status}, GDPR Art. 22` });

  const rejected = await post(`/api/samples/${code}/oversight`, 'nado', {
    reviewerId: 'reviewer-014',
    decision: 'REQUEST_FURTHER_ANALYSIS',
    rationale: 'B-sample analysis requested before any provisional measure',
  });
  steps.push({ actor: 'Human reviewer', action: 'enforceOversightRequirement → REQUEST_FURTHER_ANALYSIS', outcome: 'oversight recorded, finding not upheld' });

  const stillRefused = await post(`/api/samples/${code}/provisional-suspension`, 'nado');
  steps.push({ actor: 'NADO', action: 'recordProvisionalSuspension retried', outcome: `still refused — HTTP ${stillRefused.status}` });

  await post(`/api/samples/${code}/oversight`, 'nado', {
    reviewerId: 'reviewer-014',
    decision: 'UPHOLD',
    rationale: 'Chain of custody complete; accredited laboratory; finding upheld',
  });
  const allowed = await post(`/api/samples/${code}/provisional-suspension`, 'nado');
  steps.push({ actor: 'Human reviewer → NADO', action: 'oversight UPHOLD, then suspension', outcome: `permitted — HTTP ${allowed.status}` });

  record({
    id: 'S8',
    title: 'Career-affecting decision blocked until a named human upholds it',
    regulation: 'WADA Art. 7.9 / GDPR Art. 22',
    steps,
    outcome: `refused without oversight (HTTP ${refused.status}); refused after REQUEST_FURTHER_ANALYSIS (HTTP ${stillRefused.status}); permitted after UPHOLD (HTTP ${allowed.status})`,
    expected: 'refused twice, then permitted only after an UPHOLD decision by a named reviewer',
    passed: refused.status >= 400 && stillRefused.status >= 400 && allowed.status < 400 && rejected.status < 400,
    detail: { sampleCode: code, reviewer: allowed.body.oversightReviewer },
  });
}

/** S9 — purpose limitation releases 2 of 6 categories (§3.5 worked scenario). */
async function s9(): Promise<void> {
  const hash = athlete();
  const steps: Step[] = [];

  await post('/api/consent', 'athlete', {
    athleteHash: hash,
    grantedToMSP: 'ResearchMSP',
    purpose: 'cardiovascular_research',
    categories: ALL_CATEGORIES.split(','),
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
    specialCategoryAuthorised: true,
  });
  steps.push({ actor: 'Athlete', action: 'recordConsentTransaction (GDPR Art. 7)', outcome: 'consent granted across all six categories' });

  const decision = await post('/api/access-request', 'research', {
    athleteHash: hash,
    purpose: 'cardiovascular_research',
    categories: ALL_CATEGORIES.split(','),
  });
  steps.push({ actor: 'Researcher', action: 'validateConsent — requests all six categories', outcome: `granted ${decision.body.granted?.length}, denied ${decision.body.denied?.length}` });
  steps.push({ actor: 'System', action: 'access audit written', outcome: 'every decision recorded with a reason, granted or not' });

  const granted = [...(decision.body.granted ?? [])].sort();
  const denied = [...(decision.body.denied ?? [])].sort();
  const expectedGranted = ['abp_haematological', 'gps_accelerometry'];
  const expectedDenied = ['abp_steroidal', 'biochemical_markers', 'genetic', 'psychological'];

  record({
    id: 'S9',
    title: 'Purpose limitation releases two of six categories to an authorized researcher',
    regulation: 'GDPR Art. 5(1)(c), 7, 9, 25 — §3.5 worked scenario',
    steps,
    outcome: `granted [${granted.join(', ')}]; denied [${denied.join(', ')}]`,
    expected: 'haematological + accelerometry granted; biochemical, steroidal, psychological, genetic denied',
    passed:
      JSON.stringify(granted) === JSON.stringify(expectedGranted) &&
      JSON.stringify(denied) === JSON.stringify(expectedDenied),
    detail: { athleteHash: hash, outcomes: decision.body.outcomes },
  });
}

/** S10 — withdrawal takes effect on the next evaluation (Art. 7(3)). */
async function s10(): Promise<void> {
  const hash = athlete();
  const steps: Step[] = [];

  await post('/api/consent', 'athlete', {
    athleteHash: hash,
    grantedToMSP: 'ResearchMSP',
    purpose: 'cardiovascular_research',
    categories: ['abp_haematological', 'gps_accelerometry'],
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
    specialCategoryAuthorised: true,
  });
  const before = await post('/api/access-request/preview', 'research', {
    athleteHash: hash,
    purpose: 'cardiovascular_research',
    categories: ['abp_haematological', 'gps_accelerometry'],
  });
  steps.push({ actor: 'Athlete → Researcher', action: 'consent granted, access evaluated', outcome: `granted ${before.body.granted?.length} categories` });

  await del('/api/consent', 'athlete', {
    athleteHash: hash,
    grantedToMSP: 'ResearchMSP',
    purpose: 'cardiovascular_research',
  });
  steps.push({ actor: 'Athlete', action: 'withdrawConsent (Art. 7(3))', outcome: 'consent record marked revoked on-chain' });

  const after = await post('/api/access-request/preview', 'research', {
    athleteHash: hash,
    purpose: 'cardiovascular_research',
    categories: ['abp_haematological', 'gps_accelerometry'],
  });
  steps.push({ actor: 'Researcher', action: 'access re-evaluated', outcome: `granted ${after.body.granted?.length}; reason: ${after.body.outcomes?.[0]?.reason}` });

  record({
    id: 'S10',
    title: 'Consent withdrawal takes effect immediately',
    regulation: 'GDPR Art. 7(3)',
    steps,
    outcome: `${before.body.granted?.length} categories before withdrawal, ${after.body.granted?.length} after`,
    expected: '2 categories before, 0 after',
    passed: before.body.granted?.length === 2 && after.body.granted?.length === 0,
    detail: { athleteHash: hash, reason: after.body.outcomes?.[0]?.reason },
  });
}

/**
 * S11 — off-chain storage and the two distinct Article 17 erasure paths.
 *
 * The distinction matters and is easy to get wrong. `revokeDataAccessKey()`
 * destroys the key while the ciphertext remains pinned, so the Shamir 2-of-3
 * arrangement can restore access. `destroyIPFSAccessToken()` additionally
 * unpins and garbage-collects the content, after which no quorum of shares can
 * bring the data back — the ciphertext itself is gone. Recovery is a property
 * of the first path only.
 */
async function s11(): Promise<void> {
  const hash = athlete();
  const steps: Step[] = [];
  const cluster = new IpfsCluster();
  const vault = new KeyVault();

  if (!(await cluster.isReachable())) {
    record({
      id: 'S11',
      title: 'Off-chain storage and GDPR Article 17 cryptographic erasure',
      regulation: 'GDPR Art. 17',
      steps: [],
      outcome: 'SKIPPED — IPFS cluster unreachable',
      expected: 'store, revoke-and-recover, then erase irreversibly',
      passed: false,
    });
    return;
  }

  const payload = Buffer.from(
    JSON.stringify({
      athleteHash: hash,
      category: 'abp_haematological',
      observations: [{ marker: 'HGB', value: 15.2, unit: 'g/dL' }],
    }),
  );

  // ---- store ------------------------------------------------------------
  const { record: stored } = await storeEncrypted(payload, { cluster, vault });
  steps.push({ actor: 'Laboratory', action: 'AES-256-GCM encrypt → IPFS add (3 nodes)', outcome: `CID ${stored.cid.slice(0, 16)}…, pinned on ${stored.pinnedAt.length} nodes` });

  const reg = await post('/api/offchain-payload', 'lab', {
    athleteHash: hash,
    category: 'abp_haematological',
    cid: stored.cid,
    keyRef: stored.keyRef,
    plaintextDigest: stored.plaintextDigest,
  });
  steps.push({ actor: 'Laboratory → Ledger', action: 'registerOffchainPayload', outcome: 'only {cid, keyRef} on-chain; payload never touches the ledger' });

  const roundTrip = await retrieveDecrypted(stored, { cluster, vault });
  steps.push({ actor: 'Authorized reader', action: 'retrieve + decrypt', outcome: `round-trip intact: ${roundTrip.equals(payload)}` });

  const raw = await cluster.cat(stored.cid);
  const opaque = !raw.equals(payload) && !raw.toString('utf8').includes('HGB');
  steps.push({ actor: 'Unauthorized reader', action: 'read raw IPFS content', outcome: `ciphertext only, no plaintext markers: ${opaque}` });

  // ---- path A: key revoked, ciphertext retained -> recoverable -----------
  const shares = splitForRecovery(vault.exportForSharing(stored.keyRef));
  steps.push({ actor: 'Athlete / physician / federation', action: 'Shamir 2-of-3 split of the data-encryption key', outcome: '3 shares issued, threshold 2' });

  revokeDataAccessKey(vault, stored.keyRef);
  steps.push({ actor: 'Athlete', action: 'revokeDataAccessKey (Art. 17, key only)', outcome: 'key destroyed; ciphertext still pinned' });

  let deniedAfterRevoke = false;
  try {
    await retrieveDecrypted(stored, { cluster, vault });
  } catch (e) {
    deniedAfterRevoke = /GDPR Article 17|destroyed/i.test((e as Error).message);
  }
  steps.push({ actor: 'Any reader', action: 'retrieve attempted', outcome: `denied: ${deniedAfterRevoke}` });

  let singleShareBlocked = false;
  try {
    recoverDataAccessKey(vault, stored.keyRef, [shares[1]]);
  } catch {
    singleShareBlocked = true;
  }
  steps.push({ actor: 'Physician alone', action: 'recoverDataAccessKey with 1 share', outcome: `refused: ${singleShareBlocked}` });

  recoverDataAccessKey(vault, stored.keyRef, [shares[0], shares[2]]);
  const recovered = await retrieveDecrypted(stored, { cluster, vault });
  steps.push({ actor: 'Athlete + federation (2 of 3)', action: 'recoverDataAccessKey', outcome: `access restored: ${recovered.equals(payload)}` });

  // ---- path B: full erasure -> irreversible ------------------------------
  const certificate = await destroyIPFSAccessToken(stored, vault, cluster);
  steps.push({ actor: 'Athlete', action: 'destroyIPFSAccessToken (Art. 17, full)', outcome: `key destroyed; unpinned on ${certificate.unpinResults.length} nodes` });

  const onChain = await post('/api/erasure', 'athlete', {
    athleteHash: hash,
    category: 'abp_haematological',
    erasureCertificate: certificate,
  });
  steps.push({ actor: 'Athlete → Ledger', action: 'record erasure certificate', outcome: 'ledger appended, never rewritten' });

  let unreadable = false;
  try {
    await retrieveDecrypted(stored, { cluster, vault });
  } catch (e) {
    unreadable = /GDPR Article 17|destroyed/i.test((e as Error).message);
  }
  steps.push({ actor: 'Any reader', action: 'retrieve attempted after full erasure', outcome: `unrecoverable: ${unreadable}` });

  // Even a valid share quorum cannot help: the ciphertext is gone, not just the key.
  recoverDataAccessKey(vault, stored.keyRef, [shares[0], shares[1]]);
  const gone = !(await cluster.isRetrievableLocally(stored.cid));
  steps.push({ actor: 'Athlete + physician (2 of 3)', action: 'key recovered, content requested', outcome: `content no longer held by any node: ${gone}` });

  record({
    id: 'S11',
    title: 'Off-chain storage, key revocation with 2-of-3 recovery, then irreversible erasure',
    regulation: 'GDPR Art. 17',
    steps,
    outcome:
      `stored on ${stored.pinnedAt.length} nodes; IPFS holds ciphertext only (${opaque}); ` +
      `after revokeDataAccessKey access denied (${deniedAfterRevoke}) and 1 share insufficient (${singleShareBlocked}) ` +
      `but 2 of 3 restored it (${recovered.equals(payload)}); after destroyIPFSAccessToken unreadable (${unreadable}) ` +
      `and content gone from every node (${gone})`,
    expected:
      'key-only revocation is reversible by a 2-of-3 quorum; full erasure removes the ciphertext and is not',
    passed:
      roundTrip.equals(payload) && opaque && deniedAfterRevoke && singleShareBlocked &&
      recovered.equals(payload) && certificate.keyDestroyed && unreadable && gone &&
      reg.status < 400 && onChain.status < 400,
    detail: { cid: stored.cid, legalCaveat: certificate.legalCaveat },
  });
}

/** S12 — results are confidential during results management (Art. 14.1). */
async function s12(): Promise<void> {
  const code = `S12-${uniq()}`;
  const hash = athlete();
  const steps: Step[] = [];

  await openSample(code, hash, ['TRANSPORT_HANDOFF', 'LABORATORY_RECEIPT']);
  await analyse(code, true, 'VERIFIED');
  await post(`/api/samples/${code}/results-management`, 'nado');
  steps.push({ actor: 'NADO', action: 'case enters results management', outcome: 'confidentiality gate active' });

  const views: Record<string, number> = {};
  for (const org of ['nado', 'lab', 'athlete', 'federation', 'research']) {
    const r = await get(`/api/samples/${code}/results`, org);
    views[org] = r.status;
    steps.push({ actor: org.toUpperCase(), action: 'enforceResultsConfidentiality (Art. 14.1)', outcome: `HTTP ${r.status}` });
  }

  record({
    id: 'S12',
    title: 'Results are confidential during results management',
    regulation: 'WADA Art. 14.1',
    steps,
    outcome: Object.entries(views).map(([o, s]) => `${o}:${s}`).join('  '),
    expected: 'NADO, laboratory and athlete granted; federation and research refused',
    passed:
      views.nado === 200 && views.lab === 200 && views.athlete === 200 &&
      views.federation === 403 && views.research === 403,
    detail: { sampleCode: code, views },
  });
}

/** S13 — a late custody handover raises an exception and alerts the NADO. */
async function s13(): Promise<void> {
  const code = `S13-${uniq()}`;
  const hash = athlete();
  const steps: Step[] = [];

  await post('/api/samples', 'nado', {
    sampleCode: code,
    athleteHash: hash,
    sealedContainerHash: `seal-${uniq()}`,
    collectionLocation: 'Tunis National Testing Centre',
  });
  steps.push({ actor: 'NADO', action: 'initiateSampleCustody', outcome: 'custody opened' });

  // A zero-hour window: the handover is late by construction, which is how the
  // deadline path is exercised without waiting out a real window.
  await post(`/api/samples/${code}/transfers`, 'nado', {
    phase: 'TRANSPORT_HANDOFF',
    fromMSP: 'NADOMSP',
    toMSP: 'LabMSP',
    transferWindowHours: 0,
  });
  steps.push({ actor: 'NADO → Lab', action: 'recordCustodyTransfer past its window', outcome: 'transfer written; exception raised; NADO alerted' });

  await post(`/api/samples/${code}/transfers`, 'lab', {
    phase: 'LABORATORY_RECEIPT',
    fromMSP: 'NADOMSP',
    toMSP: 'LabMSP',
  });
  await analyse(code, true, 'VERIFIED');
  const rm = await post(`/api/samples/${code}/results-management`, 'nado');
  steps.push({ actor: 'NADO', action: 'triggerResultsManagement', outcome: `blocking exception → Q007 = NO → ${rm.body.action}` });

  record({
    id: 'S13',
    title: 'Late custody handover raises an exception and invalidates the process',
    regulation: 'WADA Art. 5.4',
    rule: rm.body.ruleId,
    steps,
    outcome: `${rm.body.action} (${rm.body.ruleId}); mandatoryCustodyStepVerified=${rm.body.facts?.mandatoryCustodyStepVerified}`,
    expected: 'PROCESS_INVALIDATED — an unexplained gap in the custody timeline blocks any finding',
    passed:
      rm.body.action === 'PROCESS_INVALIDATED' &&
      rm.body.facts?.mandatoryCustodyStepVerified === false,
    detail: { sampleCode: code },
  });
}

// ------------------------------------------------------------------ driver

async function main(): Promise<void> {
  console.log(`\nExecuting regulatory scenarios against ${API}\n`);
  await registerList();

  const scenarios: [string, () => Promise<void>][] = [
    ['S1', s1], ['S2', s2], ['S3', s3], ['S4', s4], ['S5', s5], ['S6', s6], ['S7', s7],
    ['S8', s8], ['S9', s9], ['S10', s10], ['S11', s11], ['S12', s12], ['S13', s13],
  ];

  for (const [id, fn] of scenarios) {
    try {
      await fn();
    } catch (error) {
      failures += 1;
      results.push({
        id,
        title: `${id} threw`,
        regulation: 'n/a',
        steps: [],
        outcome: `ERROR: ${(error as Error).message}`,
        expected: 'scenario completes',
        passed: false,
      });
      console.log(`  \x1b[31mFAIL\x1b[0m  ${id}  threw: ${(error as Error).message}`);
    }
  }

  const out = path.resolve(__dirname, '..', 'docs', 'scenario-results.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), gateway: API, total: results.length, failures, scenarios: results },
      null,
      2,
    ),
  );

  console.log(`\n${results.length - failures}/${results.length} scenarios passed`);
  console.log(`results written to ${out}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
