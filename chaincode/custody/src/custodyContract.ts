/**
 * Chain-of-custody chaincode.
 *
 * Every regulated function of Supplementary Table S1 is implemented here, so
 * the mapping from WADA Code article to executing smart contract function is
 * literal rather than nominal.
 *
 *   Art. 2.1, 6.1      -> recordSampleAnalysisResult()
 *   Art. 2.4           -> recordWhereaboutsStatus()
 *   Art. 5.4.1 / ISTI  -> initiateSampleCustody(), acknowledgeSampleCollection()
 *   Art. 5.4.1 / ISTI  -> proposeCustodyTransfer(), acceptCustodyTransfer()
 *   Art. 7.1, 7.2      -> triggerResultsManagement()
 *   Art. 7.2, 14.1.1-2 -> notifyAthleteOfAAF()
 *   Art. 7.4           -> recordProvisionalSuspension()
 *   Art. 14.1, 14.1.5  -> enforceResultsConfidentiality()
 *   Art. 14.1.4        -> proposeResultsAmendment(), approveResultsAmendment()
 *
 * The Code requires testing to follow the International Standard for Testing
 * and Investigations (ISTI) and results management the International
 * Standard for Results Management (ISRM); the custody procedure itself is
 * specified there rather than in a Code article.
 *
 * Three properties are enforced here that endorsement alone cannot provide.
 *
 *   Attestation. Endorsement shows that peers ran unmodified chaincode; it does
 *   not show that a second organisation agreed to anything, because a peer
 *   endorses any proposal that passes its checks, under whatever identity
 *   submitted it. A custody handover is therefore two transactions: the
 *   dispatching organisation proposes it under its own identity, and only an
 *   identity of the receiving organisation can accept it. A committed
 *   results-management record is never overwritten; changing it needs a
 *   proposal by one organisation and an approval by the other.
 *
 *   Confidentiality. Results-management state lives in a private data
 *   collection held by the NADO and the laboratory (RESULTS_COLLECTION), and
 *   what Article 14.1 says must reach other parties is written, at notice,
 *   to a second one (NOTICE_COLLECTION). Inputs to those functions travel in the
 *   transient field rather than as arguments, responses carry only a
 *   reference, and events carry only the sample code, because arguments,
 *   responses and event payloads are all written to the shared block.
 *
 *   Bounded time. The transaction timestamp is chosen by the client. Each
 *   endorsing peer refuses a proposal whose timestamp is further than
 *   CLOCK_SKEW_SECONDS from its own clock, and custody events must not precede
 *   the event before them.
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import { KeyEndorsementPolicy } from 'fabric-shim';
import {
  AccreditationState,
  ALL_MSPS,
  AmendmentRecord,
  AnalysisResult,
  BLOCKING_EXCEPTIONS,
  CollectionAcknowledgement,
  CustodyEvent,
  DecisionFacts,
  ExceptionRecord,
  KEY,
  MANDATORY_CUSTODY_STEPS,
  MSP,
  OversightRecord,
  NOTICE_COLLECTION,
  RESULTS_COLLECTION,
  ResultsManagementRecord,
  SampleRecord,
  WhereaboutsRecord,
  WhereaboutsSummary,
} from './types';
import { decideResultsAction, ResultsAction } from './resultsDecision';

/**
 * Deadline for notifying the athlete of a confirmed AAF. A deployment
 * parameter (14 days by default) rather than a figure taken from the Code;
 * recording it makes a late notice auditable.
 */
const NOTIFICATION_DEADLINE_DAYS = 14;
/** Art. 2.4 whereabouts failures are counted in a rolling 12-month window. */
const WHEREABOUTS_WINDOW_DAYS = 365;
/** Default custody handover window before an exception is raised. */
const DEFAULT_TRANSFER_WINDOW_HOURS = 48;
/** Largest accepted difference between a proposal's timestamp and the endorsing peer's clock. */
const CLOCK_SKEW_MS = Number(process.env.CLOCK_SKEW_SECONDS ?? 300) * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A keyed pseudonym is the hex encoding of a 256-bit HMAC output. */
const PSEUDONYM = /^[0-9a-f]{64}$/;

/**
 * The endorsing peer's clock. It is consulted only to refuse a proposal, never
 * written to state, so peers that disagree by a few seconds still produce
 * identical read-write sets for every proposal they accept.
 */
let peerClock: () => number = () => Date.now();

/** Test hook: replace the endorsing peer's clock. */
export function setPeerClockForTesting(clock: () => number): void {
  peerClock = clock;
}

@Info({
  title: 'CustodyContract',
  description: 'WADA Code chain of custody and results management (Table 1, Supplementary Table S1)',
})
export class CustodyContract extends Contract {
  constructor() {
    super('CustodyContract');
  }

  // ------------------------------------------------------------------ helpers

  /** Transaction timestamp from the proposal, which every endorser sees identically. */
  private txTime(ctx: Context): Date {
    const ts = ctx.stub.getTxTimestamp() as unknown as {
      seconds: { toNumber?: () => number } | number;
      nanos: number;
    };
    const seconds =
      typeof ts.seconds === 'number' ? ts.seconds : Number(ts.seconds.toNumber!());
    return new Date(seconds * 1000 + Math.floor(ts.nanos / 1e6));
  }

  /**
   * Refuse a proposal whose client-chosen timestamp is implausible to this
   * peer. Without this check a client could backdate a custody handover by
   * any amount, since the timestamp is otherwise taken on trust.
   */
  private boundedTime(ctx: Context): Date {
    const now = this.txTime(ctx);
    const skew = Math.abs(now.getTime() - peerClock());
    if (skew > CLOCK_SKEW_MS) {
      throw new Error(
        `transaction timestamp ${now.toISOString()} is ${Math.round(skew / 1000)}s from the ` +
          `endorsing peer's clock; at most ${CLOCK_SKEW_MS / 1000}s is accepted`,
      );
    }
    return now;
  }

  private caller(ctx: Context): string {
    return ctx.clientIdentity.getMSPID();
  }

  private callerIdentity(ctx: Context): string {
    return `${ctx.clientIdentity.getMSPID()}::${ctx.clientIdentity.getID()}`;
  }

  private requireMSP(ctx: Context, ...allowed: string[]): string {
    const msp = this.caller(ctx);
    if (!allowed.includes(msp)) {
      throw new Error(
        `authorization denied: ${msp} may not invoke this function; ` +
          `required organizational class: ${allowed.join(' or ')}`,
      );
    }
    return msp;
  }

  /** Inputs to private-data functions, read from the transient field "input". */
  private input<T>(ctx: Context): T {
    const raw = ctx.stub.getTransient().get('input');
    if (!raw || raw.length === 0) {
      throw new Error(
        'this function takes its inputs in the transient field "input", so that they ' +
          'are not written to the shared block',
      );
    }
    return JSON.parse(Buffer.from(raw).toString()) as T;
  }

  private async put(ctx: Context, key: string, value: unknown): Promise<void> {
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(value)));
  }

  private async get<T>(ctx: Context, key: string): Promise<T | null> {
    const data = await ctx.stub.getState(key);
    return data && data.length > 0 ? (JSON.parse(data.toString()) as T) : null;
  }

  private async mustGet<T>(ctx: Context, key: string, what: string): Promise<T> {
    const v = await this.get<T>(ctx, key);
    if (v === null) throw new Error(`${what} not found: ${key}`);
    return v;
  }

  private async putPrivate(ctx: Context, key: string, value: unknown): Promise<void> {
    await ctx.stub.putPrivateData(RESULTS_COLLECTION, key, Buffer.from(JSON.stringify(value)));
  }

  private async getPrivate<T>(ctx: Context, key: string): Promise<T | null> {
    const data = await ctx.stub.getPrivateData(RESULTS_COLLECTION, key);
    return data && data.length > 0 ? (JSON.parse(Buffer.from(data).toString()) as T) : null;
  }

  private async putNotice(ctx: Context, key: string, value: unknown): Promise<void> {
    await ctx.stub.putPrivateData(NOTICE_COLLECTION, key, Buffer.from(JSON.stringify(value)));
  }

  private async getNotice<T>(ctx: Context, key: string): Promise<T | null> {
    const data = await ctx.stub.getPrivateData(NOTICE_COLLECTION, key);
    return data && data.length > 0 ? (JSON.parse(Buffer.from(data).toString()) as T) : null;
  }

  private sampleKey(ctx: Context, code: string): string {
    return ctx.stub.createCompositeKey(KEY.SAMPLE, [code]);
  }

  private custodyKey(ctx: Context, code: string, sequence: number): string {
    return ctx.stub.createCompositeKey(KEY.CUSTODY, [code, String(sequence).padStart(4, '0')]);
  }

  private resultsKey(ctx: Context, code: string): string {
    return ctx.stub.createCompositeKey(KEY.RESULTS, [code]);
  }

  private oversightKey(ctx: Context, code: string): string {
    return ctx.stub.createCompositeKey(KEY.OVERSIGHT, [code]);
  }

  /**
   * Drain a fabric-shim iterator. The iterators use an explicit next()/close()
   * protocol and are NOT async-iterable at runtime: a `for await` loop fails at
   * the peer with "it is not async iterable". The iterator must also be closed,
   * or the peer leaks it.
   */
  private async drain<T>(
    it: { next(): Promise<{ value?: { value?: Uint8Array }; done?: boolean }>; close(): Promise<void> },
  ): Promise<T[]> {
    const out: T[] = [];
    try {
      let res = await it.next();
      while (!res.done) {
        const raw = res.value?.value;
        if (raw && raw.length > 0) out.push(JSON.parse(Buffer.from(raw).toString()) as T);
        res = await it.next();
      }
    } finally {
      await it.close();
    }
    return out;
  }

  private async collect<T>(ctx: Context, prefix: string, attrs: string[]): Promise<T[]> {
    return this.drain<T>(
      (await ctx.stub.getStateByPartialCompositeKey(prefix, attrs)) as never,
    );
  }

  private async collectPrivate<T>(ctx: Context, prefix: string, attrs: string[]): Promise<T[]> {
    // Unlike the public range query, fabric-shim resolves the private one to
    // { iterator, metadata } rather than to the iterator itself.
    const response = (await ctx.stub.getPrivateDataByPartialCompositeKey(
      RESULTS_COLLECTION,
      prefix,
      attrs,
    )) as unknown as { iterator?: unknown };
    return this.drain<T>((response.iterator ?? response) as never);
  }

  /**
   * Bind a public key to an endorsement policy naming peers of the given
   * organisations (state-based endorsement). Any later write to the key that
   * lacks one of those signatures fails validation with
   * ENDORSEMENT_POLICY_FAILURE. It does not govern the transaction that
   * creates the key, which falls under the chaincode-level policy.
   */
  private async bindToOrgs(ctx: Context, key: string, ...msps: string[]): Promise<void> {
    const ep = new KeyEndorsementPolicy();
    ep.addOrgs('PEER', ...[...new Set(msps)]);
    await ctx.stub.setStateValidationParameter(key, ep.getPolicy());
  }

  private async raiseException(
    ctx: Context,
    sampleCode: string,
    sequence: number,
    reason: string,
    detail: string,
    alerted: string[],
  ): Promise<ExceptionRecord> {
    const record: ExceptionRecord = {
      docType: 'exception',
      sampleCode,
      sequence,
      reason,
      detail,
      raisedAt: this.txTime(ctx).toISOString(),
      alertedMSPs: alerted,
    };
    // The reason is part of the key: a late handover with a broken seal raises
    // two exceptions at one sequence number, and neither may overwrite the other.
    await this.put(
      ctx,
      ctx.stub.createCompositeKey(KEY.EXCEPTION, [sampleCode, String(sequence), reason]),
      record,
    );
    ctx.stub.setEvent('CustodyException', Buffer.from(JSON.stringify(record)));
    return record;
  }

  /** A private-record event names the sample and nothing else. */
  private privateEvent(ctx: Context, sampleCode: string): void {
    ctx.stub.setEvent(
      'ResultsRecordUpdated',
      Buffer.from(JSON.stringify({ sampleCode, collection: RESULTS_COLLECTION })),
    );
  }

  // ------------------------------------------------- ISTI — sample collection

  /**
   * Sample collection (Code Art. 5.4.1; ISTI) — opening the chain of custody.
   *
   * The doping control officer acts under NADO authority, so only a NADO
   * identity may open a custody chain. The athlete is identified only by a
   * keyed pseudonym; the doping control form stays off-chain and only its
   * digest is written.
   */
  @Transaction()
  @Returns('string')
  public async initiateSampleCustody(
    ctx: Context,
    sampleCode: string,
    athleteHash: string,
    sealedContainerHash: string,
    collectionRecordDigest: string,
  ): Promise<string> {
    const msp = this.requireMSP(ctx, MSP.NADO);
    const now = this.boundedTime(ctx);

    const key = this.sampleKey(ctx, sampleCode);
    if (await this.get(ctx, key)) {
      throw new Error(`sample ${sampleCode} already exists`);
    }
    if (!PSEUDONYM.test(athleteHash ?? '')) {
      throw new Error(
        'athleteHash must be a keyed pseudonym: 64 lower-case hex characters (HMAC-SHA-256)',
      );
    }
    if (!sealedContainerHash) throw new Error('a sealed container hash is required');

    const sample: SampleRecord = {
      docType: 'sample',
      sampleCode,
      athleteHash,
      sealedContainerHash,
      collectionRecordDigest: collectionRecordDigest ?? '',
      collectionTimestamp: now.toISOString(),
      initiatingMSP: msp,
      status: 'IN_CUSTODY',
      custodySequence: 0,
      pendingTransfer: null,
    };
    await this.put(ctx, key, sample);
    // Every later change to the sample record — custody progress, analysis,
    // results management — needs both the NADO and the laboratory to endorse.
    await this.bindToOrgs(ctx, key, MSP.NADO, MSP.LAB);

    const collection: CustodyEvent = {
      docType: 'custodyEvent',
      sampleCode,
      sequence: 0,
      phase: 'COLLECTION',
      fromMSP: MSP.ATHLETE,
      toMSP: msp,
      transferDeadline: now.toISOString(),
      recordedAt: now.toISOString(),
      submittingMSP: msp,
      submittingIdentity: this.callerIdentity(ctx),
      containerSealIntact: true,
      status: 'RECORDED',
    };
    await this.put(ctx, this.custodyKey(ctx, sampleCode, 0), collection);

    ctx.stub.setEvent(
      'SampleCustodyInitiated',
      Buffer.from(JSON.stringify({ sampleCode, athleteHash, at: now.toISOString() })),
    );
    return JSON.stringify(sample);
  }

  /**
   * Sample collection (ISTI) — the athlete's
   * own attestation of the collection, the counterpart of signing the doping
   * control form. Only an athlete-organisation identity may submit it; where
   * the certificate carries a `pseudonym` attribute it must be this athlete's.
   *
   * A seal that does not match the one the NADO registered is recorded as a
   * dispute rather than refused: the disagreement is evidence.
   */
  @Transaction()
  @Returns('string')
  public async acknowledgeSampleCollection(
    ctx: Context,
    sampleCode: string,
    observedSealHash: string,
  ): Promise<string> {
    this.requireMSP(ctx, MSP.ATHLETE);
    const now = this.boundedTime(ctx);
    const sample = await this.mustGet<SampleRecord>(ctx, this.sampleKey(ctx, sampleCode), 'sample');

    const pseudonym = ctx.clientIdentity.getAttributeValue('pseudonym');
    if (pseudonym && pseudonym !== sample.athleteHash) {
      throw new Error(`identity is not the athlete to whom sample ${sampleCode} belongs`);
    }
    const ackKey = ctx.stub.createCompositeKey(KEY.ACK, [sampleCode]);
    if (await this.get(ctx, ackKey)) {
      throw new Error(`collection of sample ${sampleCode} has already been acknowledged`);
    }

    const ack: CollectionAcknowledgement = {
      docType: 'collectionAck',
      sampleCode,
      acknowledgedAt: now.toISOString(),
      acknowledgingIdentity: this.callerIdentity(ctx),
      sealMatches: observedSealHash === sample.sealedContainerHash,
    };
    await this.put(ctx, ackKey, ack);
    if (!ack.sealMatches) {
      await this.raiseException(
        ctx,
        sampleCode,
        0,
        'COLLECTION_DISPUTED',
        'the seal acknowledged by the athlete does not match the seal registered at collection',
        [MSP.NADO, MSP.ATHLETE],
      );
    }
    ctx.stub.setEvent('SampleCollectionAcknowledged', Buffer.from(JSON.stringify(ack)));
    return JSON.stringify(ack);
  }

  // --------------------------------------------- ISTI — custody transfer

  /**
   * Chain of custody (ISTI) — dispatch of a sample, first half of a handover.
   *
   * Submitted by the dispatching organisation under its own identity. The
   * event is written as PROPOSED and bound to an endorsement policy naming
   * both parties, so the acceptance that completes it must carry the
   * receiving organisation's peer signature as well as its client identity.
   */
  @Transaction()
  @Returns('string')
  public async proposeCustodyTransfer(
    ctx: Context,
    sampleCode: string,
    toMSP: string,
    containerSealIntact: string,
    transferWindowHours: string,
  ): Promise<string> {
    const fromMSP = this.requireMSP(ctx, MSP.NADO);
    const now = this.boundedTime(ctx);
    if (toMSP !== MSP.LAB) {
      throw new Error(`a sample may be dispatched only to a laboratory, not ${toMSP}`);
    }

    const sampleKey = this.sampleKey(ctx, sampleCode);
    const sample = await this.mustGet<SampleRecord>(ctx, sampleKey, 'sample');
    if (sample.status === 'INVALIDATED') {
      throw new Error(`sample ${sampleCode} is invalidated; no further transfers accepted`);
    }
    if (sample.pendingTransfer !== null) {
      throw new Error(
        `sample ${sampleCode} already has transfer ${sample.pendingTransfer} awaiting receipt`,
      );
    }
    const previous = await this.mustGet<CustodyEvent>(
      ctx,
      this.custodyKey(ctx, sampleCode, sample.custodySequence),
      'custody event',
    );
    if (now.getTime() < Date.parse(previous.recordedAt)) {
      throw new Error('a custody event may not precede the event before it');
    }

    // `Number(x) || DEFAULT` would silently turn a zero-hour window into the
    // default, because 0 is falsy. Only an absent or non-numeric value falls back.
    const parsed = Number(transferWindowHours);
    const windowHours =
      transferWindowHours !== '' && Number.isFinite(parsed) && parsed >= 0
        ? parsed
        : DEFAULT_TRANSFER_WINDOW_HOURS;

    const sequence = sample.custodySequence + 1;
    const event: CustodyEvent = {
      docType: 'custodyEvent',
      sampleCode,
      sequence,
      phase: 'TRANSPORT_HANDOFF',
      fromMSP,
      toMSP,
      transferDeadline: new Date(now.getTime() + windowHours * 3600 * 1000).toISOString(),
      recordedAt: now.toISOString(),
      submittingMSP: fromMSP,
      submittingIdentity: this.callerIdentity(ctx),
      containerSealIntact: containerSealIntact === 'true',
      status: 'PROPOSED',
    };
    const key = this.custodyKey(ctx, sampleCode, sequence);
    await this.put(ctx, key, event);
    await this.bindToOrgs(ctx, key, fromMSP, toMSP);

    sample.custodySequence = sequence;
    sample.pendingTransfer = sequence;
    await this.put(ctx, sampleKey, sample);

    if (!event.containerSealIntact) {
      await this.raiseException(ctx, sampleCode, sequence, 'CONTAINER_SEAL_BROKEN',
        'seal reported broken at dispatch', [MSP.NADO, MSP.LAB]);
    }
    ctx.stub.setEvent('CustodyTransferProposed', Buffer.from(JSON.stringify(event)));
    return JSON.stringify(event);
  }

  /**
   * Chain of custody (ISTI) — receipt of a sample, second half of a handover.
   *
   * Only an identity of the organisation named as recipient may accept, and
   * the dispatch event it completes is bound to both parties, so neither party
   * can record the other's side of a handover. A late receipt, a broken seal
   * or a seal that differs from the one acknowledged at collection is still
   * written — suppressing it would destroy the audit trail — but raises an
   * exception that makes the chain unverifiable.
   */
  @Transaction()
  @Returns('string')
  public async acceptCustodyTransfer(
    ctx: Context,
    sampleCode: string,
    sequence: string,
    containerSealIntact: string,
    observedSealHash: string,
  ): Promise<string> {
    const submitter = this.caller(ctx);
    const now = this.boundedTime(ctx);

    const sampleKey = this.sampleKey(ctx, sampleCode);
    const sample = await this.mustGet<SampleRecord>(ctx, sampleKey, 'sample');
    const seq = Number(sequence);
    const dispatchKey = this.custodyKey(ctx, sampleCode, seq);
    const dispatch = await this.mustGet<CustodyEvent>(ctx, dispatchKey, 'custody transfer');

    if (dispatch.status !== 'PROPOSED' || sample.pendingTransfer !== seq) {
      throw new Error(`custody transfer ${seq} of sample ${sampleCode} is not awaiting receipt`);
    }
    if (submitter !== dispatch.toMSP) {
      throw new Error(
        `only ${dispatch.toMSP} may accept transfer ${seq} of sample ${sampleCode}; ` +
          `submitter is ${submitter}`,
      );
    }
    if (now.getTime() < Date.parse(dispatch.recordedAt)) {
      throw new Error('a receipt may not precede the dispatch it completes');
    }

    dispatch.status = 'ACCEPTED';
    dispatch.acceptedAt = now.toISOString();
    dispatch.acceptedByIdentity = this.callerIdentity(ctx);
    await this.put(ctx, dispatchKey, dispatch);

    const receipt: CustodyEvent = {
      docType: 'custodyEvent',
      sampleCode,
      sequence: seq + 1,
      phase: 'LABORATORY_RECEIPT',
      fromMSP: dispatch.fromMSP,
      toMSP: dispatch.toMSP,
      transferDeadline: dispatch.transferDeadline,
      recordedAt: now.toISOString(),
      submittingMSP: submitter,
      submittingIdentity: this.callerIdentity(ctx),
      containerSealIntact: containerSealIntact === 'true',
      status: 'RECORDED',
      sealHashMatches: observedSealHash === sample.sealedContainerHash,
    };
    const receiptKey = this.custodyKey(ctx, sampleCode, seq + 1);
    await this.put(ctx, receiptKey, receipt);
    await this.bindToOrgs(ctx, receiptKey, dispatch.fromMSP, dispatch.toMSP);

    sample.custodySequence = seq + 1;
    sample.pendingTransfer = null;
    await this.put(ctx, sampleKey, sample);

    if (now.getTime() > Date.parse(dispatch.transferDeadline)) {
      await this.raiseException(ctx, sampleCode, seq + 1, 'TRANSFER_WINDOW_EXCEEDED',
        `receipt recorded at ${now.toISOString()}, after the window closing ${dispatch.transferDeadline}`,
        [MSP.NADO]);
    }
    if (!receipt.containerSealIntact) {
      await this.raiseException(ctx, sampleCode, seq + 1, 'CONTAINER_SEAL_BROKEN',
        'seal reported broken at receipt', [MSP.NADO, MSP.LAB]);
    }
    if (!receipt.sealHashMatches) {
      await this.raiseException(ctx, sampleCode, seq + 1, 'CONTAINER_SEAL_MISMATCH',
        'the seal observed at receipt is not the seal acknowledged at collection',
        [MSP.NADO, MSP.LAB, MSP.ATHLETE]);
    }

    ctx.stub.setEvent('CustodyTransferAccepted', Buffer.from(JSON.stringify(receipt)));
    return JSON.stringify(receipt);
  }

  // ------------------------------------------- Article 2.1 — analysis result

  /**
   * WADA Code Article 2.1 — presence of a prohibited substance.
   *
   * Only a laboratory identity may commit an analysis result, once, and the
   * Prohibited List revision it cites is hash-verified against the copy
   * registered on the ledger. The result is private to the results collection.
   *
   * Transient input: { adverse, substance, prohibitedListVersion,
   * prohibitedListHash, laboratoryAccreditation }.
   */
  @Transaction()
  @Returns('string')
  public async recordSampleAnalysisResult(ctx: Context, sampleCode: string): Promise<string> {
    const msp = this.requireMSP(ctx, MSP.LAB);
    const now = this.boundedTime(ctx);
    const input = this.input<{
      adverse: boolean;
      substance?: string;
      prohibitedListVersion: string;
      prohibitedListHash: string;
      laboratoryAccreditation: string;
    }>(ctx);

    const sampleKey = this.sampleKey(ctx, sampleCode);
    const sample = await this.mustGet<SampleRecord>(ctx, sampleKey, 'sample');
    if (sample.status === 'INVALIDATED') {
      throw new Error(`sample ${sampleCode} is invalidated; analysis cannot be committed`);
    }
    const analysisKey = ctx.stub.createCompositeKey(KEY.ANALYSIS, [sampleCode]);
    if (await this.getPrivate(ctx, analysisKey)) {
      throw new Error(`an analysis result for sample ${sampleCode} is already committed`);
    }

    const registered = await this.get<{ version: string; hash: string }>(
      ctx,
      ctx.stub.createCompositeKey(KEY.PROHIBITED_LIST, [input.prohibitedListVersion]),
    );
    if (!registered) {
      throw new Error(`Prohibited List version ${input.prohibitedListVersion} is not registered on-ledger`);
    }
    if (registered.hash !== input.prohibitedListHash) {
      throw new Error(
        `Prohibited List hash mismatch for ${input.prohibitedListVersion}: ` +
          `analysis cites ${input.prohibitedListHash}, ledger holds ${registered.hash}`,
      );
    }
    const accreditation = input.laboratoryAccreditation as AccreditationState;
    if (!['VERIFIED', 'PENDING', 'UNVERIFIED'].includes(accreditation)) {
      throw new Error(`invalid accreditation state: ${input.laboratoryAccreditation}`);
    }

    const result: AnalysisResult = {
      docType: 'analysisResult',
      sampleCode,
      laboratoryMSP: msp,
      adverse: input.adverse === true,
      substance: input.substance || undefined,
      prohibitedListVersion: input.prohibitedListVersion,
      prohibitedListHash: input.prohibitedListHash,
      laboratoryAccreditation: accreditation,
      recordedAt: now.toISOString(),
    };
    await this.putPrivate(ctx, analysisKey, result);

    sample.status = 'ANALYSED';
    sample.prohibitedListVersion = input.prohibitedListVersion;
    await this.put(ctx, sampleKey, sample);

    this.privateEvent(ctx, sampleCode);
    return JSON.stringify({ sampleCode, recorded: true });
  }

  /**
   * Register a Prohibited List revision. Write-once per version, so a revision
   * cannot be replaced after a laboratory has cited it.
   */
  @Transaction()
  public async registerProhibitedList(ctx: Context, version: string, hash: string): Promise<void> {
    this.requireMSP(ctx, MSP.NADO, MSP.LAB);
    const key = ctx.stub.createCompositeKey(KEY.PROHIBITED_LIST, [version]);
    const existing = await this.get<{ hash: string }>(ctx, key);
    if (existing) {
      if (existing.hash === hash) return;
      throw new Error(`Prohibited List version ${version} is already registered with a different hash`);
    }
    await this.put(ctx, key, {
      version,
      hash,
      registeredAt: this.boundedTime(ctx).toISOString(),
      registeredBy: this.caller(ctx),
    });
  }

  // --------------------------------------------- Article 2.4 — whereabouts

  /**
   * WADA Code Article 2.4 — whereabouts failure documentation.
   *
   * Records a failure status (not a whereabouts filing: locations stay
   * off-chain) in the results collection, because results management reads
   * it and every peer that endorses results management must be able to.
   *
   * Transient input: { athleteHash, filingId, failure, ledgerVerified }.
   */
  @Transaction()
  @Returns('string')
  public async recordWhereaboutsStatus(ctx: Context): Promise<string> {
    const msp = this.requireMSP(ctx, MSP.NADO);
    const now = this.boundedTime(ctx);
    const input = this.input<{
      athleteHash: string;
      filingId: string;
      failure: boolean;
      ledgerVerified: boolean;
    }>(ctx);
    if (!PSEUDONYM.test(input.athleteHash ?? '')) {
      throw new Error('athleteHash must be a keyed pseudonym: 64 lower-case hex characters');
    }

    const key = ctx.stub.createCompositeKey(KEY.WHEREABOUTS, [input.athleteHash, input.filingId]);
    if (await this.getPrivate(ctx, key)) {
      throw new Error(`whereabouts filing ${input.filingId} is already recorded`);
    }
    const record: WhereaboutsRecord = {
      docType: 'whereabouts',
      athleteHash: input.athleteHash,
      filingId: input.filingId,
      failure: input.failure === true,
      ledgerVerified: input.ledgerVerified === true,
      recordedAt: now.toISOString(),
      recordingMSP: msp,
    };
    await this.putPrivate(ctx, key, record);

    if (record.failure) {
      const summaryKey = ctx.stub.createCompositeKey(KEY.WHEREABOUTS_SUMMARY, [input.athleteHash]);
      const summary = (await this.getPrivate<WhereaboutsSummary>(ctx, summaryKey)) ?? {
        docType: 'whereaboutsSummary',
        athleteHash: input.athleteHash,
        failures: [],
      };
      summary.failures.push({
        filingId: record.filingId,
        recordedAt: record.recordedAt,
        ledgerVerified: record.ledgerVerified,
      });
      await this.putPrivate(ctx, summaryKey, summary);
    }
    return JSON.stringify({ recorded: true });
  }

  /** Failures inside the rolling 12-month window, and whether all are verified. */
  private async whereaboutsFailureSummary(
    ctx: Context,
    athleteHash: string,
    now: Date,
  ): Promise<{ failuresInWindow: number; allFailuresLedgerVerified: boolean }> {
    const summary = await this.getPrivate<WhereaboutsSummary>(
      ctx,
      ctx.stub.createCompositeKey(KEY.WHEREABOUTS_SUMMARY, [athleteHash]),
    );
    const cutoff = now.getTime() - WHEREABOUTS_WINDOW_DAYS * DAY_MS;
    const inWindow = (summary?.failures ?? []).filter((r) => Date.parse(r.recordedAt) >= cutoff);
    return {
      failuresInWindow: inWindow.length,
      // Q006 over an empty set is defined as NO: a verification claim needs
      // at least one failure to be about (formalisation decision F4).
      allFailuresLedgerVerified: inWindow.length > 0 && inWindow.every((r) => r.ledgerVerified),
    };
  }

  // -------------------------------- Article 7.1 — results management trigger

  /**
   * WADA Code Article 7.1 — results management after an adverse finding.
   *
   * Assembles the Q001-Q007 condition vector from committed ledger state and
   * runs it through the Table 1 decision engine. The record is written once:
   * a second call is refused, and any change must go through
   * proposeResultsAmendment() and approveResultsAmendment().
   */
  @Transaction()
  @Returns('string')
  public async triggerResultsManagement(ctx: Context, sampleCode: string): Promise<string> {
    this.requireMSP(ctx, MSP.NADO);
    const now = this.boundedTime(ctx);
    const sampleKey = this.sampleKey(ctx, sampleCode);
    const sample = await this.mustGet<SampleRecord>(ctx, sampleKey, 'sample');

    const key = this.resultsKey(ctx, sampleCode);
    if (await this.getPrivate(ctx, key)) {
      throw new Error(
        `a results-management record for sample ${sampleCode} is already committed and is ` +
          'not overwritten; a change requires proposeResultsAmendment() by one organisation ' +
          'and approveResultsAmendment() by the other',
      );
    }

    const facts = await this.assembleFacts(ctx, sample, now);
    const decision = decideResultsAction(facts);

    const record: ResultsManagementRecord = {
      docType: 'resultsManagement',
      sampleCode,
      athleteHash: sample.athleteHash,
      action: decision.action,
      ruleId: decision.ruleId,
      wadaArticle: decision.wadaArticle,
      facts,
      invokedFunctions: decision.invokedFunctions,
      humanOversightRequired: decision.humanOversightRequired,
      auditAlertRecipients: decision.auditAlertRecipients,
      concurrentMatches: decision.concurrentMatches,
      rationale: decision.rationale,
      confidential: decision.confidential,
      decidedAt: now.toISOString(),
      decidedByIdentity: this.callerIdentity(ctx),
      amendments: [],
      openAmendment: null,
      amendmentsProposed: 0,
    };
    if (decision.action === ResultsAction.AafConfirmed) {
      record.notificationDeadline = new Date(now.getTime() + NOTIFICATION_DEADLINE_DAYS * DAY_MS).toISOString();
    }
    await this.putPrivate(ctx, key, record);

    if (decision.auditAlertRecipients.length > 0) {
      await this.putPrivate(ctx, ctx.stub.createCompositeKey(KEY.RESULTS_EXCEPTION, [sampleCode]), {
        docType: 'resultsException',
        sampleCode,
        reason: decision.ruleId,
        detail: decision.rationale,
        alertedMSPs: decision.auditAlertRecipients,
        raisedAt: now.toISOString(),
      });
    }

    sample.status =
      decision.action === ResultsAction.ProcessInvalidated ? 'INVALIDATED' : 'RESULTS_MANAGEMENT';
    await this.put(ctx, sampleKey, sample);

    this.privateEvent(ctx, sampleCode);
    return JSON.stringify({ sampleCode, committed: true });
  }

  /**
   * Derive Q001-Q007 from committed ledger state only.
   *
   * Q007 ("mandatory custody step verified") required an interpretation the
   * decision table did not supply (formalisation decision F3). It holds only
   * when every mandatory phase is present, the dispatch was accepted by the
   * receiving organisation, the athlete acknowledged the collection, and no
   * blocking exception — late receipt, broken or mismatched seal, disputed
   * collection — was raised. A handover recorded after its window therefore
   * invalidates the process: an unexplained gap in the custody timeline is the
   * condition under which a sample's integrity cannot be asserted.
   *
   * A missing analysis gives Q002 = UNVERIFIED rather than PENDING
   * (formalisation decision F5): absence of an accreditation record is not
   * evidence that one is on its way.
   */
  private async assembleFacts(ctx: Context, sample: SampleRecord, now: Date): Promise<DecisionFacts> {
    const analysis = await this.getPrivate<AnalysisResult>(
      ctx,
      ctx.stub.createCompositeKey(KEY.ANALYSIS, [sample.sampleCode]),
    );
    const custody = await this.collect<CustodyEvent>(ctx, KEY.CUSTODY, [sample.sampleCode]);
    const phases = new Set(
      custody
        .filter((c) => c.phase !== 'TRANSPORT_HANDOFF' || c.status === 'ACCEPTED')
        .map((c) => c.phase),
    );
    const sealsIntact = custody.every((c) => c.containerSealIntact && c.sealHashMatches !== false);
    const exceptions = await this.collect<ExceptionRecord>(ctx, KEY.EXCEPTION, [sample.sampleCode]);
    const blocking = exceptions.some((e) => BLOCKING_EXCEPTIONS.includes(e.reason));
    const ack = await this.get<CollectionAcknowledgement>(
      ctx,
      ctx.stub.createCompositeKey(KEY.ACK, [sample.sampleCode]),
    );

    const wb = await this.whereaboutsFailureSummary(ctx, sample.athleteHash, now);
    const abp = await this.getPrivate<{ anomaly: boolean; expertPanelRequired: boolean }>(
      ctx,
      ctx.stub.createCompositeKey(KEY.PASSPORT, [sample.athleteHash]),
    );

    return {
      sampleAnalysisPositive: analysis?.adverse === true,
      laboratoryAccreditation: analysis?.laboratoryAccreditation ?? 'UNVERIFIED',
      longitudinalProfileAnomaly: abp?.anomaly === true,
      expertPanelReviewRequired: abp?.expertPanelRequired === true,
      thirdWhereaboutsFailure: wb.failuresInWindow >= 3,
      allFailuresLedgerVerified: wb.allFailuresLedgerVerified,
      mandatoryCustodyStepVerified:
        MANDATORY_CUSTODY_STEPS.every((p) => phases.has(p)) &&
        ack?.sealMatches === true &&
        sealsIntact &&
        !blocking,
    };
  }

  /**
   * Record an Athlete Biological Passport evaluation (feeds Q003 and Q004).
   * Transient input: { athleteHash, anomaly, expertPanelRequired }.
   */
  @Transaction()
  public async recordPassportEvaluation(ctx: Context): Promise<void> {
    this.requireMSP(ctx, MSP.LAB, MSP.NADO);
    const now = this.boundedTime(ctx);
    const input = this.input<{ athleteHash: string; anomaly: boolean; expertPanelRequired: boolean }>(ctx);
    await this.putPrivate(ctx, ctx.stub.createCompositeKey(KEY.PASSPORT, [input.athleteHash]), {
      docType: 'passportEvaluation',
      athleteHash: input.athleteHash,
      anomaly: input.anomaly === true,
      expertPanelRequired: input.expertPanelRequired === true,
      recordedAt: now.toISOString(),
      recordedBy: this.caller(ctx),
    });
  }

  // ------------------------------------- results-management amendment (two-party)

  /**
   * Propose a change to a committed results-management outcome, for example
   * after B-sample analysis. Takes effect only when an identity of the other
   * organisation approves it.
   *
   * Transient input: { action, reason }.
   */
  @Transaction()
  @Returns('string')
  public async proposeResultsAmendment(ctx: Context, sampleCode: string): Promise<string> {
    const msp = this.requireMSP(ctx, MSP.NADO, MSP.LAB);
    const now = this.boundedTime(ctx);
    const input = this.input<{ action: string; reason: string }>(ctx);
    if (!Object.values(ResultsAction).includes(input.action as ResultsAction)) {
      throw new Error(`unknown results-management action: ${input.action}`);
    }
    if (!input.reason) throw new Error('an amendment requires a recorded reason');

    const resultsKey = this.resultsKey(ctx, sampleCode);
    const record = await this.getPrivate<ResultsManagementRecord>(ctx, resultsKey);
    if (!record) throw new Error(`no results-management record for sample ${sampleCode}`);
    if (record.openAmendment !== null) {
      throw new Error(`sample ${sampleCode} already has an amendment awaiting approval`);
    }
    const amendment: AmendmentRecord = {
      docType: 'resultsAmendment',
      sampleCode,
      index: record.amendmentsProposed,
      proposedAction: input.action,
      reason: input.reason,
      proposedByMSP: msp,
      proposedByIdentity: this.callerIdentity(ctx),
      proposedAt: now.toISOString(),
      status: 'PROPOSED',
    };
    await this.putPrivate(
      ctx,
      ctx.stub.createCompositeKey(KEY.AMENDMENT, [sampleCode, String(amendment.index).padStart(4, '0')]),
      amendment,
    );
    record.openAmendment = amendment.index;
    record.amendmentsProposed += 1;
    await this.putPrivate(ctx, resultsKey, record);
    this.privateEvent(ctx, sampleCode);
    return JSON.stringify({ sampleCode, amendment: amendment.index, status: 'PROPOSED' });
  }

  /** Approve a proposed amendment. The approver's organisation must differ from the proposer's. */
  @Transaction()
  @Returns('string')
  public async approveResultsAmendment(ctx: Context, sampleCode: string, index: string): Promise<string> {
    const msp = this.requireMSP(ctx, MSP.NADO, MSP.LAB);
    const now = this.boundedTime(ctx);
    const amendmentKey = ctx.stub.createCompositeKey(KEY.AMENDMENT, [sampleCode, String(Number(index)).padStart(4, '0')]);
    const amendment = await this.getPrivate<AmendmentRecord>(ctx, amendmentKey);
    if (!amendment || amendment.status !== 'PROPOSED') {
      throw new Error(`amendment ${index} of sample ${sampleCode} is not awaiting approval`);
    }
    if (amendment.proposedByMSP === msp) {
      throw new Error(
        `an amendment proposed by ${msp} must be approved by the other organisation, not by ${msp}`,
      );
    }

    const key = this.resultsKey(ctx, sampleCode);
    const record = await this.getPrivate<ResultsManagementRecord>(ctx, key);
    if (!record) throw new Error(`no results-management record for sample ${sampleCode}`);

    record.amendments.push({
      index: amendment.index,
      from: record.action,
      to: amendment.proposedAction,
      approvedAt: now.toISOString(),
    });
    record.action = amendment.proposedAction;
    record.openAmendment = null;
    await this.putPrivate(ctx, key, record);

    amendment.status = 'APPROVED';
    amendment.approvedByMSP = msp;
    amendment.approvedByIdentity = this.callerIdentity(ctx);
    amendment.approvedAt = now.toISOString();
    await this.putPrivate(ctx, amendmentKey, amendment);

    // Once a violation has been notified, a change of outcome is a status
    // report owed to the notified parties (Art. 14.1.4).
    if (await this.getNotice(ctx, ctx.stub.createCompositeKey(KEY.NOTICE, [sampleCode]))) {
      await this.putNotice(
        ctx,
        ctx.stub.createCompositeKey(KEY.NOTICE_STATUS, [sampleCode, `amendment-${amendment.index}`]),
        { docType: 'noticeStatus', sampleCode, status: amendment.proposedAction, reason: amendment.reason, at: now.toISOString() },
      );
    }

    this.privateEvent(ctx, sampleCode);
    return JSON.stringify({ sampleCode, amendment: amendment.index, status: 'APPROVED' });
  }

  // ----------------------------- Articles 7.2 and 14.1.1-14.1.2 — notice

  /**
   * Notify the athlete of a confirmed adverse analytical finding (Art. 7.2,
   * 14.1.1) and, simultaneously, the athlete's NADO, the International
   * Federation and WADA (Art. 14.1.2). The notice, with the content Art.
   * 14.1.3 lists, is written to the notice collection, which the athlete and
   * federation organisations hold; WADA, outside this network, receives the
   * audit alert. The public event names only the sample.
   */
  @Transaction()
  @Returns('string')
  public async notifyAthleteOfAAF(ctx: Context, sampleCode: string): Promise<string> {
    this.requireMSP(ctx, MSP.NADO);
    const now = this.boundedTime(ctx);
    const results = await this.getPrivate<ResultsManagementRecord>(ctx, this.resultsKey(ctx, sampleCode));
    if (!results) throw new Error(`results management record not found for ${sampleCode}`);
    if (results.action !== ResultsAction.AafConfirmed) {
      throw new Error(
        `notice of an adverse analytical finding requires a confirmed finding; ` +
          `sample ${sampleCode} is in state ${results.action}`,
      );
    }
    const analysis = await this.getPrivate<AnalysisResult>(ctx, ctx.stub.createCompositeKey(KEY.ANALYSIS, [sampleCode]));
    const sample = await this.mustGet<SampleRecord>(ctx, this.sampleKey(ctx, sampleCode), 'sample');
    const notification = {
      docType: 'aafNotification',
      sampleCode,
      athleteHash: results.athleteHash,
      notifiedAt: now.toISOString(),
      notificationDeadline: results.notificationDeadline,
      withinDeadline: results.notificationDeadline ? now.getTime() <= Date.parse(results.notificationDeadline) : false,
    };
    await this.putPrivate(ctx, ctx.stub.createCompositeKey(KEY.NOTIFICATION, [sampleCode]), notification);
    await this.putNotice(ctx, ctx.stub.createCompositeKey(KEY.NOTICE, [sampleCode]), {
      docType: 'adrvNotice',
      sampleCode,
      athleteHash: results.athleteHash,
      assertedViolation: 'Article 2.1',
      analyticalResult: analysis?.substance ?? null,
      prohibitedListVersion: analysis?.prohibitedListVersion ?? null,
      sampleCollectedAt: sample.collectionTimestamp,
      notifiedAt: now.toISOString(),
      notifiedParties: ['athlete', 'NADOMSP', 'FederationMSP', 'WADA (audit alert, outside the network)'],
      basis: 'WADA Code Art. 7.2, 14.1.1, 14.1.2; confidential to recipients under Art. 14.1.5',
    });
    this.privateEvent(ctx, sampleCode);
    return JSON.stringify({ sampleCode, committed: true });
  }

  // ------------------------------- Article 7.4 — provisional suspension

  /**
   * WADA Code Article 7.4 — provisional suspension. A career-affecting
   * decision, so GDPR Article 22 forbids taking it by automated processing
   * alone: the chaincode refuses unless a human oversight record exists and
   * returned UPHOLD. Transient input: { groundsArticle }.
   */
  @Transaction()
  @Returns('string')
  public async recordProvisionalSuspension(ctx: Context, sampleCode: string): Promise<string> {
    this.requireMSP(ctx, MSP.NADO);
    const now = this.boundedTime(ctx);
    const input = this.input<{ groundsArticle: string }>(ctx);
    const results = await this.getPrivate<ResultsManagementRecord>(ctx, this.resultsKey(ctx, sampleCode));
    if (!results) throw new Error(`results management record not found for ${sampleCode}`);

    const oversight = await this.getPrivate<OversightRecord>(ctx, this.oversightKey(ctx, sampleCode));
    if (!oversight) {
      throw new Error(
        'GDPR Article 22: a provisional suspension may not be imposed by automated ' +
          `processing; no human oversight record exists for sample ${sampleCode}`,
      );
    }
    if (oversight.decision !== 'UPHOLD') {
      throw new Error(
        `human oversight for sample ${sampleCode} returned ${oversight.decision}; ` +
          'a provisional suspension requires an UPHOLD decision',
      );
    }
    const suspension = {
      docType: 'provisionalSuspension',
      sampleCode,
      athleteHash: results.athleteHash,
      groundsArticle: input.groundsArticle,
      oversightReviewer: oversight.reviewerId,
      oversightRecordedAt: oversight.recordedAt,
      imposedAt: now.toISOString(),
      imposedBy: this.callerIdentity(ctx),
    };
    await this.putPrivate(ctx, ctx.stub.createCompositeKey(KEY.SUSPENSION, [sampleCode]), suspension);
    // A status report to the notified parties (Art. 14.1.4).
    await this.putNotice(ctx, ctx.stub.createCompositeKey(KEY.NOTICE_STATUS, [sampleCode, 'provisional-suspension']), {
      docType: 'noticeStatus',
      sampleCode,
      status: 'PROVISIONAL_SUSPENSION',
      groundsArticle: input.groundsArticle,
      at: now.toISOString(),
    });
    this.privateEvent(ctx, sampleCode);
    return JSON.stringify({ sampleCode, committed: true });
  }

  /**
   * GDPR Art. 22 — record the human review that automated processing requires.
   * Transient input: { reviewerId, decision, rationale }.
   */
  @Transaction()
  @Returns('string')
  public async enforceOversightRequirement(ctx: Context, sampleCode: string): Promise<string> {
    const msp = this.requireMSP(ctx, MSP.NADO, MSP.LAB);
    const now = this.boundedTime(ctx);
    const input = this.input<{ reviewerId: string; decision: string; rationale: string }>(ctx);
    if (!['UPHOLD', 'REJECT', 'REQUEST_FURTHER_ANALYSIS'].includes(input.decision)) {
      throw new Error(`invalid oversight decision: ${input.decision}`);
    }
    if (!input.reviewerId || !input.rationale) {
      throw new Error('an oversight record requires an identified reviewer and a rationale');
    }
    const record: OversightRecord = {
      docType: 'oversight',
      sampleCode,
      reviewerId: input.reviewerId,
      reviewerMSP: msp,
      decision: input.decision as OversightRecord['decision'],
      rationale: input.rationale,
      recordedAt: now.toISOString(),
    };
    await this.putPrivate(ctx, this.oversightKey(ctx, sampleCode), record);
    this.privateEvent(ctx, sampleCode);
    return JSON.stringify({ sampleCode, committed: true });
  }

  // --------------------------- Article 14.1 — results confidentiality

  /**
   * WADA Code Article 14.1 — who may read what, and from when.
   *
   * While a case is under review the result is confidential to the NADO and
   * the laboratory. From the notice onward, the athlete and the International
   * Federation are entitled to the notice and its status reports (14.1.1,
   * 14.1.2, 14.1.4), and are bound to confidentiality themselves (14.1.5).
   * A research organisation is never a recipient.
   *
   * The platform enforces the same boundary underneath: only NADO and
   * laboratory peers hold the results collection, and only the four
   * recipient classes hold the notice collection, so a peer asked for data
   * its organisation is not entitled to has none to give.
   */
  @Transaction(false)
  @Returns('string')
  public async enforceResultsConfidentiality(ctx: Context, sampleCode: string): Promise<string> {
    const requester = this.caller(ctx);
    if (requester === MSP.NADO || requester === MSP.LAB) {
      const results = await this.getPrivate<ResultsManagementRecord>(ctx, this.resultsKey(ctx, sampleCode));
      return JSON.stringify({ granted: true, sampleCode, requester, basis: 'Article 7.1 (results management)', results });
    }
    if (requester === MSP.ATHLETE || requester === MSP.FEDERATION) {
      const notice = await this.getNotice(ctx, ctx.stub.createCompositeKey(KEY.NOTICE, [sampleCode]));
      if (!notice) {
        return JSON.stringify({
          granted: false,
          sampleCode,
          requester,
          basis: 'Article 14.1',
          reason: 'no violation has been notified; the result is confidential to the NADO and the laboratory until notice',
        });
      }
      return JSON.stringify({ granted: true, sampleCode, requester, basis: 'Article 14.1.1-14.1.2', notice });
    }
    return JSON.stringify({
      granted: false,
      sampleCode,
      requester,
      basis: 'Article 14.1',
      reason: 'this organisational class is not a recipient of results-management information',
    });
  }

  // ------------------------------------------------------------------ queries

  @Transaction(false)
  @Returns('string')
  public async getSample(ctx: Context, sampleCode: string): Promise<string> {
    return JSON.stringify(await this.mustGet<SampleRecord>(ctx, this.sampleKey(ctx, sampleCode), 'sample'));
  }

  @Transaction(false)
  @Returns('string')
  public async getCustodyChain(ctx: Context, sampleCode: string): Promise<string> {
    const chain = await this.collect<CustodyEvent>(ctx, KEY.CUSTODY, [sampleCode]);
    chain.sort((a, b) => a.sequence - b.sequence);
    const ack = await this.get(ctx, ctx.stub.createCompositeKey(KEY.ACK, [sampleCode]));
    const exceptions = await this.collect<ExceptionRecord>(ctx, KEY.EXCEPTION, [sampleCode]);
    return JSON.stringify({ sampleCode, events: chain, acknowledgement: ack, exceptions });
  }

  /** Members of the results collection only: the record, its amendments and the oversight trail. */
  @Transaction(false)
  @Returns('string')
  public async getResultsManagement(ctx: Context, sampleCode: string): Promise<string> {
    this.requireMSP(ctx, MSP.NADO, MSP.LAB);
    const record = await this.getPrivate<ResultsManagementRecord>(ctx, this.resultsKey(ctx, sampleCode));
    if (!record) throw new Error(`results management record not found for ${sampleCode}`);
    const amendments = await this.collectPrivate<AmendmentRecord>(ctx, KEY.AMENDMENT, [sampleCode]);
    const oversight = await this.getPrivate(ctx, this.oversightKey(ctx, sampleCode));
    const notification = await this.getPrivate(ctx, ctx.stub.createCompositeKey(KEY.NOTIFICATION, [sampleCode]));
    const suspension = await this.getPrivate(ctx, ctx.stub.createCompositeKey(KEY.SUSPENSION, [sampleCode]));
    return JSON.stringify({ ...record, amendmentRequests: amendments, oversight, notification, suspension });
  }

  /**
   * Evaluate the Table 1 decision logic without touching the ledger, so the
   * decision engine can be benchmarked and audited independently of state.
   */
  @Transaction(false)
  @Returns('string')
  public async evaluateDecisionTable(ctx: Context, factsJson: string): Promise<string> {
    return JSON.stringify(decideResultsAction(JSON.parse(factsJson) as DecisionFacts));
  }

  /** Full provenance of a sample record, straight from the ledger history. */
  @Transaction(false)
  @Returns('string')
  public async getSampleHistory(ctx: Context, sampleCode: string): Promise<string> {
    const it = await ctx.stub.getHistoryForKey(this.sampleKey(ctx, sampleCode));
    const history = [];
    try {
      let res = await it.next();
      while (!res.done) {
        const entry = res.value;
        const raw = entry?.value?.toString();
        history.push({ txId: entry?.txId, isDelete: entry?.isDelete, value: raw ? JSON.parse(raw) : null });
        res = await it.next();
      }
    } finally {
      await it.close();
    }
    return JSON.stringify(history);
  }

  /** Organisational classes known to the contract, for clients and tests. */
  @Transaction(false)
  @Returns('string')
  public async getOrganisationalClasses(): Promise<string> {
    return JSON.stringify(ALL_MSPS);
  }
}
