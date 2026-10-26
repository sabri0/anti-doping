/**
 * Chain-of-custody chaincode.
 *
 * Every function named in Table 1 of the manuscript is implemented here with
 * its published signature, so the mapping from WADA Code article to executing
 * smart contract function is literal rather than nominal.
 *
 *   Article 2.1  -> recordSampleAnalysisResult()
 *   Article 2.4  -> recordWhereaboutsStatus()
 *   Article 5.3  -> initiateSampleCustody()
 *   Article 5.4  -> recordCustodyTransfer()
 *   Article 7.1  -> triggerResultsManagement()
 *   Article 7.3  -> notifyAthleteOfAAF()
 *   Article 7.9  -> recordProvisionalSuspension()
 *   Article 14.1 -> enforceResultsConfidentiality()
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import { KeyEndorsementPolicy } from 'fabric-shim';
import {
  AccreditationState,
  AnalysisResult,
  CustodyEvent,
  CustodyPhase,
  DecisionFacts,
  ExceptionRecord,
  KEY,
  MANDATORY_CUSTODY_STEPS,
  MSP,
  OversightRecord,
  ResultsManagementRecord,
  SampleRecord,
  WhereaboutsRecord,
} from './types';
import { decideResultsAction, ResultsAction } from './resultsDecision';

/** WADA Art. 7.3 notification period. Configurable; 14 days is the default. */
const ARTICLE_73_PERIOD_DAYS = 14;
/** Art. 2.4 whereabouts failures are counted in a rolling 12-month window. */
const WHEREABOUTS_WINDOW_DAYS = 365;
/** Default custody handover window before an exception is raised. */
const DEFAULT_TRANSFER_WINDOW_HOURS = 48;

const DAY_MS = 24 * 60 * 60 * 1000;

@Info({
  title: 'CustodyContract',
  description: 'WADA Code chain of custody and results management (Tables 1 and 2)',
})
export class CustodyContract extends Contract {
  constructor() {
    super('CustodyContract');
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Transaction timestamp from the proposal, not the local clock. Every
   * endorsing peer must compute an identical read-write set, so wall-clock
   * time would break endorsement.
   */
  private txTime(ctx: Context): Date {
    const ts = ctx.stub.getTxTimestamp() as unknown as {
      seconds: { toNumber?: () => number } | number;
      nanos: number;
    };
    const seconds =
      typeof ts.seconds === 'number' ? ts.seconds : Number(ts.seconds.toNumber!());
    return new Date(seconds * 1000 + Math.floor(ts.nanos / 1e6));
  }

  private caller(ctx: Context): string {
    return ctx.clientIdentity.getMSPID();
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

  private sampleKey(ctx: Context, code: string): string {
    return ctx.stub.createCompositeKey(KEY.SAMPLE, [code]);
  }

  private resultsKey(ctx: Context, code: string): string {
    return ctx.stub.createCompositeKey(KEY.RESULTS, [code]);
  }

  private oversightKey(ctx: Context, code: string): string {
    return ctx.stub.createCompositeKey(KEY.OVERSIGHT, [code]);
  }

  private async collect<T>(ctx: Context, prefix: string, attrs: string[]): Promise<T[]> {
    // fabric-shim iterators use an explicit next()/close() protocol. They are
    // NOT async-iterable at runtime, whatever `for await` may appear to promise:
    // a `for await` loop over one fails at the peer with "it is not async
    // iterable". The iterator must also be closed, or the peer leaks it.
    const it = await ctx.stub.getStateByPartialCompositeKey(prefix, attrs);
    const out: T[] = [];
    try {
      let res = await it.next();
      while (!res.done) {
        const s = res.value?.value?.toString();
        if (s) out.push(JSON.parse(s) as T);
        res = await it.next();
      }
    } finally {
      await it.close();
    }
    return out;
  }

  /**
   * Bind a key to a cross-organizational endorsement policy (state-based
   * endorsement). This is the §4.1 mitigation of insider collusion across CA
   * boundaries expressed as an enforced ledger property: after this call, a
   * write to `key` endorsed by a single organization fails validation at
   * commit time with ENDORSEMENT_POLICY_FAILURE.
   */
  private async requireCrossOrgEndorsement(
    ctx: Context,
    key: string,
    ...msps: string[]
  ): Promise<void> {
    const ep = new KeyEndorsementPolicy();
    ep.addOrgs('PEER', ...msps);
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
    await this.put(
      ctx,
      ctx.stub.createCompositeKey(KEY.EXCEPTION, [sampleCode, String(sequence)]),
      record,
    );
    ctx.stub.setEvent('CustodyException', Buffer.from(JSON.stringify(record)));
    return record;
  }

  // ------------------------------------------------- Article 5.3 — initiation

  /**
   * WADA Code Article 5.3 — doping control process initiation.
   *
   * The doping control officer acts under NADO authority, so only a NADO
   * identity may open a custody chain. Only the pseudonymized athlete hash is
   * written; no direct identifier ever reaches the ledger (GDPR Art. 25).
   */
  @Transaction()
  @Returns('string')
  public async initiateSampleCustody(
    ctx: Context,
    sampleCode: string,
    athleteHash: string,
    sealedContainerHash: string,
    collectionLocation: string,
  ): Promise<string> {
    const msp = this.requireMSP(ctx, MSP.NADO);

    if (await this.get(ctx, this.sampleKey(ctx, sampleCode))) {
      throw new Error(`sample ${sampleCode} already exists`);
    }
    if (!athleteHash || athleteHash.length < 32) {
      throw new Error('athleteHash must be a pseudonymized digest of at least 32 characters');
    }

    const now = this.txTime(ctx);
    const sample: SampleRecord = {
      docType: 'sample',
      sampleCode,
      athleteHash,
      sealedContainerHash,
      collectionLocation,
      collectionTimestamp: now.toISOString(),
      initiatingMSP: msp,
      status: 'IN_CUSTODY',
      custodySequence: 0,
    };
    await this.put(ctx, this.sampleKey(ctx, sampleCode), sample);

    // The collection itself is custody step 0.
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
      containerSealIntact: true,
    };
    await this.put(
      ctx,
      ctx.stub.createCompositeKey(KEY.CUSTODY, [sampleCode, '0']),
      collection,
    );

    // Athlete notification (§3.4): the athlete learns of every custody event.
    ctx.stub.setEvent(
      'SampleCustodyInitiated',
      Buffer.from(JSON.stringify({ sampleCode, athleteHash, at: now.toISOString() })),
    );
    return JSON.stringify(sample);
  }

  // --------------------------------------------- Article 5.4 — custody transfer

  /**
   * WADA Code Article 5.4 — sample collection and custody transfer.
   *
   * Both the transferring and the receiving organization must endorse: the
   * chaincode-level policy is satisfied only when peers from `fromMSP` and
   * `toMSP` both sign, and the written key is additionally bound to that pair
   * by state-based endorsement. A handover recorded after the deadline is
   * still written — suppressing it would destroy the audit trail — but it
   * raises an exception record and alerts the NADO.
   */
  @Transaction()
  @Returns('string')
  public async recordCustodyTransfer(
    ctx: Context,
    sampleCode: string,
    phase: string,
    fromMSP: string,
    toMSP: string,
    containerSealIntact: string,
    transferWindowHours: string,
  ): Promise<string> {
    const submitter = this.caller(ctx);
    const sample = await this.mustGet<SampleRecord>(
      ctx,
      this.sampleKey(ctx, sampleCode),
      'sample',
    );
    if (sample.status === 'INVALIDATED') {
      throw new Error(`sample ${sampleCode} is invalidated; no further transfers accepted`);
    }
    if (submitter !== fromMSP && submitter !== toMSP) {
      throw new Error(
        `submitter ${submitter} is party to neither side of the transfer ${fromMSP} -> ${toMSP}`,
      );
    }

    const validPhases: CustodyPhase[] = [
      'TRANSPORT_HANDOFF',
      'LABORATORY_RECEIPT',
      'LABORATORY_INTERNAL',
      'ANALYSIS_COMPLETE',
    ];
    if (!validPhases.includes(phase as CustodyPhase)) {
      throw new Error(`unknown custody phase: ${phase}`);
    }

    const now = this.txTime(ctx);
    const sequence = sample.custodySequence + 1;

    // `Number(x) || DEFAULT` silently rewrites a caller's zero-hour window to
    // the default, because 0 is falsy — a deployment that requires an immediate
    // handover would have been given a 48-hour one without warning. Only an
    // absent or non-numeric value may fall back.
    const parsedWindow = Number(transferWindowHours);
    const windowHours =
      transferWindowHours !== '' && Number.isFinite(parsedWindow) && parsedWindow >= 0
        ? parsedWindow
        : DEFAULT_TRANSFER_WINDOW_HOURS;

    // Deadline runs from the previous custody event, not from now.
    const previous = await this.get<CustodyEvent>(
      ctx,
      ctx.stub.createCompositeKey(KEY.CUSTODY, [sampleCode, String(sample.custodySequence)]),
    );
    const previousAt = previous ? new Date(previous.recordedAt) : new Date(sample.collectionTimestamp);
    const deadline = new Date(previousAt.getTime() + windowHours * 60 * 60 * 1000);

    const event: CustodyEvent = {
      docType: 'custodyEvent',
      sampleCode,
      sequence,
      phase: phase as CustodyPhase,
      fromMSP,
      toMSP,
      transferDeadline: deadline.toISOString(),
      recordedAt: now.toISOString(),
      submittingMSP: submitter,
      containerSealIntact: containerSealIntact === 'true',
    };

    const key = ctx.stub.createCompositeKey(KEY.CUSTODY, [sampleCode, String(sequence)]);
    await this.put(ctx, key, event);
    await this.requireCrossOrgEndorsement(ctx, key, fromMSP, toMSP);

    sample.custodySequence = sequence;
    await this.put(ctx, this.sampleKey(ctx, sampleCode), sample);

    if (now.getTime() > deadline.getTime()) {
      await this.raiseException(
        ctx,
        sampleCode,
        sequence,
        'TRANSFER_WINDOW_EXCEEDED',
        `custody handover ${fromMSP} -> ${toMSP} recorded at ${now.toISOString()}, ` +
          `after the ${windowHours}h window closing ${deadline.toISOString()}`,
        [MSP.NADO],
      );
    }
    if (!event.containerSealIntact) {
      await this.raiseException(
        ctx,
        sampleCode,
        sequence,
        'CONTAINER_SEAL_BROKEN',
        `seal reported broken at phase ${phase}`,
        [MSP.NADO, MSP.LAB],
      );
    }

    ctx.stub.setEvent('CustodyTransferRecorded', Buffer.from(JSON.stringify(event)));
    return JSON.stringify(event);
  }

  // ------------------------------------------- Article 2.1 — analysis result

  /**
   * WADA Code Article 2.1 — presence of a prohibited substance.
   *
   * Only a laboratory identity may commit an analysis result. The Prohibited
   * List version cited by the laboratory is hash-verified against the copy
   * registered on the ledger, so a result cannot be justified against a list
   * revision that was never published to the network.
   */
  @Transaction()
  @Returns('string')
  public async recordSampleAnalysisResult(
    ctx: Context,
    sampleCode: string,
    adverse: string,
    substance: string,
    prohibitedListVersion: string,
    prohibitedListHash: string,
    laboratoryAccreditation: string,
  ): Promise<string> {
    const msp = this.requireMSP(ctx, MSP.LAB);
    const sample = await this.mustGet<SampleRecord>(
      ctx,
      this.sampleKey(ctx, sampleCode),
      'sample',
    );
    if (sample.status === 'INVALIDATED') {
      throw new Error(`sample ${sampleCode} is invalidated; analysis cannot be committed`);
    }

    const registered = await this.get<{ version: string; hash: string }>(
      ctx,
      ctx.stub.createCompositeKey(KEY.PROHIBITED_LIST, [prohibitedListVersion]),
    );
    if (!registered) {
      throw new Error(`Prohibited List version ${prohibitedListVersion} is not registered on-ledger`);
    }
    if (registered.hash !== prohibitedListHash) {
      throw new Error(
        `Prohibited List hash mismatch for ${prohibitedListVersion}: ` +
          `analysis cites ${prohibitedListHash}, ledger holds ${registered.hash}`,
      );
    }

    const accreditation = laboratoryAccreditation as AccreditationState;
    if (!['VERIFIED', 'PENDING', 'UNVERIFIED'].includes(accreditation)) {
      throw new Error(`invalid accreditation state: ${laboratoryAccreditation}`);
    }

    const result: AnalysisResult = {
      docType: 'analysisResult',
      sampleCode,
      laboratoryMSP: msp,
      adverse: adverse === 'true',
      substance: substance || undefined,
      prohibitedListVersion,
      prohibitedListHash,
      laboratoryAccreditation: accreditation,
      recordedAt: this.txTime(ctx).toISOString(),
    };
    await this.put(ctx, ctx.stub.createCompositeKey(KEY.ANALYSIS, [sampleCode]), result);

    sample.status = 'ANALYSED';
    sample.prohibitedListVersion = prohibitedListVersion;
    await this.put(ctx, this.sampleKey(ctx, sampleCode), sample);

    ctx.stub.setEvent('SampleAnalysisRecorded', Buffer.from(JSON.stringify(result)));
    return JSON.stringify(result);
  }

  /** Register a Prohibited List revision. NADO or WADA-side administration. */
  @Transaction()
  public async registerProhibitedList(
    ctx: Context,
    version: string,
    hash: string,
  ): Promise<void> {
    this.requireMSP(ctx, MSP.NADO, MSP.LAB);
    await this.put(ctx, ctx.stub.createCompositeKey(KEY.PROHIBITED_LIST, [version]), {
      version,
      hash,
      registeredAt: this.txTime(ctx).toISOString(),
    });
  }

  // --------------------------------------------- Article 2.4 — whereabouts

  /**
   * WADA Code Article 2.4 — whereabouts failure documentation.
   *
   * Records a filing or a failure and reports the failure count inside the
   * rolling 12-month window ending at the transaction timestamp.
   */
  @Transaction()
  @Returns('string')
  public async recordWhereaboutsStatus(
    ctx: Context,
    athleteHash: string,
    filingId: string,
    failure: string,
    ledgerVerified: string,
  ): Promise<string> {
    const msp = this.requireMSP(ctx, MSP.NADO, MSP.FEDERATION);
    const now = this.txTime(ctx);

    const record: WhereaboutsRecord = {
      docType: 'whereabouts',
      athleteHash,
      filingId,
      failure: failure === 'true',
      ledgerVerified: ledgerVerified === 'true',
      recordedAt: now.toISOString(),
      recordingMSP: msp,
    };
    await this.put(
      ctx,
      ctx.stub.createCompositeKey(KEY.WHEREABOUTS, [athleteHash, filingId]),
      record,
    );

    const summary = await this.whereaboutsFailureSummary(ctx, athleteHash, now);
    ctx.stub.setEvent(
      'WhereaboutsStatusRecorded',
      Buffer.from(JSON.stringify({ ...record, ...summary })),
    );
    return JSON.stringify({ ...record, ...summary });
  }

  /** Failures inside the rolling 12-month window, and whether all are verified. */
  private async whereaboutsFailureSummary(
    ctx: Context,
    athleteHash: string,
    now: Date,
  ): Promise<{ failuresInWindow: number; allFailuresLedgerVerified: boolean }> {
    const all = await this.collect<WhereaboutsRecord>(ctx, KEY.WHEREABOUTS, [athleteHash]);
    const cutoff = now.getTime() - WHEREABOUTS_WINDOW_DAYS * DAY_MS;
    const inWindow = all.filter(
      (r) => r.failure && new Date(r.recordedAt).getTime() >= cutoff,
    );
    return {
      failuresInWindow: inWindow.length,
      allFailuresLedgerVerified:
        inWindow.length > 0 && inWindow.every((r) => r.ledgerVerified),
    };
  }

  // -------------------------------- Article 7.1 — results management trigger

  /**
   * WADA Code Article 7.1 — results management after an adverse finding.
   *
   * Assembles the Q001-Q007 condition vector from committed ledger state and
   * runs it through the Table 2 decision engine. This function is the entry
   * point of the automation the manuscript's title claims.
   */
  @Transaction()
  @Returns('string')
  public async triggerResultsManagement(ctx: Context, sampleCode: string): Promise<string> {
    this.requireMSP(ctx, MSP.NADO, MSP.LAB);
    const sample = await this.mustGet<SampleRecord>(
      ctx,
      this.sampleKey(ctx, sampleCode),
      'sample',
    );
    const now = this.txTime(ctx);

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
      confidential: decision.confidential,
      decidedAt: now.toISOString(),
    };

    if (decision.action === ResultsAction.AafConfirmed) {
      record.statutoryDeadline = new Date(
        now.getTime() + ARTICLE_73_PERIOD_DAYS * DAY_MS,
      ).toISOString();
    }

    const key = this.resultsKey(ctx, sampleCode);
    await this.put(ctx, key, record);

    // Critical results-management state requires endorsement from two distinct
    // organizational classes (§4.1). A NADO acting alone cannot alter it.
    await this.requireCrossOrgEndorsement(ctx, key, MSP.NADO, MSP.LAB);

    sample.status =
      decision.action === ResultsAction.ProcessInvalidated ? 'INVALIDATED' : 'RESULTS_MANAGEMENT';
    await this.put(ctx, this.sampleKey(ctx, sampleCode), sample);

    if (decision.auditAlertRecipients.length > 0) {
      await this.raiseException(
        ctx,
        sampleCode,
        sample.custodySequence,
        decision.ruleId,
        decision.rationale,
        decision.auditAlertRecipients,
      );
    }

    ctx.stub.setEvent('ResultsManagementDecided', Buffer.from(JSON.stringify(record)));
    return JSON.stringify({ ...record, concurrentMatches: decision.concurrentMatches });
  }

  /**
   * Derive Q001-Q007 from committed ledger state only.
   *
   * Q007 ("mandatory custody step verified") required an interpretation the
   * manuscript does not supply. It is treated as satisfied only when all three
   * mandatory phases are present, no container seal was reported broken, and no
   * blocking exception was raised. In particular a handover recorded after its
   * contractual window has lapsed sets Q007 to NO and therefore invalidates the
   * process: an unexplained gap in the custody timeline is exactly the condition
   * under which a sample's integrity cannot be asserted, which is the failure
   * mode documented in the McLaren investigation.
   *
   * This is deliberately strict, and it is a policy choice rather than a
   * technical necessity: the window length is a transaction parameter, so a
   * deployment that regards late-but-documented handovers as acceptable can
   * widen it rather than weaken the rule.
   */
  private async assembleFacts(
    ctx: Context,
    sample: SampleRecord,
    now: Date,
  ): Promise<DecisionFacts> {
    const analysis = await this.get<AnalysisResult>(
      ctx,
      ctx.stub.createCompositeKey(KEY.ANALYSIS, [sample.sampleCode]),
    );
    const custody = await this.collect<CustodyEvent>(ctx, KEY.CUSTODY, [sample.sampleCode]);
    const recordedPhases = new Set(custody.map((c) => c.phase));
    const sealsIntact = custody.every((c) => c.containerSealIntact);
    const exceptions = await this.collect<ExceptionRecord>(ctx, KEY.EXCEPTION, [
      sample.sampleCode,
    ]);
    const blockingException = exceptions.some(
      (e) => e.reason === 'TRANSFER_WINDOW_EXCEEDED' || e.reason === 'CONTAINER_SEAL_BROKEN',
    );

    const wb = await this.whereaboutsFailureSummary(ctx, sample.athleteHash, now);
    const abp = await this.get<{ anomaly: boolean; expertPanelRequired: boolean }>(
      ctx,
      ctx.stub.createCompositeKey('ABP', [sample.athleteHash]),
    );

    return {
      sampleAnalysisPositive: analysis?.adverse === true,
      laboratoryAccreditation: analysis?.laboratoryAccreditation ?? 'UNVERIFIED',
      longitudinalProfileAnomaly: abp?.anomaly === true,
      expertPanelReviewRequired: abp?.expertPanelRequired === true,
      thirdWhereaboutsFailure: wb.failuresInWindow >= 3,
      allFailuresLedgerVerified: wb.allFailuresLedgerVerified,
      mandatoryCustodyStepVerified:
        MANDATORY_CUSTODY_STEPS.every((p) => recordedPhases.has(p)) &&
        sealsIntact &&
        !blockingException,
    };
  }

  /** Record an Athlete Biological Passport evaluation (feeds Q003 and Q004). */
  @Transaction()
  public async recordPassportEvaluation(
    ctx: Context,
    athleteHash: string,
    anomaly: string,
    expertPanelRequired: string,
  ): Promise<void> {
    this.requireMSP(ctx, MSP.LAB, MSP.NADO);
    await this.put(ctx, ctx.stub.createCompositeKey('ABP', [athleteHash]), {
      docType: 'passportEvaluation',
      athleteHash,
      anomaly: anomaly === 'true',
      expertPanelRequired: expertPanelRequired === 'true',
      recordedAt: this.txTime(ctx).toISOString(),
    });
  }

  // ------------------------------------------ Article 7.3 — athlete notification

  /**
   * WADA Code Article 7.3 — notification of the athlete within the statutory
   * period. Emits the notification event and starts the statutory clock.
   */
  @Transaction()
  @Returns('string')
  public async notifyAthleteOfAAF(ctx: Context, sampleCode: string): Promise<string> {
    this.requireMSP(ctx, MSP.NADO);
    const results = await this.mustGet<ResultsManagementRecord>(
      ctx,
      this.resultsKey(ctx, sampleCode),
      'results management record',
    );
    if (results.action !== ResultsAction.AafConfirmed) {
      throw new Error(
        `Article 7.3 notification requires a confirmed adverse analytical finding; ` +
          `sample ${sampleCode} is in state ${results.action}`,
      );
    }

    const now = this.txTime(ctx);
    const notification = {
      docType: 'aafNotification',
      sampleCode,
      athleteHash: results.athleteHash,
      notifiedAt: now.toISOString(),
      statutoryDeadline: results.statutoryDeadline,
      withinStatutoryPeriod: results.statutoryDeadline
        ? now.getTime() <= new Date(results.statutoryDeadline).getTime()
        : false,
    };
    await this.put(
      ctx,
      ctx.stub.createCompositeKey('NOTIFICATION', [sampleCode]),
      notification,
    );
    ctx.stub.setEvent('AthleteNotifiedOfAAF', Buffer.from(JSON.stringify(notification)));
    return JSON.stringify(notification);
  }

  // ------------------------------- Article 7.9 — provisional suspension

  /**
   * WADA Code Article 7.9 — provisional suspension.
   *
   * A provisional suspension is a career-affecting decision, so GDPR Article
   * 22 forbids taking it by automated processing alone. The chaincode refuses
   * to write one unless a human oversight record already exists on the ledger.
   * This precondition is the invariant checked by the TLA+ model in docs/.
   */
  @Transaction()
  @Returns('string')
  public async recordProvisionalSuspension(
    ctx: Context,
    sampleCode: string,
    groundsArticle: string,
  ): Promise<string> {
    this.requireMSP(ctx, MSP.NADO);
    const results = await this.mustGet<ResultsManagementRecord>(
      ctx,
      this.resultsKey(ctx, sampleCode),
      'results management record',
    );

    const oversight = await this.get<OversightRecord>(ctx, this.oversightKey(ctx, sampleCode));
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

    const now = this.txTime(ctx);
    const suspension = {
      docType: 'provisionalSuspension',
      sampleCode,
      athleteHash: results.athleteHash,
      groundsArticle,
      oversightReviewer: oversight.reviewerId,
      oversightRecordedAt: oversight.recordedAt,
      imposedAt: now.toISOString(),
      imposedBy: this.caller(ctx),
    };
    const key = ctx.stub.createCompositeKey(KEY.SUSPENSION, [sampleCode]);
    await this.put(ctx, key, suspension);
    await this.requireCrossOrgEndorsement(ctx, key, MSP.NADO, MSP.LAB);

    ctx.stub.setEvent('ProvisionalSuspensionRecorded', Buffer.from(JSON.stringify(suspension)));
    return JSON.stringify(suspension);
  }

  /** GDPR Art. 22 — record the human review that automated processing requires. */
  @Transaction()
  @Returns('string')
  public async enforceOversightRequirement(
    ctx: Context,
    sampleCode: string,
    reviewerId: string,
    decision: string,
    rationale: string,
  ): Promise<string> {
    const msp = this.requireMSP(ctx, MSP.NADO, MSP.LAB);
    if (!['UPHOLD', 'REJECT', 'REQUEST_FURTHER_ANALYSIS'].includes(decision)) {
      throw new Error(`invalid oversight decision: ${decision}`);
    }
    if (!reviewerId || !rationale) {
      throw new Error('an oversight record requires an identified reviewer and a rationale');
    }

    const record: OversightRecord = {
      docType: 'oversight',
      sampleCode,
      reviewerId,
      reviewerMSP: msp,
      decision: decision as OversightRecord['decision'],
      rationale,
      recordedAt: this.txTime(ctx).toISOString(),
    };
    await this.put(ctx, this.oversightKey(ctx, sampleCode), record);
    ctx.stub.setEvent('HumanOversightRecorded', Buffer.from(JSON.stringify(record)));
    return JSON.stringify(record);
  }

  // --------------------------- Article 14.1 — results confidentiality (ABAC)

  /**
   * WADA Code Article 14.1 — confidentiality during results management.
   *
   * Deny-by-default gate on results visibility. While a case is in results
   * management only the NADO, the analysing laboratory and the athlete may
   * read it; federations and research organizations are refused. Once the case
   * closes, the federation gains access.
   */
  @Transaction(false)
  @Returns('string')
  public async enforceResultsConfidentiality(
    ctx: Context,
    sampleCode: string,
  ): Promise<string> {
    const requester = this.caller(ctx);
    const sample = await this.mustGet<SampleRecord>(
      ctx,
      this.sampleKey(ctx, sampleCode),
      'sample',
    );
    const results = await this.get<ResultsManagementRecord>(
      ctx,
      this.resultsKey(ctx, sampleCode),
    );

    const inManagement = sample.status === 'RESULTS_MANAGEMENT';
    const permitted = inManagement
      ? [MSP.NADO, MSP.LAB, MSP.ATHLETE]
      : [MSP.NADO, MSP.LAB, MSP.ATHLETE, MSP.FEDERATION];

    if (!permitted.includes(requester as (typeof permitted)[number])) {
      return JSON.stringify({
        granted: false,
        sampleCode,
        requester,
        wadaArticle: 'Article 14.1',
        reason: inManagement
          ? 'results are confidential while the case is in results management'
          : 'organizational class has no lawful basis to read results',
      });
    }

    return JSON.stringify({
      granted: true,
      sampleCode,
      requester,
      wadaArticle: 'Article 14.1',
      results,
    });
  }

  // ------------------------------------------------------------------ queries

  @Transaction(false)
  @Returns('string')
  public async getSample(ctx: Context, sampleCode: string): Promise<string> {
    return JSON.stringify(
      await this.mustGet<SampleRecord>(ctx, this.sampleKey(ctx, sampleCode), 'sample'),
    );
  }

  @Transaction(false)
  @Returns('string')
  public async getCustodyChain(ctx: Context, sampleCode: string): Promise<string> {
    const chain = await this.collect<CustodyEvent>(ctx, KEY.CUSTODY, [sampleCode]);
    chain.sort((a, b) => a.sequence - b.sequence);
    return JSON.stringify(chain);
  }

  @Transaction(false)
  @Returns('string')
  public async getResultsManagement(ctx: Context, sampleCode: string): Promise<string> {
    return JSON.stringify(
      await this.mustGet<ResultsManagementRecord>(
        ctx,
        this.resultsKey(ctx, sampleCode),
        'results management record',
      ),
    );
  }

  /**
   * Evaluate the Table 2 decision logic without touching the ledger.
   * Exposed so that the decision engine can be benchmarked and audited
   * independently of state access cost.
   */
  @Transaction(false)
  @Returns('string')
  public async evaluateDecisionTable(ctx: Context, factsJson: string): Promise<string> {
    const facts = JSON.parse(factsJson) as DecisionFacts;
    return JSON.stringify(decideResultsAction(facts));
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
        history.push({
          txId: entry?.txId,
          isDelete: entry?.isDelete,
          value: raw ? JSON.parse(raw) : null,
        });
        res = await it.next();
      }
    } finally {
      await it.close();
    }
    return JSON.stringify(history);
  }
}
