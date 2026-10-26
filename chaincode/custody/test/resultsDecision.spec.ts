/**
 * Verification of the Table 1 decision engine.
 *
 * The scope is the decision logic, not the deployed chaincode as a whole:
 *
 *   1. every Table 1 row is executed and asserted (row coverage);
 *   2. the complete Q001-Q007 condition space (192 vectors) is enumerated and
 *      checked for totality, determinism and well-formedness (exhaustive
 *      verification, not sampling);
 *   3. regulatory invariants are asserted as properties over randomly
 *      generated fact vectors (property-based testing).
 */

import { expect } from 'chai';
import fc from 'fast-check';
import {
  decideResultsAction,
  enumerateConditionSpace,
  ResultsAction,
  RULE_IDS,
} from '../src/resultsDecision';
import { AccreditationState, DecisionFacts } from '../src/types';
import { writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';

const baseFacts: DecisionFacts = {
  sampleAnalysisPositive: false,
  laboratoryAccreditation: 'VERIFIED',
  longitudinalProfileAnomaly: false,
  expertPanelReviewRequired: false,
  thirdWhereaboutsFailure: false,
  allFailuresLedgerVerified: false,
  mandatoryCustodyStepVerified: true,
};

const facts = (o: Partial<DecisionFacts>): DecisionFacts => ({ ...baseFacts, ...o });

describe('Table 1 — rows as first specified', () => {
  it('row 1: AAF Confirmed when Q001=YES and Q002=YES', () => {
    const d = decideResultsAction(
      facts({ sampleAnalysisPositive: true, laboratoryAccreditation: 'VERIFIED' }),
    );
    expect(d.action).to.equal(ResultsAction.AafConfirmed);
    expect(d.invokedFunctions).to.include('notifyAthleteOfAAF');
    expect(d.invokedFunctions).to.include('startNotificationDeadline');
    expect(d.wadaArticle).to.contain('7.2');
    expect(d.humanOversightRequired).to.equal(false);
  });

  it('row 2: AAF Pending Review when Q001=YES and Q002=PENDING', () => {
    const d = decideResultsAction(
      facts({ sampleAnalysisPositive: true, laboratoryAccreditation: 'PENDING' }),
    );
    expect(d.action).to.equal(ResultsAction.AafPendingReview);
    expect(d.invokedFunctions).to.include('suspendAutomatedProcessing');
    expect(d.invokedFunctions).to.include('flagForHumanReview');
    expect(d.humanOversightRequired).to.equal(true);
  });

  it('row 3: ABP Alert Initiated when Q003=YES and Q004=YES', () => {
    const d = decideResultsAction(
      facts({ longitudinalProfileAnomaly: true, expertPanelReviewRequired: true }),
    );
    expect(d.action).to.equal(ResultsAction.AbpAlertInitiated);
    expect(d.invokedFunctions).to.include('notifyExpertPanel');
    expect(d.invokedFunctions).to.include('enforceOversightRequirement');
    expect(d.humanOversightRequired).to.equal(true);
  });

  it('row 4: Whereabouts ADRV when Q005=YES and Q006=YES', () => {
    const d = decideResultsAction(
      facts({ thirdWhereaboutsFailure: true, allFailuresLedgerVerified: true }),
    );
    expect(d.action).to.equal(ResultsAction.WhereaboutsAdrv);
    expect(d.wadaArticle).to.contain('2.4');
    expect(d.invokedFunctions).to.include('recordWhereaboutsAdrv');
  });

  it('row 5: Process Invalidated when Q007=NO', () => {
    const d = decideResultsAction(facts({ mandatoryCustodyStepVerified: false }));
    expect(d.action).to.equal(ResultsAction.ProcessInvalidated);
    expect(d.auditAlertRecipients).to.have.members(['NADOMSP', 'WADA']);
  });

  it('no rule fires when no condition is satisfied', () => {
    expect(decideResultsAction(baseFacts).action).to.equal(ResultsAction.NoActionRequired);
  });
});

describe('Table 1 — formalisation decisions F1 (hit policy) and F2 (completeness)', () => {
  it('F1: an invalid custody chain suppresses an otherwise confirmed AAF', () => {
    const d = decideResultsAction(
      facts({
        sampleAnalysisPositive: true,
        laboratoryAccreditation: 'VERIFIED',
        mandatoryCustodyStepVerified: false,
      }),
    );
    expect(d.action).to.equal(ResultsAction.ProcessInvalidated);
    expect(d.concurrentMatches).to.include('R1_AAF_CONFIRMED');
  });

  it('F1: an AAF outranks a concurrent whereabouts violation but does not erase it', () => {
    const d = decideResultsAction(
      facts({
        sampleAnalysisPositive: true,
        laboratoryAccreditation: 'VERIFIED',
        thirdWhereaboutsFailure: true,
        allFailuresLedgerVerified: true,
      }),
    );
    expect(d.action).to.equal(ResultsAction.AafConfirmed);
    expect(d.concurrentMatches).to.include('R4_WHEREABOUTS_ADRV');
  });

  it('F2: Q002=UNVERIFIED rejects the analysis rather than queueing human review', () => {
    const d = decideResultsAction(
      facts({ sampleAnalysisPositive: true, laboratoryAccreditation: 'UNVERIFIED' }),
    );
    expect(d.action).to.equal(ResultsAction.AnalysisRejected);
    expect(d.wadaArticle).to.contain('6.1');
    expect(d.auditAlertRecipients).to.include('WADA');
  });
});

describe('Exhaustive verification of the Q001-Q007 condition space', () => {
  const space = enumerateConditionSpace();

  it('enumerates exactly 192 distinct condition vectors', () => {
    expect(space).to.have.lengthOf(192);
    expect(new Set(space.map((f) => JSON.stringify(f))).size).to.equal(192);
  });

  it('is total: every vector yields a decision', () => {
    for (const f of space) {
      const d = decideResultsAction(f);
      expect(d, JSON.stringify(f)).to.be.an('object');
      expect(Object.values(ResultsAction)).to.include(d.action);
    }
  });

  it('is deterministic: repeated evaluation is identical', () => {
    for (const f of space) {
      expect(JSON.stringify(decideResultsAction(f))).to.equal(
        JSON.stringify(decideResultsAction(f)),
      );
    }
  });

  it('every decision is well-formed and traceable', () => {
    for (const f of space) {
      const d = decideResultsAction(f);
      expect(d.rationale, JSON.stringify(f)).to.be.a('string').with.length.greaterThan(20);
      expect(d.ruleId).to.be.a('string').with.length.greaterThan(0);
      if (d.action !== ResultsAction.NoActionRequired) {
        expect(RULE_IDS, JSON.stringify(f)).to.include(d.ruleId);
      }
    }
  });

  it('reaches every rule in the engine at least once', () => {
    const reached = new Set(space.map((f) => decideResultsAction(f).ruleId));
    for (const id of RULE_IDS) {
      expect(reached, `rule ${id} is unreachable`).to.include(id);
    }
  });

  it('reports the number of vectors resolving to each action (coverage table)', () => {
    const tally: Record<string, number> = {};
    for (const f of space) {
      const a = decideResultsAction(f).action;
      tally[a] = (tally[a] ?? 0) + 1;
    }
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    expect(total).to.equal(192);
    // Printed so the figure can be cited in the Evaluation section.
    // eslint-disable-next-line no-console
    console.log('        condition-space coverage:', JSON.stringify(tally));
  });
});

describe('Regulatory invariants (property-based)', () => {
  const arbFacts = fc.record({
    sampleAnalysisPositive: fc.boolean(),
    laboratoryAccreditation: fc.constantFrom<AccreditationState>(
      'VERIFIED',
      'PENDING',
      'UNVERIFIED',
    ),
    longitudinalProfileAnomaly: fc.boolean(),
    expertPanelReviewRequired: fc.boolean(),
    thirdWhereaboutsFailure: fc.boolean(),
    allFailuresLedgerVerified: fc.boolean(),
    mandatoryCustodyStepVerified: fc.boolean(),
  });

  it('INV-1: an unverified custody chain always invalidates the process', () => {
    fc.assert(
      fc.property(arbFacts, (f) => {
        if (!f.mandatoryCustodyStepVerified) {
          return decideResultsAction(f).action === ResultsAction.ProcessInvalidated;
        }
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it('INV-2: an AAF is confirmed only on a verified chain at an accredited laboratory', () => {
    fc.assert(
      fc.property(arbFacts, (f) => {
        const d = decideResultsAction(f);
        if (d.action === ResultsAction.AafConfirmed) {
          return (
            f.sampleAnalysisPositive &&
            f.laboratoryAccreditation === 'VERIFIED' &&
            f.mandatoryCustodyStepVerified
          );
        }
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it('INV-3: no adverse outcome is reached without a positive analysis or a whereabouts failure', () => {
    fc.assert(
      fc.property(arbFacts, (f) => {
        const d = decideResultsAction(f);
        const adverse = [
          ResultsAction.AafConfirmed,
          ResultsAction.AafPendingReview,
          ResultsAction.WhereaboutsAdrv,
        ];
        if (adverse.includes(d.action)) {
          return f.sampleAnalysisPositive || f.thirdWhereaboutsFailure;
        }
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it('INV-4: GDPR Art. 22 — every uncertain outcome demands human oversight', () => {
    fc.assert(
      fc.property(arbFacts, (f) => {
        const d = decideResultsAction(f);
        const mustReview = [
          ResultsAction.AafPendingReview,
          ResultsAction.AbpAlertInitiated,
          ResultsAction.AnalysisRejected,
          ResultsAction.ProcessInvalidated,
        ];
        return !mustReview.includes(d.action) || d.humanOversightRequired;
      }),
      { numRuns: 2000 },
    );
  });

  it('INV-5: WADA Art. 14.1 — every decision is confidential', () => {
    fc.assert(
      fc.property(arbFacts, (f) => decideResultsAction(f).confidential === true),
      { numRuns: 2000 },
    );
  });

  it('INV-6: a whereabouts ADRV requires all failures to be ledger-verified', () => {
    fc.assert(
      fc.property(arbFacts, (f) => {
        const d = decideResultsAction(f);
        if (d.action === ResultsAction.WhereaboutsAdrv) {
          return f.thirdWhereaboutsFailure && f.allFailuresLedgerVerified;
        }
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it('INV-7: purity — evaluation never mutates its input', () => {
    fc.assert(
      fc.property(arbFacts, (f) => {
        const before = JSON.stringify(f);
        decideResultsAction(f);
        return JSON.stringify(f) === before;
      }),
      { numRuns: 2000 },
    );
  });
});

/**
 * The evidence behind formalisation decisions F1 and F2: the five rows as
 * first specified, evaluated over the complete condition space without a hit
 * policy or a default. Written to docs/formalisation-statistics.json so the
 * counts quoted in the manuscript are regenerated by the test suite.
 */
describe('Formalisation evidence over the complete condition space', () => {
  const asFirstSpecified: Record<string, (f: DecisionFacts) => boolean> = {
    R1: (f) => f.sampleAnalysisPositive && f.laboratoryAccreditation === 'VERIFIED',
    R2: (f) => f.sampleAnalysisPositive && f.laboratoryAccreditation === 'PENDING',
    R3: (f) => f.longitudinalProfileAnomaly && f.expertPanelReviewRequired,
    R4: (f) => f.thirdWhereaboutsFailure && f.allFailuresLedgerVerified,
    R5: (f) => !f.mandatoryCustodyStepVerified,
  };

  it('counts the vectors the first specification left multiply matched or unmatched', () => {
    const space = enumerateConditionSpace();
    let unmatched = 0;
    let multiplyMatched = 0;
    let conflicting = 0;
    let positiveUnverified = 0;
    let positiveUnverifiedUnmatched = 0;
    const overlapPatterns: Record<string, number> = {};
    for (const f of space) {
      const hits = Object.keys(asFirstSpecified).filter((r) => asFirstSpecified[r](f));
      if (hits.length === 0) unmatched += 1;
      if (hits.length > 1) {
        multiplyMatched += 1;
        overlapPatterns[hits.join('+')] = (overlapPatterns[hits.join('+')] ?? 0) + 1;
        // Rows prescribing different actions: every pair here does.
        conflicting += 1;
      }
      if (f.sampleAnalysisPositive && f.laboratoryAccreditation === 'UNVERIFIED') {
        positiveUnverified += 1;
        if (hits.length === 0) positiveUnverifiedUnmatched += 1;
      }
    }
    const implemented: Record<string, number> = {};
    let withConcurrent = 0;
    for (const f of space) {
      const d = decideResultsAction(f);
      implemented[d.ruleId] = (implemented[d.ruleId] ?? 0) + 1;
      if (d.concurrentMatches.length > 0) withConcurrent += 1;
    }
    const stats = {
      vectors: space.length,
      firstSpecification: { unmatched, multiplyMatched, conflicting, overlapPatterns, positiveUnverified, positiveUnverifiedUnmatched },
      implemented: { outcomes: implemented, vectorsWithRetainedConcurrentMatches: withConcurrent },
    };
    const out = path.resolve(__dirname, '../../../docs/formalisation-statistics.json');
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(stats, null, 2)}\n`);
    console.log('        ' + JSON.stringify(stats));

    expect(unmatched + multiplyMatched).to.be.greaterThan(0);
    expect(Object.values(implemented).reduce((a, b) => a + b, 0)).to.equal(192);
  });
});
