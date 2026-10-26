'use strict';

/**
 * Workloads: one per regulated operation. Each describes how to provision the
 * state its transactions need (untimed) and how to build the i-th measured
 * transaction. Every worker writes only keys carrying its own tag, so
 * concurrent transactions never contend on a key and the measurement is of
 * capacity, not of the MVCC conflict rate.
 */

const crypto = require('crypto');

const NADO_LAB = ['NADOMSP', 'LabMSP'];
const LIST = { version: '2026-01', hash: 'f'.repeat(64) };
const pseudonym = () => crypto.randomBytes(32).toString('hex');

function facts(i) {
  // Cycle through the condition space so every rule is exercised by the read workload.
  const acc = ['VERIFIED', 'PENDING', 'UNVERIFIED'][i % 3];
  return JSON.stringify({
    sampleAnalysisPositive: (i & 1) === 0,
    laboratoryAccreditation: acc,
    longitudinalProfileAnomaly: (i & 2) === 0,
    expertPanelReviewRequired: (i & 4) === 0,
    thirdWhereaboutsFailure: (i & 8) === 0,
    allFailuresLedgerVerified: (i & 16) === 0,
    mandatoryCustodyStepVerified: (i & 32) === 0,
  });
}

/** Steps that bring a sample to a given custody stage, in order. */
const STAGES = {
  initiated: ['initiate'],
  acknowledged: ['initiate', 'acknowledge'],
  dispatched: ['initiate', 'acknowledge', 'dispatch'],
  received: ['initiate', 'acknowledge', 'dispatch', 'accept'],
  analysed: ['initiate', 'acknowledge', 'dispatch', 'accept', 'analysis'],
};

/** The transaction for one custody step on sample `code`. */
function step(name, code, ctx) {
  switch (name) {
    case 'initiate':
      return { org: 'nado', cc: ctx.custody, fn: 'initiateSampleCustody', args: [code, ctx.athlete(code), `seal-${code}`, 'dcf'], endorsers: ctx.endorsers || NADO_LAB };
    case 'acknowledge':
      return { org: 'athlete', cc: 'custody', fn: 'acknowledgeSampleCollection', args: [code, `seal-${code}`], endorsers: ['AthleteMSP', 'NADOMSP'] };
    case 'dispatch':
      return { org: 'nado', cc: 'custody', fn: 'proposeCustodyTransfer', args: [code, 'LabMSP', 'true', '48'], endorsers: NADO_LAB };
    case 'accept':
      return { org: 'lab', cc: 'custody', fn: 'acceptCustodyTransfer', args: [code, '1', 'true', `seal-${code}`], endorsers: NADO_LAB };
    case 'analysis':
      return {
        org: 'lab',
        cc: 'custody',
        fn: 'recordSampleAnalysisResult',
        args: [code],
        transient: { adverse: true, substance: 'Erythropoietin', prohibitedListVersion: LIST.version, prohibitedListHash: LIST.hash, laboratoryAccreditation: 'VERIFIED' },
        endorsers: NADO_LAB,
      };
    case 'results':
      return { org: 'nado', cc: 'custody', fn: 'triggerResultsManagement', args: [code], endorsers: NADO_LAB };
    default:
      throw new Error(`unknown step ${name}`);
  }
}

/**
 * A workload operating on custody samples: provision each sample to
 * `stage`, then measure `measured` on it.
 */
function custodyWorkload(label, stage, measured, extra = {}) {
  return {
    label,
    kind: 'write',
    needsPool: stage !== null,
    provisionSteps: stage ? STAGES[stage] : [],
    build: (code, ctx) => step(measured, code, { ...ctx, ...extra }),
  };
}

const WORKLOADS = {
  initiateSampleCustody: custodyWorkload('initiateSampleCustody', null, 'initiate'),
  initiateOr1: custodyWorkload('initiateSampleCustody, one-organisation endorsement', null, 'initiate', { custody: 'custodyor', endorsers: ['NADOMSP'] }),
  initiateOr2: custodyWorkload('initiateSampleCustody, two-organisation endorsement', null, 'initiate', { custody: 'custodyor', endorsers: NADO_LAB }),
  acknowledgeSampleCollection: custodyWorkload('acknowledgeSampleCollection', 'initiated', 'acknowledge'),
  proposeCustodyTransfer: custodyWorkload('proposeCustodyTransfer', 'acknowledged', 'dispatch'),
  acceptCustodyTransfer: custodyWorkload('acceptCustodyTransfer', 'dispatched', 'accept'),
  recordSampleAnalysisResult: custodyWorkload('recordSampleAnalysisResult', 'received', 'analysis'),
  triggerResultsManagement: custodyWorkload('triggerResultsManagement', 'analysed', 'results'),
  recordWhereaboutsStatus: {
    label: 'recordWhereaboutsStatus',
    kind: 'write',
    needsPool: false,
    provisionSteps: [],
    build: (code) => ({
      org: 'nado',
      cc: 'custody',
      fn: 'recordWhereaboutsStatus',
      args: [],
      transient: { athleteHash: pseudonym(), filingId: code, failure: true, ledgerVerified: true },
      endorsers: NADO_LAB,
    }),
  },
  validateConsent: {
    label: 'validateConsent',
    kind: 'write',
    needsPool: false,
    provisionSteps: [],
    setup: 'consent',
    build: (code, ctx) => ({
      org: 'research',
      cc: 'consent',
      fn: 'validateConsent',
      args: [],
      transient: { athleteHash: ctx.consentAthlete, declaredPurpose: 'cardiovascular_research', requestedCategories: ['abp_haematological', 'gps_accelerometry', 'genetic', 'psychological', 'abp_steroidal', 'biochemical_markers'] },
      endorsers: ['AthleteMSP'],
    }),
  },
  evaluateDecisionTable: {
    label: 'evaluateDecisionTable',
    kind: 'read',
    needsPool: false,
    provisionSteps: [],
    build: (code, ctx, i) => ({ org: 'nado', cc: 'custody', fn: 'evaluateDecisionTable', args: [facts(i)], endorsers: ['NADOMSP'] }),
  },
  getCustodyChain: {
    label: 'getCustodyChain',
    kind: 'read',
    needsPool: true,
    reusePool: true,
    provisionSteps: STAGES.received,
    build: (code) => ({ org: 'nado', cc: 'custody', fn: 'getCustodyChain', args: [code], endorsers: ['NADOMSP'] }),
  },
  previewConsentDecision: {
    label: 'previewConsentDecision',
    kind: 'read',
    needsPool: false,
    provisionSteps: [],
    setup: 'consent',
    build: (code, ctx) => ({
      org: 'research',
      cc: 'consent',
      fn: 'previewConsentDecision',
      args: [ctx.consentAthlete, 'cardiovascular_research', 'abp_haematological,gps_accelerometry,genetic'],
      endorsers: ['AthleteMSP'],
    }),
  },
};

module.exports = { WORKLOADS, step, LIST, NADO_LAB, pseudonym };
