'use strict';

/**
 * The insider test, run against the design as previously reported (custodyv1)
 * and as revised (custody), in the two forms the reviewer distinguished:
 *
 *   pinned  — the NADO client asks only its own peer to endorse, which is the
 *             form the earlier test used;
 *   both    — the NADO client asks the NADO and the laboratory peers to
 *             endorse, which is what a real insider would do.
 *
 * Two acts are attempted in each form: overwriting a committed
 * results-management record, and recording the laboratory's receipt of a
 * sample on the laboratory's behalf. Results go to
 * docs/insider-comparison.json.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { connectOrg, transact, query, chaincodeMessage } = require('./lib/fabric');

const OUT = process.env.INSIDER_OUT || path.resolve(__dirname, '../docs/insider-comparison.json');
const NADO_LAB = ['NADOMSP', 'LabMSP'];
const LIST = ['2026-01', 'f'.repeat(64)];
const VALIDATION = { 0: 'VALID', 10: 'ENDORSEMENT_POLICY_FAILURE', 11: 'MVCC_READ_CONFLICT' };

const nado = connectOrg('nado');
const lab = connectOrg('lab');
const athlete = connectOrg('athlete');
const uniq = () => crypto.randomBytes(4).toString('hex');
const pseudonym = () => crypto.randomBytes(32).toString('hex');

async function attempt(conn, cc, fn, opts) {
  try {
    const r = await transact(conn, cc, fn, opts);
    return r.valid ? 'COMMITTED' : VALIDATION[r.code] || `code ${r.code}`;
  } catch (error) {
    return `REFUSED BY CHAINCODE: ${chaincodeMessage(error).replace(/chaincode response 500, /g, '').split(';')[0]}`;
  }
}

async function ok(conn, cc, fn, opts) {
  const r = await transact(conn, cc, fn, opts);
  if (!r.valid) throw new Error(`${fn} -> ${VALIDATION[r.code] || r.code}`);
  return r;
}

// ------------------------------------------------------------- previously reported design

async function v1Sample(withReceipt) {
  const code = `V1-${uniq()}`;
  await ok(nado, 'custodyv1', 'initiateSampleCustody', { args: [code, pseudonym(), 'seal', 'Tunis'], endorsers: ['NADOMSP'] });
  await ok(nado, 'custodyv1', 'recordCustodyTransfer', { args: [code, 'TRANSPORT_HANDOFF', 'NADOMSP', 'LabMSP', 'true', '48'], endorsers: NADO_LAB });
  if (withReceipt) {
    await ok(lab, 'custodyv1', 'recordCustodyTransfer', { args: [code, 'LABORATORY_RECEIPT', 'NADOMSP', 'LabMSP', 'true', '48'], endorsers: NADO_LAB });
  }
  return code;
}

async function v1() {
  await attempt(nado, 'custodyv1', 'registerProhibitedList', { args: LIST, endorsers: ['NADOMSP'] });
  const out = {};
  for (const form of ['pinned', 'both']) {
    const endorsers = form === 'pinned' ? ['NADOMSP'] : NADO_LAB;
    // Overwrite committed results management.
    const code = await v1Sample(true);
    await ok(lab, 'custodyv1', 'recordSampleAnalysisResult', { args: [code, 'true', 'EPO', ...LIST, 'VERIFIED'], endorsers: NADO_LAB });
    await ok(nado, 'custodyv1', 'triggerResultsManagement', { args: [code], endorsers: NADO_LAB });
    const before = await query(nado, 'custodyv1', 'getResultsManagement', [code]);
    const overwrite = await attempt(nado, 'custodyv1', 'triggerResultsManagement', { args: [code], endorsers });
    const after = await query(nado, 'custodyv1', 'getResultsManagement', [code]);
    // Record the laboratory's receipt as the NADO.
    const code2 = await v1Sample(false);
    const receipt = await attempt(nado, 'custodyv1', 'recordCustodyTransfer', {
      args: [code2, 'LABORATORY_RECEIPT', 'NADOMSP', 'LabMSP', 'true', '48'],
      endorsers,
    });
    const chain = await query(nado, 'custodyv1', 'getCustodyChain', [code2]);
    out[form] = {
      overwriteResultsManagement: overwrite,
      resultsRecordReplaced: before.decidedAt !== after.decidedAt,
      recordLaboratoryReceiptAsNado: receipt,
      receiptOnLedgerSubmittedBy: (chain.find((e) => e.phase === 'LABORATORY_RECEIPT') || {}).submittingMSP || null,
    };
  }
  return out;
}

// ------------------------------------------------------------- revised design

async function v2() {
  await attempt(nado, 'custody', 'registerProhibitedList', { args: LIST, endorsers: NADO_LAB });
  const out = {};
  for (const form of ['pinned', 'both']) {
    const endorsers = form === 'pinned' ? ['NADOMSP'] : NADO_LAB;
    const code = `V2-${uniq()}`;
    await ok(nado, 'custody', 'initiateSampleCustody', { args: [code, pseudonym(), 'seal', 'dcf'], endorsers: NADO_LAB });
    await ok(athlete, 'custody', 'acknowledgeSampleCollection', { args: [code, 'seal'], endorsers: ['AthleteMSP', 'NADOMSP'] });
    await ok(nado, 'custody', 'proposeCustodyTransfer', { args: [code, 'LabMSP', 'true', '48'], endorsers: NADO_LAB });
    await ok(lab, 'custody', 'acceptCustodyTransfer', { args: [code, '1', 'true', 'seal'], endorsers: NADO_LAB });
    await ok(lab, 'custody', 'recordSampleAnalysisResult', {
      args: [code],
      transient: { adverse: true, substance: 'EPO', prohibitedListVersion: LIST[0], prohibitedListHash: LIST[1], laboratoryAccreditation: 'VERIFIED' },
      endorsers: NADO_LAB,
    });
    await ok(nado, 'custody', 'triggerResultsManagement', { args: [code], endorsers: NADO_LAB });
    const before = await query(nado, 'custody', 'getResultsManagement', [code]);
    const overwrite = await attempt(nado, 'custody', 'triggerResultsManagement', { args: [code], endorsers });
    const after = await query(nado, 'custody', 'getResultsManagement', [code]);

    const code2 = `V2b-${uniq()}`;
    await ok(nado, 'custody', 'initiateSampleCustody', { args: [code2, pseudonym(), 'seal', 'dcf'], endorsers: NADO_LAB });
    await ok(nado, 'custody', 'proposeCustodyTransfer', { args: [code2, 'LabMSP', 'true', '48'], endorsers: NADO_LAB });
    const receipt = await attempt(nado, 'custody', 'acceptCustodyTransfer', { args: [code2, '1', 'true', 'seal'], endorsers });
    const chain = await query(nado, 'custody', 'getCustodyChain', [code2]);
    out[form] = {
      overwriteResultsManagement: overwrite,
      resultsRecordReplaced: before.decidedAt !== after.decidedAt,
      recordLaboratoryReceiptAsNado: receipt,
      receiptOnLedgerSubmittedBy: (chain.events.find((e) => e.phase === 'LABORATORY_RECEIPT') || {}).submittingMSP || null,
    };
  }
  return out;
}

(async () => {
  const result = { executedAt: new Date().toISOString(), previouslyReported: await v1(), revised: await v2() };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  for (const c of [nado, lab, athlete]) c.close();
})().catch((e) => {
  console.error(chaincodeMessage(e));
  process.exit(1);
});
