/**
 * Unit tests for the chain-of-custody contract.
 *
 * Beyond organisational-class authorisation and the regulatory preconditions,
 * these cover the three properties that endorsement alone does not give:
 * two-party attestation of every handover and of every change to a committed
 * results-management record; confidentiality of results-management state
 * (nothing private reaches public state, events or responses); and bounded,
 * monotonic transaction time.
 */

import { expect } from 'chai';
import { Context } from 'fabric-contract-api';
import { KeyEndorsementPolicy } from 'fabric-shim';
import { CustodyContract, setPeerClockForTesting } from '../src/custodyContract';
import { ResultsAction } from '../src/resultsDecision';
import { RESULTS_COLLECTION } from '../src/types';
import { asOrg, mockContext, MockStub } from './mockContext';

const SAMPLE = 'SMP-2026-000123';
const ATHLETE = 'a'.repeat(64); // keyed pseudonym (HMAC-SHA-256, hex)
const SEAL = 'seal-' + 'b'.repeat(32);
const LIST_VERSION = '2026-01';
const LIST_HASH = 'f'.repeat(64);
const SUBSTANCE = 'Erythropoietin';

/** A fresh contract and context whose endorsing-peer clock follows the transaction clock. */
function fresh(msp = 'NADOMSP') {
  const cc = new CustodyContract();
  const { ctx, stub } = mockContext(msp);
  setPeerClockForTesting(() => stub.now.getTime());
  return { cc, ctx, stub };
}

async function registerList(cc: CustodyContract, ctx: Context) {
  await cc.registerProhibitedList(asOrg(ctx, 'NADOMSP'), LIST_VERSION, LIST_HASH);
}

async function open(cc: CustodyContract, ctx: Context) {
  await cc.initiateSampleCustody(asOrg(ctx, 'NADOMSP'), SAMPLE, ATHLETE, SEAL, 'dcf-digest');
}

/** Drive a sample through a complete, valid, attested chain of custody. */
async function validCustodyChain(cc: CustodyContract, ctx: Context) {
  await open(cc, ctx);
  await cc.acknowledgeSampleCollection(asOrg(ctx, 'AthleteMSP'), SAMPLE, SEAL);
  await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '48');
  await cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'true', SEAL);
}

async function analyse(cc: CustodyContract, ctx: Context, stub: MockStub, accreditation = 'VERIFIED') {
  stub.setInput({
    adverse: true,
    substance: SUBSTANCE,
    prohibitedListVersion: LIST_VERSION,
    prohibitedListHash: LIST_HASH,
    laboratoryAccreditation: accreditation,
  });
  await cc.recordSampleAnalysisResult(asOrg(ctx, 'LabMSP'), SAMPLE);
}

async function results(cc: CustodyContract, ctx: Context) {
  return JSON.parse(await cc.getResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE));
}

describe('initiateSampleCustody — WADA Article 5.3', () => {
  it('only a NADO identity may open a custody chain', async () => {
    const { cc, ctx } = fresh('FederationMSP');
    await expect(cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, SEAL, 'd')).to.be.rejectedWith(
      /authorization denied/,
    );
  });

  it('writes a pseudonymous record, binds it to NADO and laboratory, and notifies the athlete', async () => {
    const { cc, ctx, stub } = fresh();
    const out = JSON.parse(await cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, SEAL, 'd'));
    expect(out.athleteHash).to.equal(ATHLETE);
    expect(out.status).to.equal('IN_CUSTODY');
    expect(stub.events.map((e) => e.name)).to.include('SampleCustodyInitiated');
    const ep = await stub.getStateValidationParameter(stub.createCompositeKey('SAMPLE', [SAMPLE]));
    expect(new KeyEndorsementPolicy(ep).listOrgs()).to.have.members(['NADOMSP', 'LabMSP']);
  });

  it('rejects an identifier that is not a keyed pseudonym', async () => {
    const { cc, ctx } = fresh();
    await expect(cc.initiateSampleCustody(ctx, SAMPLE, 'John Smith', SEAL, 'd')).to.be.rejectedWith(
      /keyed pseudonym/,
    );
    // Upper-case or short digests are not the HMAC encoding the network expects.
    await expect(cc.initiateSampleCustody(ctx, SAMPLE, 'A'.repeat(64), SEAL, 'd')).to.be.rejectedWith(
      /keyed pseudonym/,
    );
  });

  it('refuses to open the same sample twice', async () => {
    const { cc, ctx } = fresh();
    await open(cc, ctx);
    await expect(open(cc, ctx)).to.be.rejectedWith(/already exists/);
  });
});

describe('transaction time — bounded and monotonic', () => {
  it('refuses a proposal timestamped far from the endorsing peer clock (backdating)', async () => {
    const { cc, ctx, stub } = fresh();
    setPeerClockForTesting(() => stub.now.getTime() + 2 * 3600 * 1000); // client claims two hours ago
    await expect(open(cc, ctx)).to.be.rejectedWith(/from the endorsing peer's clock/);
  });

  it('accepts a timestamp within the permitted skew', async () => {
    const { cc, ctx, stub } = fresh();
    setPeerClockForTesting(() => stub.now.getTime() + 60 * 1000);
    await open(cc, ctx);
  });

  it('refuses a receipt that precedes the dispatch it completes', async () => {
    const { cc, ctx, stub } = fresh();
    await open(cc, ctx);
    await cc.acknowledgeSampleCollection(asOrg(ctx, 'AthleteMSP'), SAMPLE, SEAL);
    await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '48');
    // Move the transaction clock back while keeping it inside the peer's skew window.
    stub.now = new Date(stub.now.getTime() - 120 * 1000);
    setPeerClockForTesting(() => stub.now.getTime());
    await expect(
      cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'true', SEAL),
    ).to.be.rejectedWith(/may not precede/);
  });
});

describe('acknowledgeSampleCollection — the athlete attests the collection', () => {
  it('only an athlete identity may acknowledge', async () => {
    const { cc, ctx } = fresh();
    await open(cc, ctx);
    await expect(
      cc.acknowledgeSampleCollection(asOrg(ctx, 'NADOMSP'), SAMPLE, SEAL),
    ).to.be.rejectedWith(/authorization denied/);
  });

  it('refuses an athlete certificate carrying another athlete pseudonym', async () => {
    const { cc, ctx } = fresh();
    await open(cc, ctx);
    await expect(
      cc.acknowledgeSampleCollection(asOrg(ctx, 'AthleteMSP', { pseudonym: 'c'.repeat(64) }), SAMPLE, SEAL),
    ).to.be.rejectedWith(/not the athlete/);
  });

  it('records a seal mismatch as a dispute, which invalidates the process', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await open(cc, ctx);
    await cc.acknowledgeSampleCollection(asOrg(ctx, 'AthleteMSP'), SAMPLE, 'some-other-seal');
    await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '48');
    await cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'true', SEAL);
    await analyse(cc, ctx, stub);
    await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);
    expect((await results(cc, ctx)).action).to.equal(ResultsAction.ProcessInvalidated);
  });
});

describe('custody transfer — two-party attestation, WADA Article 5.4', () => {
  it('binds dispatch and receipt keys to both parties by state-based endorsement', async () => {
    const { cc, ctx, stub } = fresh();
    await validCustodyChain(cc, ctx);
    for (const seq of ['0001', '0002']) {
      const ep = await stub.getStateValidationParameter(stub.createCompositeKey('CUSTODY', [SAMPLE, seq]));
      expect(new KeyEndorsementPolicy(ep).listOrgs()).to.have.members(['NADOMSP', 'LabMSP']);
    }
  });

  it('only the NADO may dispatch, and only to a laboratory', async () => {
    const { cc, ctx } = fresh();
    await open(cc, ctx);
    await expect(
      cc.proposeCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, 'LabMSP', 'true', '48'),
    ).to.be.rejectedWith(/authorization denied/);
    await expect(
      cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'ResearchMSP', 'true', '48'),
    ).to.be.rejectedWith(/only to a laboratory/);
  });

  it('the NADO cannot record the laboratory side of a handover, even with both endorsements', async () => {
    // The reviewer's insider: the NADO client collects endorsements from its own
    // peer and the laboratory peer. Both peers run this check under the NADO's
    // identity and refuse, so no endorsement exists to collect.
    const { cc, ctx } = fresh();
    await open(cc, ctx);
    await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '48');
    await expect(
      cc.acceptCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, '1', 'true', SEAL),
    ).to.be.rejectedWith(/only LabMSP may accept/);
  });

  it('a receipt without a dispatch, or a second receipt, is refused', async () => {
    const { cc, ctx } = fresh();
    await open(cc, ctx);
    await expect(
      cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'true', SEAL),
    ).to.be.rejectedWith(/not found/);
    await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '48');
    await cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'true', SEAL);
    await expect(
      cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'true', SEAL),
    ).to.be.rejectedWith(/not awaiting receipt/);
  });

  it('raises an exception and alerts the NADO when the receipt is late', async () => {
    const { cc, ctx, stub } = fresh();
    await open(cc, ctx);
    await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '48');
    stub.advanceHours(72);
    setPeerClockForTesting(() => stub.now.getTime());
    await cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'true', SEAL);
    const exception = stub.events.find((e) => e.name === 'CustodyException');
    expect((exception!.payload as { reason: string }).reason).to.equal('TRANSFER_WINDOW_EXCEEDED');
    expect((exception!.payload as { alertedMSPs: string[] }).alertedMSPs).to.include('NADOMSP');
  });

  it('honours a zero-hour handover window instead of silently defaulting to 48', async () => {
    const { cc, ctx, stub } = fresh();
    await open(cc, ctx);
    await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '0');
    stub.advanceHours(1);
    setPeerClockForTesting(() => stub.now.getTime());
    await cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'true', SEAL);
    const reasons = stub.events
      .filter((e) => e.name === 'CustodyException')
      .map((e) => (e.payload as { reason: string }).reason);
    expect(reasons).to.include('TRANSFER_WINDOW_EXCEEDED');
  });

  it('keeps both exceptions when a late receipt also reports a broken seal', async () => {
    const { cc, ctx, stub } = fresh();
    await open(cc, ctx);
    await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '0');
    stub.advanceHours(1);
    setPeerClockForTesting(() => stub.now.getTime());
    await cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'false', SEAL);
    const chain = JSON.parse(await cc.getCustodyChain(ctx, SAMPLE));
    expect(chain.exceptions.map((e: { reason: string }) => e.reason)).to.have.members([
      'TRANSFER_WINDOW_EXCEEDED',
      'CONTAINER_SEAL_BROKEN',
    ]);
  });

  it('flags a seal at receipt that differs from the seal acknowledged at collection', async () => {
    const { cc, ctx } = fresh();
    await open(cc, ctx);
    await cc.acknowledgeSampleCollection(asOrg(ctx, 'AthleteMSP'), SAMPLE, SEAL);
    await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '48');
    await cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'true', 'substituted-seal');
    const chain = JSON.parse(await cc.getCustodyChain(ctx, SAMPLE));
    expect(chain.exceptions.map((e: { reason: string }) => e.reason)).to.include('CONTAINER_SEAL_MISMATCH');
  });
});

describe('recordSampleAnalysisResult — WADA Article 2.1', () => {
  it('only a laboratory identity may commit a result', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    stub.setInput({ adverse: true, prohibitedListVersion: LIST_VERSION, prohibitedListHash: LIST_HASH, laboratoryAccreditation: 'VERIFIED' });
    await expect(cc.recordSampleAnalysisResult(asOrg(ctx, 'NADOMSP'), SAMPLE)).to.be.rejectedWith(
      /authorization denied/,
    );
  });

  it('takes its inputs from the transient field, not from arguments', async () => {
    const { cc, ctx } = fresh();
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await expect(cc.recordSampleAnalysisResult(asOrg(ctx, 'LabMSP'), SAMPLE)).to.be.rejectedWith(
      /transient field/,
    );
  });

  it('refuses an unregistered or mismatched Prohibited List revision', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    stub.setInput({ adverse: true, prohibitedListVersion: '1999-01', prohibitedListHash: LIST_HASH, laboratoryAccreditation: 'VERIFIED' });
    await expect(cc.recordSampleAnalysisResult(asOrg(ctx, 'LabMSP'), SAMPLE)).to.be.rejectedWith(
      /not registered on-ledger/,
    );
    stub.setInput({ adverse: true, prohibitedListVersion: LIST_VERSION, prohibitedListHash: 'deadbeef', laboratoryAccreditation: 'VERIFIED' });
    await expect(cc.recordSampleAnalysisResult(asOrg(ctx, 'LabMSP'), SAMPLE)).to.be.rejectedWith(
      /hash mismatch/,
    );
  });

  it('a registered Prohibited List revision cannot be replaced', async () => {
    const { cc, ctx } = fresh();
    await registerList(cc, ctx);
    await expect(
      cc.registerProhibitedList(asOrg(ctx, 'NADOMSP'), LIST_VERSION, 'e'.repeat(64)),
    ).to.be.rejectedWith(/already registered/);
  });

  it('a committed analysis cannot be replaced', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await analyse(cc, ctx, stub);
    await expect(analyse(cc, ctx, stub)).to.be.rejectedWith(/already committed/);
  });
});

describe('recordWhereaboutsStatus — WADA Article 2.4', () => {
  async function failure(cc: CustodyContract, ctx: Context, stub: MockStub, id: string, verified = true) {
    stub.setInput({ athleteHash: ATHLETE, filingId: id, failure: true, ledgerVerified: verified });
    await cc.recordWhereaboutsStatus(ctx);
  }

  it('counts failures inside the rolling 12-month window only, as results management sees them', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await failure(cc, ctx, stub, 'F1');
    stub.advanceHours(24 * 400);
    setPeerClockForTesting(() => stub.now.getTime());
    await failure(cc, ctx, stub, 'F2');
    await failure(cc, ctx, stub, 'F3');
    await validCustodyChain(cc, ctx);
    stub.setInput({ adverse: false, prohibitedListVersion: LIST_VERSION, prohibitedListHash: LIST_HASH, laboratoryAccreditation: 'VERIFIED' });
    await cc.recordSampleAnalysisResult(asOrg(ctx, 'LabMSP'), SAMPLE);
    await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);
    const rm = await results(cc, ctx);
    expect(rm.facts.thirdWhereaboutsFailure, 'a failure outside the window was counted').to.equal(false);
  });

  it('records a whereabouts ADRV on the third verified failure inside the window', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    for (const id of ['F1', 'F2', 'F3']) await failure(cc, ctx, stub, id);
    await validCustodyChain(cc, ctx);
    stub.setInput({ adverse: false, prohibitedListVersion: LIST_VERSION, prohibitedListHash: LIST_HASH, laboratoryAccreditation: 'VERIFIED' });
    await cc.recordSampleAnalysisResult(asOrg(ctx, 'LabMSP'), SAMPLE);
    await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);
    expect((await results(cc, ctx)).action).to.equal(ResultsAction.WhereaboutsAdrv);
  });

  it('whereabouts failures are private to the results collection', async () => {
    const { cc, ctx, stub } = fresh();
    await failure(cc, ctx, stub, 'F1');
    expect([...stub.state.keys()].some((k) => k.includes('WHEREABOUTS'))).to.equal(false);
    expect([...stub.privateState.get(RESULTS_COLLECTION)!.keys()].some((k) => k.includes('WHEREABOUTS'))).to.equal(true);
  });
});

describe('triggerResultsManagement — WADA Article 7.1', () => {
  it('confirms an AAF and starts the notification deadline on a valid, attested chain', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await analyse(cc, ctx, stub);
    const out = JSON.parse(await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE));
    expect(out).to.deep.equal({ sampleCode: SAMPLE, committed: true });
    const rm = await results(cc, ctx);
    expect(rm.action).to.equal(ResultsAction.AafConfirmed);
    expect(rm.notificationDeadline).to.be.a('string');
    expect(rm.facts.mandatoryCustodyStepVerified).to.equal(true);
  });

  it('nothing private reaches public state, events or the response', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await analyse(cc, ctx, stub);
    const response = await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);
    const publicView = JSON.stringify([
      [...stub.state.values()].map((v) => v.toString()),
      stub.events,
      response,
    ]);
    for (const secret of [SUBSTANCE, 'AAF_CONFIRMED', 'R1_AAF_CONFIRMED', 'notificationDeadline']) {
      expect(publicView, `${secret} leaked to the shared ledger`).to.not.include(secret);
    }
  });

  it('a committed record is never overwritten, even by a re-trigger both peers would endorse', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await analyse(cc, ctx, stub);
    await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);
    await expect(cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE)).to.be.rejectedWith(
      /not overwritten/,
    );
  });

  it('invalidates the process when the laboratory never accepted the dispatch', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await open(cc, ctx);
    await cc.acknowledgeSampleCollection(asOrg(ctx, 'AthleteMSP'), SAMPLE, SEAL);
    await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '48');
    await analyse(cc, ctx, stub);
    await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);
    const rm = await results(cc, ctx);
    expect(rm.action).to.equal(ResultsAction.ProcessInvalidated);
    expect(rm.auditAlertRecipients).to.include('WADA');
    expect(JSON.parse(await cc.getSample(ctx, SAMPLE)).status).to.equal('INVALIDATED');
  });

  it('invalidates the process when the athlete never acknowledged the collection', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await open(cc, ctx);
    await cc.proposeCustodyTransfer(asOrg(ctx, 'NADOMSP'), SAMPLE, 'LabMSP', 'true', '48');
    await cc.acceptCustodyTransfer(asOrg(ctx, 'LabMSP'), SAMPLE, '1', 'true', SEAL);
    await analyse(cc, ctx, stub);
    await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);
    expect((await results(cc, ctx)).action).to.equal(ResultsAction.ProcessInvalidated);
  });

  it('suspends automation when laboratory accreditation is pending', async () => {
    const { cc, ctx, stub } = fresh();
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await analyse(cc, ctx, stub, 'PENDING');
    await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);
    const rm = await results(cc, ctx);
    expect(rm.action).to.equal(ResultsAction.AafPendingReview);
    expect(rm.humanOversightRequired).to.equal(true);
  });
});

describe('results amendment — two-party approval', () => {
  async function confirmed() {
    const f = fresh();
    await registerList(f.cc, f.ctx);
    await validCustodyChain(f.cc, f.ctx);
    await analyse(f.cc, f.ctx, f.stub);
    await f.cc.triggerResultsManagement(asOrg(f.ctx, 'NADOMSP'), SAMPLE);
    return f;
  }

  it('an amendment proposed by the NADO cannot be approved by the NADO', async () => {
    const { cc, ctx, stub } = await confirmed();
    stub.setInput({ action: 'NO_ACTION_REQUIRED', reason: 'insider attempt' });
    await cc.proposeResultsAmendment(asOrg(ctx, 'NADOMSP'), SAMPLE);
    await expect(cc.approveResultsAmendment(asOrg(ctx, 'NADOMSP'), SAMPLE, '0')).to.be.rejectedWith(
      /must be approved by the other organisation/,
    );
    expect((await results(cc, ctx)).action).to.equal(ResultsAction.AafConfirmed);
  });

  it('an amendment takes effect once the laboratory approves it, and the history is kept', async () => {
    const { cc, ctx, stub } = await confirmed();
    stub.setInput({ action: 'AAF_PENDING_REVIEW', reason: 'B-sample analysis requested' });
    await cc.proposeResultsAmendment(asOrg(ctx, 'NADOMSP'), SAMPLE);
    await cc.approveResultsAmendment(asOrg(ctx, 'LabMSP'), SAMPLE, '0');
    const rm = await results(cc, ctx);
    expect(rm.action).to.equal(ResultsAction.AafPendingReview);
    expect(rm.amendments).to.deep.include({
      index: 0,
      from: 'AAF_CONFIRMED',
      to: 'AAF_PENDING_REVIEW',
      approvedAt: rm.amendments[0].approvedAt,
    });
    expect(rm.ruleId, 'the original decision must remain on record').to.equal('R1_AAF_CONFIRMED');
  });

  it('refuses a second open amendment and an unknown action', async () => {
    const { cc, ctx, stub } = await confirmed();
    stub.setInput({ action: 'MADE_UP', reason: 'x' });
    await expect(cc.proposeResultsAmendment(asOrg(ctx, 'NADOMSP'), SAMPLE)).to.be.rejectedWith(/unknown/);
    stub.setInput({ action: 'NO_ACTION_REQUIRED', reason: 'x' });
    await cc.proposeResultsAmendment(asOrg(ctx, 'NADOMSP'), SAMPLE);
    await expect(cc.proposeResultsAmendment(asOrg(ctx, 'LabMSP'), SAMPLE)).to.be.rejectedWith(
      /awaiting approval/,
    );
  });
});

describe('recordProvisionalSuspension — WADA Article 7.9 / GDPR Article 22', () => {
  async function toConfirmedAaf() {
    const f = fresh();
    await registerList(f.cc, f.ctx);
    await validCustodyChain(f.cc, f.ctx);
    await analyse(f.cc, f.ctx, f.stub);
    await f.cc.triggerResultsManagement(asOrg(f.ctx, 'NADOMSP'), SAMPLE);
    return f;
  }

  async function oversight(cc: CustodyContract, ctx: Context, stub: MockStub, decision: string, reviewerId = 'reviewer-014') {
    stub.setInput({ reviewerId, decision, rationale: 'recorded rationale' });
    return cc.enforceOversightRequirement(asOrg(ctx, 'NADOMSP'), SAMPLE);
  }

  async function suspend(cc: CustodyContract, ctx: Context, stub: MockStub) {
    stub.setInput({ groundsArticle: 'Article 7.9' });
    return cc.recordProvisionalSuspension(asOrg(ctx, 'NADOMSP'), SAMPLE);
  }

  it('refuses a suspension imposed by automated processing alone', async () => {
    const { cc, ctx, stub } = await toConfirmedAaf();
    await expect(suspend(cc, ctx, stub)).to.be.rejectedWith(/GDPR Article 22/);
  });

  it('refuses a suspension when human oversight did not uphold the finding', async () => {
    const { cc, ctx, stub } = await toConfirmedAaf();
    await oversight(cc, ctx, stub, 'REQUEST_FURTHER_ANALYSIS');
    await expect(suspend(cc, ctx, stub)).to.be.rejectedWith(/requires an UPHOLD decision/);
  });

  it('permits a suspension once a human reviewer has upheld the finding', async () => {
    const { cc, ctx, stub } = await toConfirmedAaf();
    await oversight(cc, ctx, stub, 'UPHOLD');
    await suspend(cc, ctx, stub);
    expect((await results(cc, ctx)).suspension.oversightReviewer).to.equal('reviewer-014');
  });

  it('rejects an oversight record without an identified reviewer', async () => {
    const { cc, ctx, stub } = fresh();
    await expect(oversight(cc, ctx, stub, 'UPHOLD', '')).to.be.rejectedWith(/identified reviewer/);
  });
});

describe('enforceResultsConfidentiality — WADA Article 14.1', () => {
  async function inResultsManagement() {
    const f = fresh();
    await registerList(f.cc, f.ctx);
    await validCustodyChain(f.cc, f.ctx);
    await analyse(f.cc, f.ctx, f.stub);
    await f.cc.triggerResultsManagement(asOrg(f.ctx, 'NADOMSP'), SAMPLE);
    return f;
  }

  it('before notice: the NADO and the laboratory only', async () => {
    const { cc, ctx } = await inResultsManagement();
    for (const org of ['NADOMSP', 'LabMSP']) {
      const out = JSON.parse(await cc.enforceResultsConfidentiality(asOrg(ctx, org), SAMPLE));
      expect(out.granted, `${org} was denied`).to.equal(true);
      expect(out.results.action).to.equal('AAF_CONFIRMED');
    }
    for (const org of ['AthleteMSP', 'FederationMSP', 'ResearchMSP']) {
      const out = JSON.parse(await cc.enforceResultsConfidentiality(asOrg(ctx, org), SAMPLE));
      expect(out.granted, `${org} was granted before notice`).to.equal(false);
    }
  });

  it('from notice: the athlete and the federation receive the notice simultaneously (Art. 14.1.2); research never', async () => {
    const { cc, ctx } = await inResultsManagement();
    await cc.notifyAthleteOfAAF(asOrg(ctx, 'NADOMSP'), SAMPLE);
    for (const org of ['AthleteMSP', 'FederationMSP']) {
      const out = JSON.parse(await cc.enforceResultsConfidentiality(asOrg(ctx, org), SAMPLE));
      expect(out.granted, `${org} was denied after notice`).to.equal(true);
      expect(out.notice.analyticalResult).to.equal(SUBSTANCE);
      expect(out.results, 'the internal record must not be released with the notice').to.equal(undefined);
    }
    const research = JSON.parse(await cc.enforceResultsConfidentiality(asOrg(ctx, 'ResearchMSP'), SAMPLE));
    expect(research.granted).to.equal(false);
  });

  it('the notice is written to the notice collection, the record stays in the results collection', async () => {
    const { cc, ctx, stub } = await inResultsManagement();
    await cc.notifyAthleteOfAAF(asOrg(ctx, 'NADOMSP'), SAMPLE);
    expect([...stub.privateState.get('noticeCollection')!.keys()].some((k) => k.includes('ADRVNOTICE'))).to.equal(true);
    expect([...stub.privateState.get('noticeCollection')!.keys()].some((k) => k.includes('RESULTS'))).to.equal(false);
  });

  it('an approved amendment after notice is reported to the notified parties (Art. 14.1.4)', async () => {
    const { cc, ctx, stub } = await inResultsManagement();
    await cc.notifyAthleteOfAAF(asOrg(ctx, 'NADOMSP'), SAMPLE);
    stub.setInput({ action: 'AAF_PENDING_REVIEW', reason: 'B-sample analysis requested' });
    await cc.proposeResultsAmendment(asOrg(ctx, 'NADOMSP'), SAMPLE);
    await cc.approveResultsAmendment(asOrg(ctx, 'LabMSP'), SAMPLE, '0');
    expect([...stub.privateState.get('noticeCollection')!.keys()].some((k) => k.includes('NOTICESTATUS'))).to.equal(true);
  });
});

describe('ledger provenance', () => {
  it('exposes the full modification history of a sample record', async () => {
    const { cc, ctx } = fresh();
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    const history = JSON.parse(await cc.getSampleHistory(ctx, SAMPLE));
    expect(history.length).to.be.greaterThan(1);
    expect(history[0].txId).to.be.a('string');
  });
});
