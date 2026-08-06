/**
 * Verification of the consent / data-sovereignty contract.
 *
 * The centrepiece is the worked scenario of §3.5: a researcher authorized for
 * a cardiovascular study receives haematological and accelerometry data only,
 * with steroidal, psychological and genetic categories refused automatically.
 * In the manuscript that scenario is asserted in prose. Here it executes.
 */

import { expect } from 'chai';
import { Context } from 'fabric-contract-api';
import fc from 'fast-check';
import { ConsentContract } from '../src/consentContract';
import {
  DATA_CATEGORIES,
  DataCategory,
  PURPOSE_LIMITS,
  SPECIAL_CATEGORY,
  evaluateAccess,
} from '../src/abac';
import { asOrg, mockContext } from './mockContext';

const ATHLETE = 'a'.repeat(64);
const FROM = '2026-01-01T00:00:00.000Z';
const UNTIL = '2027-01-01T00:00:00.000Z';

/** Grant consent as the athlete, then return the context to the caller org. */
async function grant(
  cc: ConsentContract,
  ctx: Context,
  opts: {
    to: string;
    purpose: string;
    categories: string;
    special?: boolean;
    from?: string;
    until?: string;
  },
) {
  return cc.recordConsentTransaction(
    asOrg(ctx, 'AthleteMSP'),
    ATHLETE,
    opts.to,
    opts.purpose,
    opts.categories,
    opts.from ?? FROM,
    opts.until ?? UNTIL,
    String(opts.special ?? false),
  );
}

describe('§3.5 worked scenario — cardiovascular research authorization', () => {
  it('releases haematological and accelerometry only; refuses the other four', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('AthleteMSP');

    // The athlete consents to the cardiovascular study, offering every category.
    await grant(cc, ctx, {
      to: 'ResearchMSP',
      purpose: 'cardiovascular_research',
      categories: DATA_CATEGORIES.join(','),
      special: true,
    });

    // The researcher asks for everything.
    const decision = JSON.parse(
      await cc.validateConsent(
        asOrg(ctx, 'ResearchMSP'),
        ATHLETE,
        'cardiovascular_research',
        DATA_CATEGORIES.join(','),
      ),
    );

    expect(decision.granted).to.have.members(['abp_haematological', 'gps_accelerometry']);
    expect(decision.denied).to.have.members([
      'biochemical_markers',
      'abp_steroidal',
      'psychological',
      'genetic',
    ]);

    // Every refusal must carry an auditable reason and article.
    for (const outcome of decision.outcomes) {
      expect(outcome.reason).to.be.a('string').with.length.greaterThan(10);
      expect(outcome.gdprArticle).to.be.a('string').with.length.greaterThan(0);
    }
    const steroidal = decision.outcomes.find(
      (o: { category: string }) => o.category === 'abp_steroidal',
    );
    expect(steroidal.reason).to.contain('data minimisation');
  });

  it('records the access decision on-chain whether or not data was released', async () => {
    const cc = new ConsentContract();
    const { ctx, stub } = mockContext('AthleteMSP');
    await grant(cc, ctx, {
      to: 'ResearchMSP',
      purpose: 'cardiovascular_research',
      categories: 'abp_haematological,gps_accelerometry',
      special: true,
    });
    await cc.validateConsent(
      asOrg(ctx, 'ResearchMSP'),
      ATHLETE,
      'cardiovascular_research',
      'genetic',
    );
    const audits = stub.events.filter((e) => e.name === 'AccessDecision');
    expect(audits).to.have.lengthOf(1);
    expect((audits[0].payload as { anyGranted: boolean }).anyGranted).to.equal(false);
  });
});

describe('Deny by default — GDPR Article 25', () => {
  it('an athlete with no consent record releases nothing', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('ResearchMSP');
    const decision = JSON.parse(
      await cc.validateConsent(
        ctx,
        ATHLETE,
        'cardiovascular_research',
        DATA_CATEGORIES.join(','),
      ),
    );
    expect(decision.granted).to.be.empty;
    expect(decision.denied).to.have.lengthOf(DATA_CATEGORIES.length);
    expect(decision.outcomes[0].reason).to.contain('deny by default');
  });

  it('applyDefaultPrivacySettings shares nothing with anyone', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('AthleteMSP');
    const settings = JSON.parse(await cc.applyDefaultPrivacySettings(ctx, ATHLETE));
    expect(settings.categories).to.be.empty;
    expect(settings.revoked).to.equal(true);
    expect(settings.gdprArticle).to.equal('Article 25(2)');
  });

  it('an unrecognised purpose releases nothing', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('AthleteMSP');
    await grant(cc, ctx, {
      to: 'ResearchMSP',
      purpose: 'commercial_resale',
      categories: 'genetic',
      special: true,
    });
    const decision = JSON.parse(
      await cc.validateConsent(asOrg(ctx, 'ResearchMSP'), ATHLETE, 'commercial_resale', 'genetic'),
    );
    expect(decision.granted).to.be.empty;
    expect(decision.outcomes[0].reason).to.contain('not a recognised processing purpose');
  });
});

describe('Purpose limitation and consent scope — GDPR Articles 5 and 7', () => {
  it('consent given for one purpose does not authorize another', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('AthleteMSP');
    await grant(cc, ctx, {
      to: 'ResearchMSP',
      purpose: 'cardiovascular_research',
      categories: 'abp_haematological',
      special: true,
    });
    const decision = JSON.parse(
      await cc.validateConsent(
        asOrg(ctx, 'ResearchMSP'),
        ATHLETE,
        'genetic_research',
        'genetic',
      ),
    );
    expect(decision.granted).to.be.empty;
  });

  it('consent given to one organization does not authorize another', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('AthleteMSP');
    await grant(cc, ctx, {
      to: 'ResearchMSP',
      purpose: 'cardiovascular_research',
      categories: 'abp_haematological',
      special: true,
    });
    const decision = JSON.parse(
      await cc.validateConsent(
        asOrg(ctx, 'FederationMSP'),
        ATHLETE,
        'cardiovascular_research',
        'abp_haematological',
      ),
    );
    expect(decision.granted).to.be.empty;
  });

  it('expired consent releases nothing', async () => {
    const cc = new ConsentContract();
    const { ctx, stub } = mockContext('AthleteMSP');
    await grant(cc, ctx, {
      to: 'ResearchMSP',
      purpose: 'cardiovascular_research',
      categories: 'abp_haematological',
      special: true,
      from: '2020-01-01T00:00:00.000Z',
      until: '2021-01-01T00:00:00.000Z',
    });
    stub.now = new Date('2026-06-01T00:00:00.000Z');
    const decision = JSON.parse(
      await cc.validateConsent(
        asOrg(ctx, 'ResearchMSP'),
        ATHLETE,
        'cardiovascular_research',
        'abp_haematological',
      ),
    );
    expect(decision.granted).to.be.empty;
    expect(decision.outcomes[0].reason).to.contain('validity period');
  });

  it('withdrawal takes effect immediately — GDPR Article 7(3)', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('AthleteMSP');
    await grant(cc, ctx, {
      to: 'ResearchMSP',
      purpose: 'cardiovascular_research',
      categories: 'abp_haematological',
      special: true,
    });
    let decision = JSON.parse(
      await cc.validateConsent(
        asOrg(ctx, 'ResearchMSP'),
        ATHLETE,
        'cardiovascular_research',
        'abp_haematological',
      ),
    );
    expect(decision.granted).to.deep.equal(['abp_haematological']);

    await cc.withdrawConsent(
      asOrg(ctx, 'AthleteMSP'),
      ATHLETE,
      'ResearchMSP',
      'cardiovascular_research',
    );
    decision = JSON.parse(
      await cc.validateConsent(
        asOrg(ctx, 'ResearchMSP'),
        ATHLETE,
        'cardiovascular_research',
        'abp_haematological',
      ),
    );
    expect(decision.granted).to.be.empty;
    expect(decision.outcomes[0].reason).to.contain('withdrawn');
  });

  it('only the athlete may grant or withdraw consent over their own data', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('FederationMSP');
    await expect(
      cc.recordConsentTransaction(
        ctx,
        ATHLETE,
        'ResearchMSP',
        'cardiovascular_research',
        'abp_haematological',
        FROM,
        UNTIL,
        'true',
      ),
    ).to.be.rejectedWith(/only the athlete may grant or withdraw consent/);
  });
});

describe('Special-category data — GDPR Article 9', () => {
  it('refuses special-category data without an explicit Article 9 authorization', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('AthleteMSP');
    await grant(cc, ctx, {
      to: 'ResearchMSP',
      purpose: 'cardiovascular_research',
      categories: 'abp_haematological,gps_accelerometry',
      special: false,
    });
    const decision = JSON.parse(
      await cc.validateConsent(
        asOrg(ctx, 'ResearchMSP'),
        ATHLETE,
        'cardiovascular_research',
        'abp_haematological,gps_accelerometry',
      ),
    );
    // Accelerometry is not special-category, so it still passes.
    expect(decision.granted).to.deep.equal(['gps_accelerometry']);
    const haem = decision.outcomes.find(
      (o: { category: string }) => o.category === 'abp_haematological',
    );
    expect(haem.gdprArticle).to.equal('Article 9');
  });

  it('checkSpecialCategoryAuthorization reports the authorization state', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('AthleteMSP');
    await grant(cc, ctx, {
      to: 'ResearchMSP',
      purpose: 'cardiovascular_research',
      categories: 'abp_haematological',
      special: true,
    });
    const out = JSON.parse(
      await cc.checkSpecialCategoryAuthorization(
        asOrg(ctx, 'ResearchMSP'),
        ATHLETE,
        'cardiovascular_research',
        'abp_haematological,gps_accelerometry',
      ),
    );
    expect(out.specialCategoriesRequested).to.deep.equal(['abp_haematological']);
    expect(out.authorised).to.equal(true);
  });
});

describe('Article 22 — human oversight of automated decisions', () => {
  it('refuses an oversight record with no prior review flag', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('NADOMSP');
    await expect(
      cc.enforceOversightRequirement(
        ctx,
        ATHLETE,
        'PROVISIONAL_SUSPENSION',
        'reviewer-7',
        'UPHOLD',
        'reviewed',
      ),
    ).to.be.rejectedWith(/no human-review flag exists/);
  });

  it('requires a named reviewer and a rationale', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('NADOMSP');
    await cc.flagForHumanReview(ctx, ATHLETE, 'PROVISIONAL_SUSPENSION', 'automated AAF');
    await expect(
      cc.enforceOversightRequirement(ctx, ATHLETE, 'PROVISIONAL_SUSPENSION', '', 'UPHOLD', 'x'),
    ).to.be.rejectedWith(/named human reviewer/);
    await expect(
      cc.enforceOversightRequirement(
        ctx,
        ATHLETE,
        'PROVISIONAL_SUSPENSION',
        'reviewer-7',
        'UPHOLD',
        '',
      ),
    ).to.be.rejectedWith(/recorded rationale/);
  });

  it('resolves the flag once oversight is recorded', async () => {
    const cc = new ConsentContract();
    const { ctx, stub } = mockContext('NADOMSP');
    await cc.flagForHumanReview(ctx, ATHLETE, 'PROVISIONAL_SUSPENSION', 'automated AAF');
    const record = JSON.parse(
      await cc.enforceOversightRequirement(
        ctx,
        ATHLETE,
        'PROVISIONAL_SUSPENSION',
        'reviewer-7',
        'UPHOLD',
        'chain of custody complete',
      ),
    );
    expect(record.reviewerId).to.equal('reviewer-7');
    expect(stub.events.map((e) => e.name)).to.include('OversightRecorded');
  });
});

describe('Article 17 — right to erasure', () => {
  const CID = 'bafkreiabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrs';

  async function registerPayload(cc: ConsentContract, ctx: Context) {
    return cc.registerOffchainPayload(
      asOrg(ctx, 'LabMSP'),
      ATHLETE,
      'abp_haematological',
      CID,
      'key-1234',
      'd'.repeat(64),
    );
  }

  it('records only a CID and a key reference on-chain', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('LabMSP');
    const record = JSON.parse(await registerPayload(cc, ctx));
    expect(record.cid).to.equal(CID);
    expect(record.keyRef).to.equal('key-1234');
    expect(Object.keys(record)).to.not.include('payload');
  });

  it('revokeDataAccessKey marks the key revoked on-chain', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('LabMSP');
    await registerPayload(cc, ctx);
    const out = JSON.parse(
      await cc.revokeDataAccessKey(asOrg(ctx, 'AthleteMSP'), ATHLETE, 'abp_haematological'),
    );
    expect(out.keyRevoked).to.equal(true);
    expect(out.gdprArticle).to.equal('Article 17');
  });

  it('destroyIPFSAccessToken rejects a certificate for a different CID', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('LabMSP');
    await registerPayload(cc, ctx);
    await expect(
      cc.destroyIPFSAccessToken(
        asOrg(ctx, 'AthleteMSP'),
        ATHLETE,
        'abp_haematological',
        JSON.stringify({ cid: 'bafk-somethingelse', keyDestroyed: true }),
      ),
    ).to.be.rejectedWith(/erasure certificate is for/);
  });

  it('destroyIPFSAccessToken rejects a certificate that does not attest key destruction', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('LabMSP');
    await registerPayload(cc, ctx);
    await expect(
      cc.destroyIPFSAccessToken(
        asOrg(ctx, 'AthleteMSP'),
        ATHLETE,
        'abp_haematological',
        JSON.stringify({ cid: CID, keyDestroyed: false }),
      ),
    ).to.be.rejectedWith(/does not attest that the key was destroyed/);
  });

  it('records the erasure certificate and carries the legal caveat forward', async () => {
    const cc = new ConsentContract();
    const { ctx, stub } = mockContext('LabMSP');
    await registerPayload(cc, ctx);
    const out = JSON.parse(
      await cc.destroyIPFSAccessToken(
        asOrg(ctx, 'AthleteMSP'),
        ATHLETE,
        'abp_haematological',
        JSON.stringify({ cid: CID, keyDestroyed: true, complete: true }),
      ),
    );
    expect(out.legalCaveat).to.contain('not confirmed by supervisory authorities');
    expect(stub.events.map((e) => e.name)).to.include('IPFSAccessTokenDestroyed');
  });

  it('only the athlete may invoke erasure over their own data', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('LabMSP');
    await registerPayload(cc, ctx);
    await expect(
      cc.revokeDataAccessKey(asOrg(ctx, 'FederationMSP'), ATHLETE, 'abp_haematological'),
    ).to.be.rejectedWith(/only the athlete/);
  });
});

describe('Input validation', () => {
  it('rejects unknown data categories', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('AthleteMSP');
    await expect(
      cc.recordConsentTransaction(
        ctx,
        ATHLETE,
        'ResearchMSP',
        'cardiovascular_research',
        'blood_pressure',
        FROM,
        UNTIL,
        'true',
      ),
    ).to.be.rejectedWith(/unknown data categories/);
  });

  it('rejects an inverted validity period', async () => {
    const cc = new ConsentContract();
    const { ctx } = mockContext('AthleteMSP');
    await expect(
      cc.recordConsentTransaction(
        ctx,
        ATHLETE,
        'ResearchMSP',
        'cardiovascular_research',
        'genetic',
        UNTIL,
        FROM,
        'true',
      ),
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
