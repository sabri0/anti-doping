/**
 * Unit tests for the chain-of-custody contract.
 *
 * These cover the properties the manuscript asserts but never demonstrated:
 * organizational-class authorization, cross-organizational endorsement on
 * critical keys, Prohibited List hash verification, the rolling 12-month
 * whereabouts window, the GDPR Article 22 oversight precondition, and the
 * Article 14.1 confidentiality gate.
 */

import { expect } from 'chai';
import { Context } from 'fabric-contract-api';
import { KeyEndorsementPolicy } from 'fabric-shim';
import { CustodyContract } from '../src/custodyContract';
import { ResultsAction } from '../src/resultsDecision';
import { asOrg, mockContext } from './mockContext';

const SAMPLE = 'SMP-2026-000123';
const ATHLETE = 'a'.repeat(64); // pseudonymized SHA-256 digest
const LIST_VERSION = '2026-01';
const LIST_HASH = 'f'.repeat(64);

async function registerList(cc: CustodyContract, ctx: Context) {
  await cc.registerProhibitedList(asOrg(ctx, 'NADOMSP'), LIST_VERSION, LIST_HASH);
}

/** Drive a sample through a complete, valid chain of custody. */
async function validCustodyChain(cc: CustodyContract, ctx: Context) {
  await cc.initiateSampleCustody(
    asOrg(ctx, 'NADOMSP'),
    SAMPLE,
    ATHLETE,
    'seal-' + 'b'.repeat(32),
    'Tunis National Testing Centre',
  );
  await cc.recordCustodyTransfer(
    asOrg(ctx, 'NADOMSP'),
    SAMPLE,
    'TRANSPORT_HANDOFF',
    'NADOMSP',
    'LabMSP',
    'true',
    '48',
  );
  await cc.recordCustodyTransfer(
    asOrg(ctx, 'LabMSP'),
    SAMPLE,
    'LABORATORY_RECEIPT',
    'NADOMSP',
    'LabMSP',
    'true',
    '48',
  );
}

describe('initiateSampleCustody — WADA Article 5.3', () => {
  it('only a NADO identity may open a custody chain', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('FederationMSP');
    await expect(
      cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, 'seal', 'Stadium'),
    ).to.be.rejectedWith(/authorization denied/);
  });

  it('writes a pseudonymized record and notifies the athlete', async () => {
    const cc = new CustodyContract();
    const { ctx, stub } = mockContext('NADOMSP');
    const out = JSON.parse(
      await cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, 'seal-hash', 'Tunis'),
    );
    expect(out.athleteHash).to.equal(ATHLETE);
    expect(out.status).to.equal('IN_CUSTODY');
    expect(stub.events.map((e) => e.name)).to.include('SampleCustodyInitiated');
  });

  it('rejects an identifier that is not a pseudonymized digest', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await expect(
      cc.initiateSampleCustody(ctx, SAMPLE, 'John Smith', 'seal', 'Tunis'),
    ).to.be.rejectedWith(/pseudonymized digest/);
  });

  it('refuses to open the same sample twice', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, 'seal', 'Tunis');
    await expect(
      cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, 'seal', 'Tunis'),
    ).to.be.rejectedWith(/already exists/);
  });
});

describe('recordCustodyTransfer — WADA Article 5.4', () => {
  it('binds the transfer key to both parties by state-based endorsement', async () => {
    const cc = new CustodyContract();
    const { ctx, stub } = mockContext('NADOMSP');
    await validCustodyChain(cc, ctx);

    const key = stub.createCompositeKey('CUSTODY', [SAMPLE, '1']);
    const ep = await stub.getStateValidationParameter(key);
    expect(ep.length, 'transfer key carries no endorsement policy').to.be.greaterThan(0);
    // Decode the serialized SignaturePolicyEnvelope rather than string-matching it.
    expect(new KeyEndorsementPolicy(ep).listOrgs()).to.have.members(['NADOMSP', 'LabMSP']);
  });

  it('rejects a submitter that is party to neither side', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, 'seal', 'Tunis');
    await expect(
      cc.recordCustodyTransfer(
        asOrg(ctx, 'ResearchMSP'),
        SAMPLE,
        'TRANSPORT_HANDOFF',
        'NADOMSP',
        'LabMSP',
        'true',
        '48',
      ),
    ).to.be.rejectedWith(/party to neither side/);
  });

  it('raises an exception and alerts the NADO when the handover window lapses', async () => {
    const cc = new CustodyContract();
    const { ctx, stub } = mockContext('NADOMSP');
    await cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, 'seal', 'Tunis');

    stub.advanceHours(72); // window is 48h
    await cc.recordCustodyTransfer(
      ctx,
      SAMPLE,
      'TRANSPORT_HANDOFF',
      'NADOMSP',
      'LabMSP',
      'true',
      '48',
    );

    const exception = stub.events.find((e) => e.name === 'CustodyException');
    expect(exception, 'no exception raised for a late handover').to.exist;
    expect((exception!.payload as { reason: string }).reason).to.equal(
      'TRANSFER_WINDOW_EXCEEDED',
    );
    expect((exception!.payload as { alertedMSPs: string[] }).alertedMSPs).to.include('NADOMSP');
  });

  it('honours a zero-hour handover window instead of silently defaulting to 48', async () => {
    // Regression: `Number(x) || DEFAULT` treated a zero-hour window as absent,
    // so a deployment demanding an immediate handover got a 48-hour one.
    const cc = new CustodyContract();
    const { ctx, stub } = mockContext('NADOMSP');
    await cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, 'seal', 'Tunis');

    stub.advanceHours(1);
    await cc.recordCustodyTransfer(
      ctx,
      SAMPLE,
      'TRANSPORT_HANDOFF',
      'NADOMSP',
      'LabMSP',
      'true',
      '0',
    );

    const reasons = stub.events
      .filter((e) => e.name === 'CustodyException')
      .map((e) => (e.payload as { reason: string }).reason);
    expect(reasons, 'a zero-hour window was treated as the 48-hour default').to.include(
      'TRANSFER_WINDOW_EXCEEDED',
    );
  });

  it('falls back to the default window when none is supplied', async () => {
    const cc = new CustodyContract();
    const { ctx, stub } = mockContext('NADOMSP');
    await cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, 'seal', 'Tunis');
    stub.advanceHours(1);
    await cc.recordCustodyTransfer(ctx, SAMPLE, 'TRANSPORT_HANDOFF', 'NADOMSP', 'LabMSP', 'true', '');
    expect(stub.events.filter((e) => e.name === 'CustodyException')).to.have.lengthOf(0);
  });

  it('raises an exception when the container seal is reported broken', async () => {
    const cc = new CustodyContract();
    const { ctx, stub } = mockContext('NADOMSP');
    await cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, 'seal', 'Tunis');
    await cc.recordCustodyTransfer(
      ctx,
      SAMPLE,
      'TRANSPORT_HANDOFF',
      'NADOMSP',
      'LabMSP',
      'false',
      '48',
    );
    const reasons = stub.events
      .filter((e) => e.name === 'CustodyException')
      .map((e) => (e.payload as { reason: string }).reason);
    expect(reasons).to.include('CONTAINER_SEAL_BROKEN');
  });
});

describe('recordSampleAnalysisResult — WADA Article 2.1', () => {
  it('only a WADA-accredited laboratory identity may commit a result', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await expect(
      cc.recordSampleAnalysisResult(
        asOrg(ctx, 'NADOMSP'),
        SAMPLE,
        'true',
        'EPO',
        LIST_VERSION,
        LIST_HASH,
        'VERIFIED',
      ),
    ).to.be.rejectedWith(/authorization denied/);
  });

  it('refuses a result citing an unregistered Prohibited List version', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await validCustodyChain(cc, ctx);
    await expect(
      cc.recordSampleAnalysisResult(
        asOrg(ctx, 'LabMSP'),
        SAMPLE,
        'true',
        'EPO',
        '1999-01',
        LIST_HASH,
        'VERIFIED',
      ),
    ).to.be.rejectedWith(/not registered on-ledger/);
  });

  it('refuses a result whose Prohibited List hash does not match the ledger copy', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await expect(
      cc.recordSampleAnalysisResult(
        asOrg(ctx, 'LabMSP'),
        SAMPLE,
        'true',
        'EPO',
        LIST_VERSION,
        'deadbeef',
        'VERIFIED',
      ),
    ).to.be.rejectedWith(/hash mismatch/);
  });
});

describe('recordWhereaboutsStatus — WADA Article 2.4', () => {
  it('counts failures inside the rolling 12-month window only', async () => {
    const cc = new CustodyContract();
    const { ctx, stub } = mockContext('NADOMSP');

    await cc.recordWhereaboutsStatus(ctx, ATHLETE, 'F1', 'true', 'true');
    stub.advanceHours(24 * 400); // first failure now falls outside the window
    await cc.recordWhereaboutsStatus(ctx, ATHLETE, 'F2', 'true', 'true');
    await cc.recordWhereaboutsStatus(ctx, ATHLETE, 'F3', 'true', 'true');
    const third = JSON.parse(
      await cc.recordWhereaboutsStatus(ctx, ATHLETE, 'F4', 'true', 'true'),
    );

    expect(third.failuresInWindow).to.equal(3);
    expect(third.allFailuresLedgerVerified).to.equal(true);
  });

  it('reports unverified failures so Q006 cannot be silently satisfied', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await cc.recordWhereaboutsStatus(ctx, ATHLETE, 'F1', 'true', 'true');
    await cc.recordWhereaboutsStatus(ctx, ATHLETE, 'F2', 'true', 'false');
    const out = JSON.parse(await cc.recordWhereaboutsStatus(ctx, ATHLETE, 'F3', 'true', 'true'));
    expect(out.failuresInWindow).to.equal(3);
    expect(out.allFailuresLedgerVerified).to.equal(false);
  });
});

describe('triggerResultsManagement — WADA Article 7.1', () => {
  it('confirms an AAF and starts the Article 7.3 clock on a valid chain', async () => {
    const cc = new CustodyContract();
    const { ctx, stub } = mockContext('NADOMSP');
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await cc.recordSampleAnalysisResult(
      asOrg(ctx, 'LabMSP'),
      SAMPLE,
      'true',
      'EPO',
      LIST_VERSION,
      LIST_HASH,
      'VERIFIED',
    );

    const out = JSON.parse(await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE));
    expect(out.action).to.equal(ResultsAction.AafConfirmed);
    expect(out.statutoryDeadline).to.be.a('string');
    expect(out.facts.mandatoryCustodyStepVerified).to.equal(true);
    expect(stub.events.map((e) => e.name)).to.include('ResultsManagementDecided');
  });

  it('requires cross-organizational endorsement on the results key', async () => {
    const cc = new CustodyContract();
    const { ctx, stub } = mockContext('NADOMSP');
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await cc.recordSampleAnalysisResult(
      asOrg(ctx, 'LabMSP'),
      SAMPLE,
      'true',
      'EPO',
      LIST_VERSION,
      LIST_HASH,
      'VERIFIED',
    );
    await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);

    const ep = await stub.getStateValidationParameter(
      stub.createCompositeKey('RESULTS', [SAMPLE]),
    );
    expect(new KeyEndorsementPolicy(ep).listOrgs()).to.have.members(['NADOMSP', 'LabMSP']);
  });

  it('invalidates the process when a mandatory custody step is missing', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await registerList(cc, ctx);
    // Collection and transport only — no laboratory receipt.
    await cc.initiateSampleCustody(ctx, SAMPLE, ATHLETE, 'seal', 'Tunis');
    await cc.recordCustodyTransfer(
      ctx,
      SAMPLE,
      'TRANSPORT_HANDOFF',
      'NADOMSP',
      'LabMSP',
      'true',
      '48',
    );
    await cc.recordSampleAnalysisResult(
      asOrg(ctx, 'LabMSP'),
      SAMPLE,
      'true',
      'EPO',
      LIST_VERSION,
      LIST_HASH,
      'VERIFIED',
    );

    const out = JSON.parse(await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE));
    expect(out.action).to.equal(ResultsAction.ProcessInvalidated);
    expect(out.auditAlertRecipients).to.include('WADA');
    expect(JSON.parse(await cc.getSample(ctx, SAMPLE)).status).to.equal('INVALIDATED');
  });

  it('suspends automation when laboratory accreditation is pending', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await cc.recordSampleAnalysisResult(
      asOrg(ctx, 'LabMSP'),
      SAMPLE,
      'true',
      'EPO',
      LIST_VERSION,
      LIST_HASH,
      'PENDING',
    );
    const out = JSON.parse(await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE));
    expect(out.action).to.equal(ResultsAction.AafPendingReview);
    expect(out.humanOversightRequired).to.equal(true);
  });
});

describe('recordProvisionalSuspension — WADA Article 7.9 / GDPR Article 22', () => {
  async function toConfirmedAaf(cc: CustodyContract, ctx: Context) {
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await cc.recordSampleAnalysisResult(
      asOrg(ctx, 'LabMSP'),
      SAMPLE,
      'true',
      'EPO',
      LIST_VERSION,
      LIST_HASH,
      'VERIFIED',
    );
    await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);
  }

  it('refuses a suspension imposed by automated processing alone', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await toConfirmedAaf(cc, ctx);
    await expect(
      cc.recordProvisionalSuspension(asOrg(ctx, 'NADOMSP'), SAMPLE, 'Article 7.9'),
    ).to.be.rejectedWith(/GDPR Article 22/);
  });

  it('refuses a suspension when human oversight did not uphold the finding', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await toConfirmedAaf(cc, ctx);
    await cc.enforceOversightRequirement(
      asOrg(ctx, 'NADOMSP'),
      SAMPLE,
      'reviewer-014',
      'REQUEST_FURTHER_ANALYSIS',
      'B-sample analysis requested before any provisional measure',
    );
    await expect(
      cc.recordProvisionalSuspension(asOrg(ctx, 'NADOMSP'), SAMPLE, 'Article 7.9'),
    ).to.be.rejectedWith(/requires an UPHOLD decision/);
  });

  it('permits a suspension once a human reviewer has upheld the finding', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await toConfirmedAaf(cc, ctx);
    await cc.enforceOversightRequirement(
      asOrg(ctx, 'NADOMSP'),
      SAMPLE,
      'reviewer-014',
      'UPHOLD',
      'Chain of custody complete; accredited laboratory; finding upheld',
    );
    const out = JSON.parse(
      await cc.recordProvisionalSuspension(asOrg(ctx, 'NADOMSP'), SAMPLE, 'Article 7.9'),
    );
    expect(out.oversightReviewer).to.equal('reviewer-014');
  });

  it('rejects an oversight record without an identified reviewer', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await expect(
      cc.enforceOversightRequirement(ctx, SAMPLE, '', 'UPHOLD', 'no reviewer'),
    ).to.be.rejectedWith(/identified reviewer/);
  });
});

describe('enforceResultsConfidentiality — WADA Article 14.1', () => {
  async function inResultsManagement(cc: CustodyContract, ctx: Context) {
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    await cc.recordSampleAnalysisResult(
      asOrg(ctx, 'LabMSP'),
      SAMPLE,
      'true',
      'EPO',
      LIST_VERSION,
      LIST_HASH,
      'VERIFIED',
    );
    await cc.triggerResultsManagement(asOrg(ctx, 'NADOMSP'), SAMPLE);
  }

  it('denies a research organization during results management', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await inResultsManagement(cc, ctx);
    const out = JSON.parse(
      await cc.enforceResultsConfidentiality(asOrg(ctx, 'ResearchMSP'), SAMPLE),
    );
    expect(out.granted).to.equal(false);
    expect(out.wadaArticle).to.equal('Article 14.1');
  });

  it('denies the federation while the case is open', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await inResultsManagement(cc, ctx);
    const out = JSON.parse(
      await cc.enforceResultsConfidentiality(asOrg(ctx, 'FederationMSP'), SAMPLE),
    );
    expect(out.granted).to.equal(false);
  });

  it('grants the NADO and the analysing laboratory', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await inResultsManagement(cc, ctx);
    for (const org of ['NADOMSP', 'LabMSP', 'AthleteMSP']) {
      const out = JSON.parse(
        await cc.enforceResultsConfidentiality(asOrg(ctx, org), SAMPLE),
      );
      expect(out.granted, `${org} was denied`).to.equal(true);
    }
  });
});

describe('ledger provenance', () => {
  it('exposes the full modification history of a sample record', async () => {
    const cc = new CustodyContract();
    const { ctx } = mockContext('NADOMSP');
    await registerList(cc, ctx);
    await validCustodyChain(cc, ctx);
    const history = JSON.parse(await cc.getSampleHistory(ctx, SAMPLE));
    expect(history.length).to.be.greaterThan(1);
    expect(history[0].txId).to.be.a('string');
  });
});
