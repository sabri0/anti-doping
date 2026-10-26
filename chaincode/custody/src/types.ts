/**
 * Domain types for the anti-doping chain-of-custody chaincode.
 *
 * Names follow the manuscript: Supplementary Table S1 maps WADA Code articles
 * to smart contract functions, Table 1 defines the results-management decision
 * logic over conditions Q001-Q007.
 */

/** Ledger key prefixes. Composite keys keep related records range-queryable. */
export const KEY = {
  SAMPLE: 'SAMPLE',
  CUSTODY: 'CUSTODY',
  ACK: 'COLLECTIONACK',
  ANALYSIS: 'ANALYSIS',
  RESULTS: 'RESULTS',
  AMENDMENT: 'AMENDMENT',
  WHEREABOUTS: 'WHEREABOUTS',
  WHEREABOUTS_SUMMARY: 'WHEREABOUTSSUMMARY',
  OVERSIGHT: 'OVERSIGHT',
  SUSPENSION: 'SUSPENSION',
  NOTIFICATION: 'NOTIFICATION',
  NOTICE: 'ADRVNOTICE',
  NOTICE_STATUS: 'NOTICESTATUS',
  PASSPORT: 'ABP',
  EXCEPTION: 'EXCEPTION',
  RESULTS_EXCEPTION: 'RMEXCEPTION',
  PROHIBITED_LIST: 'PROHIBITEDLIST',
} as const;

/**
 * Private data collection holding everything produced while a case is under
 * review: analysis results, results-management records and their amendments,
 * human-oversight records, passport evaluations and whereabouts failure
 * records. Its members are the NADO, which has results-management
 * responsibility (WADA Code Art. 7.1), and the laboratory that produced the
 * result. Every write to it must be endorsed by both (collection-level
 * endorsement policy, network/collections/custody.json).
 *
 * The rest of the network holds only the hashes of these records, committed
 * in the shared ledger, which is what lets a non-member detect later
 * tampering without being able to read the content.
 */
export const RESULTS_COLLECTION = 'resultsCollection';

/**
 * Private data collection for what WADA Code Article 14.1 says must reach
 * other parties once an anti-doping rule violation is asserted: the notice to
 * the athlete (14.1.1), sent simultaneously to the athlete's NADO, the
 * International Federation and WADA (14.1.2), and status reports thereafter
 * (14.1.4). Members: NADO, laboratory, athlete organisation and federation.
 *
 * A collection's membership is fixed when the chaincode is defined, so an
 * entitlement that begins at an event — here, the notice — cannot be
 * expressed by adding a member to the results collection at that moment. It
 * is expressed instead by writing the notice into this second collection at
 * that moment (formalisation decision F8). WADA is not a member of this
 * network; its copy of the notice leaves the network as an audit alert.
 */
export const NOTICE_COLLECTION = 'noticeCollection';

/** MSP identifiers, one per organisational class. */
export const MSP = {
  ATHLETE: 'AthleteMSP',
  FEDERATION: 'FederationMSP',
  NADO: 'NADOMSP',
  LAB: 'LabMSP',
  RESEARCH: 'ResearchMSP',
} as const;

export const ALL_MSPS: string[] = Object.values(MSP);

/**
 * Custody phases. COLLECTION is opened by the NADO and acknowledged by the
 * athlete; TRANSPORT_HANDOFF is the dispatching party's attestation and
 * LABORATORY_RECEIPT the receiving party's, recorded as two transactions each
 * submitted under its own organisation's identity.
 */
export type CustodyPhase = 'COLLECTION' | 'TRANSPORT_HANDOFF' | 'LABORATORY_RECEIPT';

/** Mandatory custody steps. Q007 is satisfied only when all of these exist. */
export const MANDATORY_CUSTODY_STEPS: CustodyPhase[] = [
  'COLLECTION',
  'TRANSPORT_HANDOFF',
  'LABORATORY_RECEIPT',
];

/** Exceptions that make the custody chain unverifiable (Q007 = NO). */
export const BLOCKING_EXCEPTIONS = [
  'TRANSFER_WINDOW_EXCEEDED',
  'CONTAINER_SEAL_BROKEN',
  'CONTAINER_SEAL_MISMATCH',
  'COLLECTION_DISPUTED',
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
  /**
   * Keyed pseudonym of the athlete: HMAC-SHA-256 under a key held by the
   * athlete organisation's pseudonymisation service, never a plain hash of a
   * low-entropy identifier, and never a direct identifier (GDPR Art. 25).
   */
  athleteHash: string;
  sealedContainerHash: string;
  /** Digest of the doping control form held off-chain; the form itself is not written. */
  collectionRecordDigest: string;
  collectionTimestamp: string;
  initiatingMSP: string;
  status: SampleStatus;
  custodySequence: number;
  /** Sequence number of a dispatched transfer awaiting receipt, if any. */
  pendingTransfer: number | null;
  /** Version of the WADA Prohibited List the analysis was evaluated against. */
  prohibitedListVersion?: string;
}

export type TransferStatus = 'RECORDED' | 'PROPOSED' | 'ACCEPTED';

export interface CustodyEvent {
  docType: 'custodyEvent';
  sampleCode: string;
  sequence: number;
  phase: CustodyPhase;
  fromMSP: string;
  toMSP: string;
  /** Handover deadline, ISO-8601. A receipt after this raises an exception. */
  transferDeadline: string;
  recordedAt: string;
  /** Organisation whose identity signed the transaction that wrote this event. */
  submittingMSP: string;
  submittingIdentity: string;
  containerSealIntact: boolean;
  status: TransferStatus;
  /** Set on a dispatch event once the receiving organisation has accepted it. */
  acceptedAt?: string;
  acceptedByIdentity?: string;
  /** Set on a receipt event: whether the observed seal matches the one acknowledged at collection. */
  sealHashMatches?: boolean;
}

export interface CollectionAcknowledgement {
  docType: 'collectionAck';
  sampleCode: string;
  acknowledgedAt: string;
  acknowledgingIdentity: string;
  /** Whether the seal the athlete observed is the seal the NADO registered. */
  sealMatches: boolean;
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

/**
 * Per-athlete list of whereabouts failures, maintained alongside the
 * individual records. Results management reads this one key instead of
 * range-querying the collection, because Fabric refuses any write in a
 * transaction that has range-queried private data (a phantom read of private
 * data cannot be re-validated at commit).
 */
export interface WhereaboutsSummary {
  docType: 'whereaboutsSummary';
  athleteHash: string;
  failures: { filingId: string; recordedAt: string; ledgerVerified: boolean }[];
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

export interface AmendmentRecord {
  docType: 'resultsAmendment';
  sampleCode: string;
  index: number;
  proposedAction: string;
  reason: string;
  proposedByMSP: string;
  proposedByIdentity: string;
  proposedAt: string;
  status: 'PROPOSED' | 'APPROVED';
  approvedByMSP?: string;
  approvedByIdentity?: string;
  approvedAt?: string;
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
  /** Lower-precedence rules that also matched; retained, never discarded. */
  concurrentMatches: string[];
  rationale: string;
  /**
   * Deadline by which the athlete is to be notified, set when an AAF is
   * confirmed. A deployment parameter: recording it makes a late notice
   * auditable.
   */
  notificationDeadline?: string;
  confidential: boolean;
  decidedAt: string;
  decidedByIdentity: string;
  /** Approved amendments, oldest first; the original decision is never overwritten in place. */
  amendments: { index: number; from: string; to: string; approvedAt: string }[];
  /** Index of the amendment awaiting approval, if any; kept here so no range query is needed. */
  openAmendment: number | null;
  amendmentsProposed: number;
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
 * The Q001-Q007 condition vector of Table 1. Every field is explicit; the
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
