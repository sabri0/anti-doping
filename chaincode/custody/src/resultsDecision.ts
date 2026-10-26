/**
 * Table 1 of the manuscript, as an executing decision engine.
 *
 * `decideResultsAction` is pure, total and deterministic over the Q001-Q007
 * condition space. Purity is what makes the regulatory logic exhaustively
 * verifiable: the space has 2 x 3 x 2 x 2 x 2 x 2 x 2 = 192 points, and the
 * test suite enumerates every one of them.
 *
 * ---------------------------------------------------------------------------
 * FORMALISATION LOG (Table 2 of the manuscript; docs/FORMALISATION-LOG.md)
 *
 * The decision table as first specified had five rows and stated neither a
 * hit policy nor a default. In decision-table terms (DMN) it was neither
 * single-hit nor complete. Encoding it as a function that must return exactly
 * one outcome for every input made both visible:
 *
 * F1 - hit policy. Several rows match the same fact vector (for example an
 *   adverse finding concurrent with a third whereabouts failure). Resolved as
 *   a PRIORITY policy:
 *
 *       R5 Process Invalidated  (guard, evaluated first)
 *     > R1 AAF Confirmed / R2 AAF Pending / R2b Analysis Rejected
 *     > R3 ABP Alert Initiated
 *     > R4 Whereabouts ADRV
 *
 *   R5 is a guard because no regulatory consequence may be derived from an
 *   unverified chain of custody. The remaining order follows statutory
 *   urgency. Lower-precedence matches are returned in `concurrentMatches`.
 *
 * F2 - completeness. Q002 = UNVERIFIED with a positive analysis matched no
 *   row (R2b added: rejected and audited, WADA Code Art. 6.1), and vectors
 *   matching no row at all had no outcome (R0 added: no action, recorded).
 *
 * F3-F9 are interpretation decisions taken where the fact vector is assembled
 * from ledger state (custodyContract.ts, assembleFacts) rather than here.
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
    // Table 1, row 5 — promoted to a guard (F1).
    id: 'R5_PROCESS_INVALIDATED',
    matches: (f) => !f.mandatoryCustodyStepVerified,
    decide: () => ({
      action: ResultsAction.ProcessInvalidated,
      ruleId: 'R5_PROCESS_INVALIDATED',
      wadaArticle: 'ISTI chain of custody (Code Art. 5.4.1)',
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
    // Table 1, row 1.
    id: 'R1_AAF_CONFIRMED',
    matches: (f) => f.sampleAnalysisPositive && accreditation(f) === 'VERIFIED',
    decide: () => ({
      action: ResultsAction.AafConfirmed,
      ruleId: 'R1_AAF_CONFIRMED',
      wadaArticle: 'Article 2.1 / 7.1 / 7.2',
      invokedFunctions: ['notifyAthleteOfAAF', 'startNotificationDeadline'],
      humanOversightRequired: false,
      auditAlertRecipients: [],
      confidential: true,
      rationale:
        'Sample analysis positive (Q001 = YES) at an accredited laboratory ' +
        '(Q002 = YES). The adverse analytical finding is confirmed and the ' +
        'deadline for notifying the athlete (Article 7.2) starts.',
    }),
  },
  {
    // Table 1, row 2.
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
    // F2 — absent from the table as first specified.
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
    // Table 1, row 3.
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
    // Table 1, row 4.
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
  rationale: 'No Table 1 condition is satisfied; no results-management action is due.',
};

/**
 * Evaluate the Table 1 decision logic.
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
