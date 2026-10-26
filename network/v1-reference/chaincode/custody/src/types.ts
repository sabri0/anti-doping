/**
 * Domain types for the anti-doping chain-of-custody chaincode.
 *
 * Names follow the manuscript: Table 1 maps WADA Code articles to smart
 * contract functions, Table 2 defines the results-management decision logic
 * over conditions Q001-Q007.
 */

/** Ledger key prefixes. Composite keys keep related records range-queryable. */
export const KEY = {
  SAMPLE: 'SAMPLE',
  CUSTODY: 'CUSTODY',
  ANALYSIS: 'ANALYSIS',
  RESULTS: 'RESULTS',
  WHEREABOUTS: 'WHEREABOUTS',
  OVERSIGHT: 'OVERSIGHT',
  SUSPENSION: 'SUSPENSION',
  EXCEPTION: 'EXCEPTION',
  PROHIBITED_LIST: 'PROHIBITEDLIST',
} as const;

/** MSP identifiers, one per organizational class of §3.2. */
export const MSP = {
  ATHLETE: 'AthleteMSP',
  FEDERATION: 'FederationMSP',
  NADO: 'NADOMSP',
  LAB: 'LabMSP',
  RESEARCH: 'ResearchMSP',
} as const;

/** Custody chain phases, per WADA Code Article 5 (§3.4 of the manuscript). */
export type CustodyPhase =
  | 'COLLECTION'
  | 'TRANSPORT_HANDOFF'
  | 'LABORATORY_RECEIPT'
  | 'LABORATORY_INTERNAL'
  | 'ANALYSIS_COMPLETE';

/** Mandatory custody steps. Q007 is satisfied only when all of these exist. */
export const MANDATORY_CUSTODY_STEPS: CustodyPhase[] = [
  'COLLECTION',
  'TRANSPORT_HANDOFF',
  'LABORATORY_RECEIPT',
];

export type SampleStatus =
  | 'IN_CUSTODY'
  | 'ANALYSED'
  | 'RESULTS_MANAGEMENT'
  | 'INVALIDATED'
  | 'CLOSED';

export interface SampleRecord {
  docType: 'sample';
  sampleCode: string;
  /** Pseudonymized athlete identifier — never a direct identifier (GDPR Art. 25). */
  athleteHash: string;
  sealedContainerHash: string;
  collectionLocation: string;
  collectionTimestamp: string;
  initiatingMSP: string;
  status: SampleStatus;
  custodySequence: number;
  /** Version of the WADA Prohibited List the analysis was evaluated against. */
  prohibitedListVersion?: string;
}

export interface CustodyEvent {
  docType: 'custodyEvent';
  sampleCode: string;
  sequence: number;
  phase: CustodyPhase;
  fromMSP: string;
  toMSP: string;
  /** Handover deadline, ISO-8601. Missing acknowledgement past this is an exception. */
  transferDeadline: string;
  recordedAt: string;
  submittingMSP: string;
  containerSealIntact: boolean;
}

export interface AnalysisResult {
  docType: 'analysisResult';
  sampleCode: string;
  laboratoryMSP: string;
  /** true = adverse analytical finding (WADA Art. 2.1). */
  adverse: boolean;
  substance?: string;
  prohibitedListVersion: string;
  prohibitedListHash: string;
  laboratoryAccreditation: AccreditationState;
  recordedAt: string;
}

/** Q002 is tri-state — this is why the decision table is not pure boolean. */
export type AccreditationState = 'VERIFIED' | 'PENDING' | 'UNVERIFIED';

export interface WhereaboutsRecord {
  docType: 'whereabouts';
  athleteHash: string;
  filingId: string;
  /** true = a whereabouts failure (missed test or filing failure), Art. 2.4. */
  failure: boolean;
  /** Whether the failure has been confirmed by a ledger-verified record. */
  ledgerVerified: boolean;
  recordedAt: string;
  recordingMSP: string;
}

export interface OversightRecord {
  docType: 'oversight';
  sampleCode: string;
  /** GDPR Art. 22 — identifies the natural person who reviewed the decision. */
  reviewerId: string;
  reviewerMSP: string;
  decision: 'UPHOLD' | 'REJECT' | 'REQUEST_FURTHER_ANALYSIS';
  rationale: string;
  recordedAt: string;
}

export interface ResultsManagementRecord {
  docType: 'resultsManagement';
  sampleCode: string;
  athleteHash: string;
  action: string;
  ruleId: string;
  wadaArticle: string;
  facts: DecisionFacts;
  invokedFunctions: string[];
  humanOversightRequired: boolean;
  auditAlertRecipients: string[];
  /** Article 7.3 statutory notification deadline, set when an AAF is confirmed. */
  statutoryDeadline?: string;
  confidential: boolean;
  decidedAt: string;
}

export interface ExceptionRecord {
  docType: 'exception';
  sampleCode: string;
  sequence: number;
  reason: string;
  detail: string;
  raisedAt: string;
  alertedMSPs: string[];
}

/**
 * The Q001-Q007 condition vector of Table 2. Every field is explicit; the
 * decision engine is a pure function of this structure and nothing else.
 */
export interface DecisionFacts {
  /** Q001 — sample analysis positive. */
  sampleAnalysisPositive: boolean;
  /** Q002 — laboratory accreditation state (tri-state). */
  laboratoryAccreditation: AccreditationState;
  /** Q003 — longitudinal (ABP) profile anomaly flagged. */
  longitudinalProfileAnomaly: boolean;
  /** Q004 — expert panel review required. */
  expertPanelReviewRequired: boolean;
  /** Q005 — third whereabouts failure inside a rolling 12-month window. */
  thirdWhereaboutsFailure: boolean;
  /** Q006 — all whereabouts failures ledger-verified. */
  allFailuresLedgerVerified: boolean;
  /** Q007 — every mandatory custody step verified. */
  mandatoryCustodyStepVerified: boolean;
}
