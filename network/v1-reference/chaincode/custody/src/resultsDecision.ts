/**
 * Table 2 of the manuscript, as an executing decision engine.
 *
 * `decideResultsAction` is pure, total and deterministic over the Q001-Q007
 * condition space. Purity is what makes the regulatory logic exhaustively
 * verifiable: the space has 2 x 3 x 2 x 2 x 2 x 2 x 2 = 192 points, and the
 * test suite enumerates every one of them.
 *
 * ---------------------------------------------------------------------------
 * TWO SPECIFICATION GAPS SURFACED BY IMPLEMENTATION
 *
 * The manuscript's Table 2 lists five rows without stating (a) what happens
 * when several rows match the same fact vector, or (b) what happens when
 * laboratory accreditation is affirmatively UNVERIFIED rather than PENDING.
 * Prose decision tables can leave this implicit; executable code cannot.
 *
 * Gap 1 - rule precedence. Rows 1 (AAF Confirmed) and 4 (Whereabouts ADRV) can
 *   both match, as can rows 3 and 4. We resolve precedence as:
 *
 *       R5 Process Invalidated  (guard, evaluated first)
 *     > R1 AAF Confirmed / R2 AAF Pending / R2b Analysis Rejected
 *     > R3 ABP Alert Initiated
 *     > R4 Whereabouts ADRV
 *
 *   R5 is promoted to a precondition guard because an adverse analytical
 *   finding asserted on an unverified chain of custody is exactly the
 *   Sochi-type failure the framework exists to prevent: no downstream
 *   regulatory consequence may be derived from an invalid custody chain.
 *   The remaining order follows statutory urgency — Article 7.3 imposes the
 *   tightest clock, so an AAF outranks a passport alert, which outranks a
 *   whereabouts violation. Lower-precedence matches are not discarded: they
 *   are reported in `concurrentMatches` so results management retains them.
 *
 * Gap 2 - Q002 = UNVERIFIED. Table 2 covers YES and PENDING only. An analysis
 *   returned by a laboratory whose accreditation is affirmatively unverified
 *   cannot support an AAF and must not merely wait for human review; it is
 *   rejected and audited (R2b).
 *
 * Both refinements are reported in the Implementation section of the revised
 * manuscript as findings, not silently absorbed.
 * ---------------------------------------------------------------------------
 */

import { AccreditationState, DecisionFacts } from './types';

export enum ResultsAction {
  ProcessInvalidated = 'PROCESS_INVALIDATED',
  AafConfirmed = 'AAF_CONFIRMED',
  AafPendingReview = 'AAF_PENDING_REVIEW',
  AnalysisRejected = 'ANALYSIS_REJECTED',
  AbpAlertInitiated = 'ABP_ALERT_INITIATED',
  WhereaboutsAdrv = 'WHEREABOUTS_ADRV',
  NoActionRequired = 'NO_ACTION_REQUIRED',
}

export interface ResultsDecision {
  action: ResultsAction;
  /** Stable rule identifier, used by tests and by the audit trail. */
  ruleId: string;
  /** WADA Code (or GDPR) article the rule enforces. */
  wadaArticle: string;
  /** Chaincode functions the engine directs results management to invoke. */
  invokedFunctions: string[];
  /** GDPR Art. 22 — automated processing must stop pending human review. */
  humanOversightRequired: boolean;
  /** Organizations that must receive a mandatory audit alert. */
  auditAlertRecipients: string[];
  /** WADA Art. 14.1 — result is confidential during results management. */
  confidential: boolean;
  /** Lower-precedence rules that also matched; retained, never discarded. */
  concurrentMatches: string[];
  rationale: string;
}

interface Rule {
  id: string;
  matches: (f: DecisionFacts) => boolean;
  decide: (f: DecisionFacts) => Omit<ResultsDecision, 'concurrentMatches'>;
}

const accreditation = (f: DecisionFacts): AccreditationState => f.laboratoryAccreditation;

/**
 * Rules in strict precedence order. The first match wins; every later match is
 * recorded in `concurrentMatches`.
 */
const RULES: Rule[] = [
  {
    // Table 2, row 5 — promoted to a guard (see Gap 1 above).
    id: 'R5_PROCESS_INVALIDATED',
    matches: (f) => !f.mandatoryCustodyStepVerified,
    decide: () => ({
      action: ResultsAction.ProcessInvalidated,
      ruleId: 'R5_PROCESS_INVALIDATED',
      wadaArticle: 'Article 5.4',
      invokedFunctions: ['invalidateSampleRecord', 'raiseAuditAlert'],
      humanOversightRequired: true,
      auditAlertRecipients: ['NADOMSP', 'WADA'],
      confidential: true,
      rationale:
        'A mandatory custody step is unverified (Q007 = NO). No regulatory ' +
        'consequence may be derived from an incomplete chain of custody; the ' +
        'sample record is invalidated and audited.',
    }),
  },
  {
    // Table 2, row 1.
    id: 'R1_AAF_CONFIRMED',
    matches: (f) => f.sampleAnalysisPositive && accreditation(f) === 'VERIFIED',
    decide: () => ({
      action: ResultsAction.AafConfirmed,
      ruleId: 'R1_AAF_CONFIRMED',
      wadaArticle: 'Article 2.1 / 7.1 / 7.3',
      invokedFunctions: ['notifyAthleteOfAAF', 'startArticle73Timeline'],
      humanOversightRequired: false,
      auditAlertRecipients: [],
      confidential: true,
      rationale:
        'Sample analysis positive (Q001 = YES) at an accredited laboratory ' +
        '(Q002 = YES). The adverse analytical finding is confirmed and the ' +
        'Article 7.3 statutory notification timeline starts.',
    }),
  },
  {
    // Table 2, row 2.
    id: 'R2_AAF_PENDING_REVIEW',
    matches: (f) => f.sampleAnalysisPositive && accreditation(f) === 'PENDING',
    decide: () => ({
      action: ResultsAction.AafPendingReview,
      ruleId: 'R2_AAF_PENDING_REVIEW',
      wadaArticle: 'Article 7.1 / GDPR Article 22',
      invokedFunctions: ['suspendAutomatedProcessing', 'flagForHumanReview'],
      humanOversightRequired: true,
      auditAlertRecipients: [],
      confidential: true,
      rationale:
        'Sample analysis positive (Q001 = YES) but laboratory accreditation ' +
        'is pending (Q002 = PENDING). Automated processing is suspended and ' +
        'the case is flagged for mandatory human review.',
    }),
  },
  {
    // Gap 2 — not present in Table 2 as published.
    id: 'R2B_ANALYSIS_REJECTED',
    matches: (f) => f.sampleAnalysisPositive && accreditation(f) === 'UNVERIFIED',
    decide: () => ({
      action: ResultsAction.AnalysisRejected,
      ruleId: 'R2B_ANALYSIS_REJECTED',
      wadaArticle: 'Article 6.1 (analysis by accredited laboratories)',
      invokedFunctions: ['rejectAnalysisResult', 'raiseAuditAlert'],
      humanOversightRequired: true,
      auditAlertRecipients: ['NADOMSP', 'WADA'],
      confidential: true,
      rationale:
        'Sample analysis positive (Q001 = YES) but the reporting laboratory ' +
        'is not accredited (Q002 = NO). Article 6.1 requires analysis by a ' +
        'WADA-accredited laboratory, so the result cannot support an adverse ' +
        'analytical finding and is rejected with an audit alert.',
    }),
  },
  {
    // Table 2, row 3.
    id: 'R3_ABP_ALERT_INITIATED',
    matches: (f) => f.longitudinalProfileAnomaly && f.expertPanelReviewRequired,
    decide: () => ({
      action: ResultsAction.AbpAlertInitiated,
      ruleId: 'R3_ABP_ALERT_INITIATED',
      wadaArticle: 'Athlete Biological Passport / GDPR Article 22',
      invokedFunctions: ['notifyExpertPanel', 'enforceOversightRequirement'],
      humanOversightRequired: true,
      auditAlertRecipients: [],
      confidential: true,
      rationale:
        'Longitudinal profile anomaly flagged (Q003 = YES) with expert panel ' +
        'review required (Q004 = YES). The Athlete Passport Expert Panel is ' +
        'notified and a GDPR Article 22 human oversight record is enforced.',
    }),
  },
  {
    // Table 2, row 4.
    id: 'R4_WHEREABOUTS_ADRV',
    matches: (f) => f.thirdWhereaboutsFailure && f.allFailuresLedgerVerified,
    decide: () => ({
      action: ResultsAction.WhereaboutsAdrv,
      ruleId: 'R4_WHEREABOUTS_ADRV',
      wadaArticle: 'Article 2.4 / 7.1',
      invokedFunctions: ['recordWhereaboutsAdrv', 'startArticle7Timeline'],
      humanOversightRequired: false,
      auditAlertRecipients: [],
      confidential: true,
      rationale:
        'Third whereabouts failure inside a rolling 12-month window ' +
        '(Q005 = YES) with all failures ledger-verified (Q006 = YES). An ' +
        'anti-doping rule violation is recorded under Article 2.4.',
    }),
  },
];

const NO_ACTION: Omit<ResultsDecision, 'concurrentMatches'> = {
  action: ResultsAction.NoActionRequired,
  ruleId: 'R0_NO_ACTION',
  wadaArticle: 'n/a',
  invokedFunctions: [],
  humanOversightRequired: false,
  auditAlertRecipients: [],
  confidential: true,
  rationale: 'No Table 2 condition is satisfied; no results-management action is due.',
};

/**
 * Evaluate the Table 2 decision logic.
 *
 * Total: returns a decision for every point in the Q001-Q007 space.
 * Deterministic: depends on `facts` alone — no clock, no ledger, no randomness.
 */
export function decideResultsAction(facts: DecisionFacts): ResultsDecision {
  const matched = RULES.filter((r) => r.matches(facts));

  if (matched.length === 0) {
    return { ...NO_ACTION, concurrentMatches: [] };
  }

  const [winner, ...rest] = matched;
  return {
    ...winner.decide(facts),
    concurrentMatches: rest.map((r) => r.id),
  };
}

/** Rule identifiers in precedence order — used by tests and documentation. */
export const RULE_IDS = RULES.map((r) => r.id);

/**
 * Enumerate the complete Q001-Q007 condition space (192 vectors).
 * Used by the exhaustive verification suite and by the Caliper workloads.
 */
export function enumerateConditionSpace(): DecisionFacts[] {
  const bools = [true, false];
  const accreditations: AccreditationState[] = ['VERIFIED', 'PENDING', 'UNVERIFIED'];
  const space: DecisionFacts[] = [];

  for (const q001 of bools)
    for (const q002 of accreditations)
      for (const q003 of bools)
        for (const q004 of bools)
          for (const q005 of bools)
            for (const q006 of bools)
              for (const q007 of bools)
                space.push({
                  sampleAnalysisPositive: q001,
                  laboratoryAccreditation: q002,
                  longitudinalProfileAnomaly: q003,
                  expertPanelReviewRequired: q004,
                  thirdWhereaboutsFailure: q005,
                  allFailuresLedgerVerified: q006,
                  mandatoryCustodyStepVerified: q007,
                });

  return space;
}
