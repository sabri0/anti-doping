/**
 * Verification of the consent / data-sovereignty contract.
 *
 * The centrepiece is the worked scenario: a researcher authorised for a
 * cardiovascular study receives haematological and accelerometry data only,
 * with the other four categories refused, each with a reason. Alongside it:
 * deny-by-default, purpose and consent scope, Article 9, Article 22, the
 * Article 17 erasure path with its recovery quorum and Article 17(2) notices,
 * and the confidentiality properties of the private consent collection.
 */

import { expect } from 'chai';
import { Context } from 'fabric-contract-api';
import fc from 'fast-check';
import { CONSENT_COLLECTION, ConsentContract, setPeerClockForTesting } from '../src/consentContract';
import {
  DATA_CATEGORIES,
  DataCategory,
  PURPOSE_LIMITS,
  SPECIAL_CATEGORY,
  evaluateAccess,
} from '../src/abac';
import { asOrg, mockContext, MockStub } from './mockContext';

const ATHLETE = 'a'.repeat(64);
const FROM = '2026-01-01T00:00:00.000Z';
const UNTIL = '2027-01-01T00:00:00.000Z';
const CID = 'bafkreiabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrs';
const ALL_SHARES = ['athlete', 'physician', 'federation-official'];

function fresh(msp = 'AthleteMSP') {
  const cc = new ConsentContract();
  const { ctx, stub } = mockContext(msp);
  setPeerClockForTesting(() => stub.now.getTime());
  return { cc, ctx, stub };
}

/** Grant consent as the athlete. */
async function grant(
  cc: ConsentContract,
  ctx: Context,
  stub: MockStub,
  opts: { to: string; purpose: string; categories: string; special?: boolean; from?: string; until?: string },
) {
  stub.setInput({
    athleteHash: ATHLETE,
    grantedToMSP: opts.to,
    purpose: opts.purpose,
    categories: opts.categories,
    validFrom: opts.from ?? FROM,
    validUntil: opts.until ?? UNTIL,
    specialCategoryAuthorised: opts.special ?? false,
  });
  return cc.recordConsentTransaction(asOrg(ctx, 'AthleteMSP'));
}

/** Request access as `org`, then read the recorded decision back as the requester would. */
async function request(cc: ConsentContract, ctx: Context, stub: MockStub, org: string, purpose: string, categories: string) {
  stub.setInput({ athleteHash: ATHLETE, declaredPurpose: purpose, requestedCategories: categories });
  const { auditRef } = JSON.parse(await cc.validateConsent(asOrg(ctx, org)));
  return JSON.parse(await cc.getAccessDecision(asOrg(ctx, org), ATHLETE, org, auditRef));
}

describe('Worked scenario — cardiovascular research authorisation', () => {
  it('releases haematological and accelerometry only; refuses the other four', async () => {
    const { cc, ctx, stub } = fresh();
    await grant(cc, ctx, stub, {
      to: 'ResearchMSP',
      purpose: 'cardiovascular_research',
      categories: DATA_CATEGORIES.join(','),
      special: true,
    });
    const decision = await request(cc, ctx, stub, 'ResearchMSP', 'cardiovascular_research', DATA_CATEGORIES.join(','));

    expect(decision.granted).to.have.members(['abp_haematological', 'gps_accelerometry']);
    expect(decision.denied).to.have.members(['biochemical_markers', 'abp_steroidal', 'psychological', 'genetic']);
    for (const outcome of decision.outcomes) {
      expect(outcome.reason).to.be.a('string').with.length.greaterThan(10);
      expect(outcome.gdprArticle).to.be.a('string').with.length.greaterThan(0);
    }
    const steroidal = decision.outcomes.find((o: { category: string }) => o.category === 'abp_steroidal');
    expect(steroidal.reason).to.contain('data minimisation');
  });

  it('records every access decision, released or not, and returns only a reference', async () => {
    const { cc, ctx, stub } = fresh();
    await grant(cc, ctx, stub, {
      to: 'ResearchMSP',
      purpose: 'cardiovascular_research',
      categories: 'abp_haematological,gps_accelerometry',
      special: true,
    });
    stub.setInput({ athleteHash: ATHLETE, declaredPurpose: 'cardiovascular_research', requestedCategories: 'genetic' });
    const response = JSON.parse(await cc.validateConsent(asOrg(ctx, 'ResearchMSP')));
    expect(Object.keys(response)).to.deep.equal(['auditRef']);
    const all = JSON.parse(await cc.listAccessDecisions(asOrg(ctx, 'AthleteMSP'), ATHLETE));
    expect(all).to.have.lengthOf(1);
    expect(all[0].anyGranted).to.equal(false);
  });

  it('a third organisation cannot read another requester\'s decision', async () => {
    const { cc, ctx, stub } = fresh();
    stub.setInput({ athleteHash: ATHLETE, declaredPurpose: 'cardiovascular_research', requestedCategories: 'genetic' });
    const { auditRef } = JSON.parse(await cc.validateConsent(asOrg(ctx, 'ResearchMSP')));
    await expect(
      cc.getAccessDecision(asOrg(ctx, 'FederationMSP'), ATHLETE, 'ResearchMSP', auditRef),
    ).to.be.rejectedWith(/may not read/);
  });
});

describe('Confidentiality of the consent collection', () => {
  it('consent, decisions and payload pointers are written only to the private collection', async () => {
    const { cc, ctx, stub } = fresh();
    await grant(cc, ctx, stub, { to: 'ResearchMSP', purpose: 'cardiovascular_research', categories: 'abp_haematological', special: true });
    await request(cc, ctx, stub, 'ResearchMSP', 'cardiovascular_research', 'abp_haematological');
    stub.setInput({ athleteHash: ATHLETE, category: 'abp_haematological', cid: CID, keyRef: 'key-1', commitment: 'c'.repeat(64) });
    await cc.registerOffchainPayload(asOrg(ctx, 'LabMSP'));

    expect(stub.state.size, 'something was written to public state').to.equal(0);
    expect(stub.privateState.get(CONSENT_COLLECTION)!.size).to.be.greaterThan(2);
    const events = JSON.stringify(stub.events);
    for (const secret of ['cardiovascular_research', 'abp_haematological', CID, ATHLETE]) {
      expect(events, `${secret} leaked into an event`).to.not.include(secret);
    }
  });

  it('writing functions refuse arguments-only calls, so inputs never reach the block', async () => {
    const { cc, ctx } = fresh();
    await expect(cc.recordConsentTransaction(ctx)).to.be.rejectedWith(/transient field/);
  });

  it('refuses an athlete identifier that is not a keyed pseudonym', async () => {
    const { cc, ctx, stub } = fresh();
    stub.setInput({ athleteHash: 'athlete-42' });
    await expect(cc.applyDefaultPrivacySettings(ctx)).to.be.rejectedWith(/keyed pseudonym/);
  });

  it('refuses a backdated proposal', async () => {
    const { cc, ctx, stub } = fresh();
    setPeerClockForTesting(() => stub.now.getTime() + 3600 * 1000);
    stub.setInput({ athleteHash: ATHLETE });
    await expect(cc.applyDefaultPrivacySettings(ctx)).to.be.rejectedWith(/endorsing peer's clock/);
  });
});

describe('Deny by default — GDPR Article 25', () => {
  it('an athlete with no consent record releases nothing', async () => {
    const { cc, ctx, stub } = fresh();
    const decision = await request(cc, ctx, stub, 'ResearchMSP', 'cardiovascular_research', 'abp_haematological,gps_accelerometry');
    expect(decision.granted).to.be.empty;
    expect(decision.outcomes[0].reason).to.contain('deny by default');
  });

  it('applyDefaultPrivacySettings shares nothing with anyone', async () => {
    const { cc, ctx, stub } = fresh();
    stub.setInput({ athleteHash: ATHLETE });
    await cc.applyDefaultPrivacySettings(ctx);
    const record = JSON.parse(
      stub.privateState.get(CONSENT_COLLECTION)!.get(stub.createCompositeKey('PRIVACYDEFAULTS', [ATHLETE]))!.toString(),
    );
    expect(record.categories).to.be.empty;
    expect(record.revoked).to.equal(true);
  });

  it('an unrecognised purpose releases nothing', async () => {
    const { cc, ctx, stub } = fresh();
    await grant(cc, ctx, stub, { to: 'ResearchMSP', purpose: 'commercial_resale', categories: DATA_CATEGORIES.join(','), special: true });
    const decision = await request(cc, ctx, stub, 'ResearchMSP', 'commercial_resale', 'gps_accelerometry');
    expect(decision.granted).to.be.empty;
  });
});

describe('Purpose limitation and consent scope — GDPR Articles 5 and 7', () => {
  it('consent given for one purpose does not authorise another', async () => {
    const { cc, ctx, stub } = fresh();
    await grant(cc, ctx, stub, { to: 'ResearchMSP', purpose: 'workload_monitoring', categories: 'gps_accelerometry' });
    const decision = await request(cc, ctx, stub, 'ResearchMSP', 'injury_prevention', 'gps_accelerometry');
    expect(decision.granted).to.be.empty;
  });

  it('consent given to one organisation does not authorise another', async () => {
    const { cc, ctx, stub } = fresh();
    await grant(cc, ctx, stub, { to: 'ResearchMSP', purpose: 'workload_monitoring', categories: 'gps_accelerometry' });
    const decision = await request(cc, ctx, stub, 'FederationMSP', 'workload_monitoring', 'gps_accelerometry');
    expect(decision.granted).to.be.empty;
  });

  it('expired consent releases nothing', async () => {
    const { cc, ctx, stub } = fresh();
    await grant(cc, ctx, stub, {
      to: 'ResearchMSP',
      purpose: 'workload_monitoring',
      categories: 'gps_accelerometry',
      from: '2025-01-01T00:00:00.000Z',
      until: '2025-06-01T00:00:00.000Z',
    });
    const decision = await request(cc, ctx, stub, 'ResearchMSP', 'workload_monitoring', 'gps_accelerometry');
    expect(decision.granted).to.be.empty;
    expect(decision.outcomes[0].reason).to.contain('validity period');
  });

  it('withdrawal takes effect immediately — GDPR Article 7(3)', async () => {
    const { cc, ctx, stub } = fresh();
    await grant(cc, ctx, stub, { to: 'ResearchMSP', purpose: 'cardiovascular_research', categories: 'abp_haematological,gps_accelerometry', special: true });
    const before = await request(cc, ctx, stub, 'ResearchMSP', 'cardiovascular_research', 'abp_haematological,gps_accelerometry');
    expect(before.granted).to.have.lengthOf(2);
    stub.setInput({ athleteHash: ATHLETE, grantedToMSP: 'ResearchMSP', purpose: 'cardiovascular_research' });
    await cc.withdrawConsent(asOrg(ctx, 'AthleteMSP'));
    const after = await request(cc, ctx, stub, 'ResearchMSP', 'cardiovascular_research', 'abp_haematological,gps_accelerometry');
    expect(after.granted).to.be.empty;
  });

  it('only the athlete may grant or withdraw consent over their own data', async () => {
    const { cc, ctx, stub } = fresh();
    stub.setInput({ athleteHash: ATHLETE, grantedToMSP: 'ResearchMSP', purpose: 'workload_monitoring', categories: 'gps_accelerometry', validFrom: FROM, validUntil: UNTIL });
    await expect(cc.recordConsentTransaction(asOrg(ctx, 'FederationMSP'))).to.be.rejectedWith(/only the athlete/);
  });
});

describe('Special-category data — GDPR Article 9', () => {
  it('refuses special-category data without an explicit Article 9 authorisation', async () => {
    const { cc, ctx, stub } = fresh();
    await grant(cc, ctx, stub, { to: 'ResearchMSP', purpose: 'cardiovascular_research', categories: 'abp_haematological,gps_accelerometry', special: false });
    const decision = await request(cc, ctx, stub, 'ResearchMSP', 'cardiovascular_research', 'abp_haematological,gps_accelerometry');
    expect(decision.granted).to.deep.equal(['gps_accelerometry']);
  });

  it('checkSpecialCategoryAuthorization reports the authorisation state', async () => {
    const { cc, ctx, stub } = fresh();
    await grant(cc, ctx, stub, { to: 'ResearchMSP', purpose: 'cardiovascular_research', categories: 'abp_haematological', special: true });
    const out = JSON.parse(
      await cc.checkSpecialCategoryAuthorization(asOrg(ctx, 'ResearchMSP'), ATHLETE, 'cardiovascular_research', 'abp_haematological'),
    );
    expect(out.authorised).to.equal(true);
  });
});

describe('Article 22 — human oversight of automated decisions', () => {
  it('refuses an oversight record with no prior review flag', async () => {
    const { cc, ctx, stub } = fresh('NADOMSP');
    stub.setInput({ subjectId: 'S1', decisionType: 'disclosure', reviewerId: 'r1', outcome: 'UPHOLD', rationale: 'x' });
    await expect(cc.enforceOversightRequirement(ctx)).to.be.rejectedWith(/no human-review flag/);
  });

  it('requires a named reviewer and a rationale', async () => {
    const { cc, ctx, stub } = fresh('NADOMSP');
    stub.setInput({ subjectId: 'S1', decisionType: 'disclosure', reviewerId: '', outcome: 'UPHOLD', rationale: 'x' });
    await expect(cc.enforceOversightRequirement(ctx)).to.be.rejectedWith(/named human reviewer/);
  });

  it('resolves the flag once oversight is recorded', async () => {
    const { cc, ctx, stub } = fresh('NADOMSP');
    stub.setInput({ subjectId: 'S1', decisionType: 'disclosure', rationale: 'career-affecting disclosure' });
    await cc.flagForHumanReview(ctx);
    stub.setInput({ subjectId: 'S1', decisionType: 'disclosure', reviewerId: 'r1', outcome: 'UPHOLD', rationale: 'reviewed' });
    await cc.enforceOversightRequirement(ctx);
    const out = JSON.parse(await cc.getOversight(ctx, 'S1', 'disclosure'));
    expect(out.flag.resolved).to.equal(true);
    expect(out.oversight.reviewerId).to.equal('r1');
  });
});

describe('Article 17 — revocation, recovery and erasure', () => {
  async function registered() {
    const f = fresh();
    f.stub.setInput({ athleteHash: ATHLETE, category: 'abp_haematological', cid: CID, keyRef: 'key-1234', commitment: 'c'.repeat(64) });
    await f.cc.registerOffchainPayload(asOrg(f.ctx, 'LabMSP'));
    return f;
  }

  async function erase(cc: ConsentContract, ctx: Context, stub: MockStub, certificate: Record<string, unknown>) {
    stub.setInput({ athleteHash: ATHLETE, category: 'abp_haematological', erasureCertificate: certificate });
    return cc.destroyIPFSAccessToken(asOrg(ctx, 'AthleteMSP'));
  }

  it('records a CID, a key reference and a keyed commitment, never the payload', async () => {
    const { cc, ctx } = await registered();
    const record = JSON.parse(await cc.getOffchainPayload(ctx, ATHLETE, 'abp_haematological'));
    expect(record.cid).to.equal(CID);
    expect(record.keyRef).to.equal('key-1234');
    expect(Object.keys(record)).to.not.include('payload');
    expect(Object.keys(record)).to.not.include('plaintextDigest');
  });

  it('revocation is recorded as reversible, and recovery requires the athlete', async () => {
    const { cc, ctx, stub } = await registered();
    stub.setInput({ athleteHash: ATHLETE, category: 'abp_haematological' });
    expect(JSON.parse(await cc.revokeDataAccessKey(asOrg(ctx, 'AthleteMSP'))).reversible).to.equal(true);
    stub.setInput({ athleteHash: ATHLETE, category: 'abp_haematological', holders: ['physician', 'federation-official'] });
    await expect(cc.restoreDataAccessKey(asOrg(ctx, 'AthleteMSP'))).to.be.rejectedWith(/requires the athlete/);
    stub.setInput({ athleteHash: ATHLETE, category: 'abp_haematological', holders: ['athlete', 'physician'] });
    expect(JSON.parse(await cc.restoreDataAccessKey(asOrg(ctx, 'AthleteMSP'))).restored).to.equal(true);
  });

  it('rejects a certificate for a different CID, or one that does not attest key destruction', async () => {
    const { cc, ctx, stub } = await registered();
    await expect(erase(cc, ctx, stub, { cid: 'bafk-other', keyDestroyed: true, sharesDestroyed: ALL_SHARES })).to.be.rejectedWith(/erasure certificate is for/);
    await expect(erase(cc, ctx, stub, { cid: CID, keyDestroyed: false, sharesDestroyed: ALL_SHARES })).to.be.rejectedWith(/does not attest that the key was destroyed/);
  });

  it('is not erasure while any recovery share survives', async () => {
    const { cc, ctx, stub } = await registered();
    await expect(
      erase(cc, ctx, stub, { cid: CID, keyDestroyed: true, sharesDestroyed: ['athlete'] }),
    ).to.be.rejectedWith(/physician, federation-official/);
  });

  it('notifies every organisation that was granted the category, under Article 17(2)', async () => {
    const { cc, ctx, stub } = await registered();
    await grant(cc, ctx, stub, { to: 'ResearchMSP', purpose: 'cardiovascular_research', categories: 'abp_haematological', special: true });
    await request(cc, ctx, stub, 'ResearchMSP', 'cardiovascular_research', 'abp_haematological');
    await request(cc, ctx, stub, 'FederationMSP', 'cardiovascular_research', 'abp_haematological'); // denied: not notified
    const out = JSON.parse(await erase(cc, ctx, stub, { cid: CID, keyDestroyed: true, sharesDestroyed: ALL_SHARES, complete: true }));
    expect(out.recipientsNotified).to.equal(1);
    const record = JSON.parse(await cc.getErasureRecord(asOrg(ctx, 'AthleteMSP'), ATHLETE, 'abp_haematological'));
    expect(record.article17_2Recipients).to.deep.equal(['ResearchMSP']);
    expect(record.legalCaveat).to.contain('not confirmed by supervisory authorities');
    expect(record.scope).to.contain('do not reach plaintext');
    const notice = stub.events.find((e) => e.name === 'ErasureNotice');
    expect((notice!.payload as { recipients: string[] }).recipients).to.deep.equal(['ResearchMSP']);
  });

  it('an erased category cannot be restored', async () => {
    const { cc, ctx, stub } = await registered();
    await erase(cc, ctx, stub, { cid: CID, keyDestroyed: true, sharesDestroyed: ALL_SHARES });
    stub.setInput({ athleteHash: ATHLETE, category: 'abp_haematological', holders: ['athlete', 'physician'] });
    await expect(cc.restoreDataAccessKey(asOrg(ctx, 'AthleteMSP'))).to.be.rejectedWith(/erased/);
  });

  it('only the athlete may revoke or erase', async () => {
    const { cc, ctx, stub } = await registered();
    stub.setInput({ athleteHash: ATHLETE, category: 'abp_haematological' });
    await expect(cc.revokeDataAccessKey(asOrg(ctx, 'FederationMSP'))).to.be.rejectedWith(/only the athlete/);
  });
});

describe('Input validation', () => {
  it('rejects unknown data categories', async () => {
    const { cc, ctx, stub } = fresh();
    await expect(
      grant(cc, ctx, stub, { to: 'ResearchMSP', purpose: 'workload_monitoring', categories: 'gps_accelerometry,blood_type' }),
    ).to.be.rejectedWith(/unknown data categories/);
  });

  it('rejects an inverted validity period', async () => {
    const { cc, ctx, stub } = fresh();
    await expect(
      grant(cc, ctx, stub, { to: 'ResearchMSP', purpose: 'workload_monitoring', categories: 'gps_accelerometry', from: UNTIL, until: FROM }),
    ).to.be.rejectedWith(/must be after/);
  });
});

describe('ABAC invariants (property-based)', () => {
  const arbCategories = fc.uniqueArray(fc.constantFrom(...DATA_CATEGORIES), {
    minLength: 1,
    maxLength: 6,
  });
  const arbPurpose = fc.constantFrom(...Object.keys(PURPOSE_LIMITS), 'commercial_resale');

  it('INV-A: nothing is ever released beyond the purpose ceiling', () => {
    fc.assert(
      fc.property(
        arbPurpose,
        arbCategories,
        arbCategories,
        fc.boolean(),
        (purpose, consented, requested, special) => {
          const decision = evaluateAccess(
            {
              athleteHash: ATHLETE,
              requestingMSP: 'ResearchMSP',
              declaredPurpose: purpose,
              requestedCategories: requested as DataCategory[],
              at: '2026-06-01T00:00:00.000Z',
            },
            {
              athleteHash: ATHLETE,
              grantedToMSP: 'ResearchMSP',
              purpose,
              categories: consented as DataCategory[],
              validFrom: FROM,
              validUntil: UNTIL,
              specialCategoryAuthorised: special,
              revoked: false,
            },
          );
          const ceiling = PURPOSE_LIMITS[purpose] ?? [];
          return decision.granted.every((c) => ceiling.includes(c));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('INV-B: nothing is ever released that the athlete did not consent to', () => {
    fc.assert(
      fc.property(
        arbPurpose,
        arbCategories,
        arbCategories,
        (purpose, consented, requested) => {
          const decision = evaluateAccess(
            {
              athleteHash: ATHLETE,
              requestingMSP: 'ResearchMSP',
              declaredPurpose: purpose,
              requestedCategories: requested as DataCategory[],
              at: '2026-06-01T00:00:00.000Z',
            },
            {
              athleteHash: ATHLETE,
              grantedToMSP: 'ResearchMSP',
              purpose,
              categories: consented as DataCategory[],
              validFrom: FROM,
              validUntil: UNTIL,
              specialCategoryAuthorised: true,
              revoked: false,
            },
          );
          return decision.granted.every((c) => (consented as DataCategory[]).includes(c));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('INV-C: special-category data never escapes without Article 9 authorization', () => {
    fc.assert(
      fc.property(arbPurpose, arbCategories, (purpose, requested) => {
        const decision = evaluateAccess(
          {
            athleteHash: ATHLETE,
            requestingMSP: 'ResearchMSP',
            declaredPurpose: purpose,
            requestedCategories: requested as DataCategory[],
            at: '2026-06-01T00:00:00.000Z',
          },
          {
            athleteHash: ATHLETE,
            grantedToMSP: 'ResearchMSP',
            purpose,
            categories: [...DATA_CATEGORIES],
            validFrom: FROM,
            validUntil: UNTIL,
            specialCategoryAuthorised: false,
            revoked: false,
          },
        );
        return decision.granted.every((c) => !SPECIAL_CATEGORY.includes(c));
      }),
      { numRuns: 2000 },
    );
  });

  it('INV-D: a withdrawn consent releases nothing, whatever is asked', () => {
    fc.assert(
      fc.property(arbPurpose, arbCategories, (purpose, requested) => {
        const decision = evaluateAccess(
          {
            athleteHash: ATHLETE,
            requestingMSP: 'ResearchMSP',
            declaredPurpose: purpose,
            requestedCategories: requested as DataCategory[],
            at: '2026-06-01T00:00:00.000Z',
          },
          {
            athleteHash: ATHLETE,
            grantedToMSP: 'ResearchMSP',
            purpose,
            categories: [...DATA_CATEGORIES],
            validFrom: FROM,
            validUntil: UNTIL,
            specialCategoryAuthorised: true,
            revoked: true,
          },
        );
        return decision.granted.length === 0;
      }),
      { numRuns: 2000 },
    );
  });

  it('INV-E: every requested category receives exactly one reasoned outcome', () => {
    fc.assert(
      fc.property(arbPurpose, arbCategories, (purpose, requested) => {
        const decision = evaluateAccess(
          {
            athleteHash: ATHLETE,
            requestingMSP: 'ResearchMSP',
            declaredPurpose: purpose,
            requestedCategories: requested as DataCategory[],
            at: '2026-06-01T00:00:00.000Z',
          },
          null,
        );
        return (
          decision.outcomes.length === requested.length &&
          decision.outcomes.every((o) => o.reason.length > 0 && o.gdprArticle.length > 0)
        );
      }),
      { numRuns: 1000 },
    );
  });
});
