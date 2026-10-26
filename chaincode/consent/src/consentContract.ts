/**
 * Consent and data-sovereignty chaincode.
 *
 * Implements the GDPR functions of Supplementary Table S2:
 *
 *   Article 7     -> validateConsent(), recordConsentTransaction(), withdrawConsent()
 *   Article 9     -> checkSpecialCategoryAuthorization()
 *   Article 17    -> revokeDataAccessKey(), restoreDataAccessKey(), destroyIPFSAccessToken()
 *   Article 17(2) -> destroyIPFSAccessToken() notifies every recipient of released data
 *   Article 22    -> flagForHumanReview(), enforceOversightRequirement()
 *   Article 25    -> enforceDataMinimisation(), applyDefaultPrivacySettings()
 *
 * Consent records, access decisions, off-chain pointers and erasure records
 * live in a private data collection held only by the athlete organisation's
 * peers (CONSENT_COLLECTION). Every other organisation holds their hashes in
 * the shared ledger and nothing else. A request from any organisation is
 * therefore evaluated, and endorsed, by an athlete-organisation peer: the
 * athlete's side of the network is the policy decision point for the
 * athlete's own data.
 *
 * Inputs to writing functions arrive in the transient field "input", and
 * responses carry only a reference, because arguments and responses are
 * written to the shared block that every organisation stores.
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import {
  AccessDecision,
  AccessRequest,
  ConsentGrant,
  DataCategory,
  DATA_CATEGORIES,
  SPECIAL_CATEGORY,
  defaultPrivacySettings,
  evaluateAccess,
  isDataCategory,
  minimiseForPurpose,
  PURPOSE_LIMITS,
} from './abac';

export const CONSENT_COLLECTION = 'consentCollection';

const KEY = {
  CONSENT: 'CONSENT',
  DEFAULTS: 'PRIVACYDEFAULTS',
  PAYLOAD: 'PAYLOAD',
  ERASURE: 'ERASURE',
  REVIEW: 'REVIEW',
  OVERSIGHT: 'CONSENTOVERSIGHT',
  AUDIT: 'ACCESSAUDIT',
  RECIPIENTS: 'RECIPIENTS',
} as const;

const MSP = {
  ATHLETE: 'AthleteMSP',
  FEDERATION: 'FederationMSP',
  NADO: 'NADOMSP',
  LAB: 'LabMSP',
  RESEARCH: 'ResearchMSP',
} as const;

/**
 * Key-recovery holders. The athlete holds two of the four shares and the
 * threshold is three, so recovery needs the athlete and one custodian; the
 * physician and the federation official together hold two and cannot
 * reconstruct the key without the athlete (offchain/src/shamir.ts).
 */
export const RECOVERY_HOLDERS = ['athlete', 'physician', 'federation-official'] as const;

const CLOCK_SKEW_MS = Number(process.env.CLOCK_SKEW_SECONDS ?? 300) * 1000;
const PSEUDONYM = /^[0-9a-f]{64}$/;

let peerClock: () => number = () => Date.now();

/** Test hook: replace the endorsing peer's clock. */
export function setPeerClockForTesting(clock: () => number): void {
  peerClock = clock;
}

interface PayloadRecord {
  docType: 'offchainPayload';
  athleteHash: string;
  category: DataCategory;
  cid: string;
  keyRef: string;
  /** Keyed commitment to the plaintext; unverifiable once the key is destroyed. */
  commitment: string;
  registeredBy: string;
  registeredAt: string;
  keyRevoked: boolean;
  erased: boolean;
}

interface AuditRecord extends AccessDecision {
  docType: 'accessAudit';
  auditRef: string;
  decidedAt: string;
}

@Info({
  title: 'ConsentContract',
  description: 'GDPR consent, six-category ABAC and Article 17 erasure (Supplementary Table S2)',
})
export class ConsentContract extends Contract {
  constructor() {
    super('ConsentContract');
  }

  // ------------------------------------------------------------------ helpers

  private txTime(ctx: Context): Date {
    const ts = ctx.stub.getTxTimestamp() as unknown as {
      seconds: { toNumber?: () => number } | number;
      nanos: number;
    };
    const seconds =
      typeof ts.seconds === 'number' ? ts.seconds : Number(ts.seconds.toNumber!());
    return new Date(seconds * 1000 + Math.floor(ts.nanos / 1e6));
  }

  /** Refuse a client-chosen timestamp that is implausible to this endorsing peer. */
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
    await ctx.stub.putPrivateData(CONSENT_COLLECTION, key, Buffer.from(JSON.stringify(value)));
  }

  private async get<T>(ctx: Context, key: string): Promise<T | null> {
    const data = await ctx.stub.getPrivateData(CONSENT_COLLECTION, key);
    return data && data.length > 0 ? (JSON.parse(Buffer.from(data).toString()) as T) : null;
  }

  private async range<T>(ctx: Context, prefix: string, attrs: string[]): Promise<T[]> {
    // fabric-shim iterators expose next()/close(), not Symbol.asyncIterator,
    // and the private range query resolves to { iterator, metadata } rather
    // than to the iterator itself.
    type Iterator = Awaited<ReturnType<typeof ctx.stub.getStateByPartialCompositeKey>>;
    const response = (await ctx.stub.getPrivateDataByPartialCompositeKey(
      CONSENT_COLLECTION,
      prefix,
      attrs,
    )) as unknown as { iterator?: Iterator };
    const it = response.iterator ?? (response as unknown as Iterator);
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

  private consentKey(ctx: Context, athleteHash: string, msp: string, purpose: string): string {
    return ctx.stub.createCompositeKey(KEY.CONSENT, [athleteHash, msp, purpose]);
  }

  private payloadKey(ctx: Context, athleteHash: string, category: string): string {
    return ctx.stub.createCompositeKey(KEY.PAYLOAD, [athleteHash, category]);
  }

  private parseCategories(value: string | string[]): DataCategory[] {
    const parts = (Array.isArray(value) ? value : value.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = parts.filter((p) => !isDataCategory(p));
    if (unknown.length > 0) {
      throw new Error(
        `unknown data categories: ${unknown.join(', ')}; ` +
          `valid categories are ${DATA_CATEGORIES.join(', ')}`,
      );
    }
    return parts as DataCategory[];
  }

  private requirePseudonym(athleteHash: string): void {
    if (!PSEUDONYM.test(athleteHash ?? '')) {
      throw new Error('athleteHash must be a keyed pseudonym: 64 lower-case hex characters');
    }
  }

  /**
   * Only the athlete organisation may act on an athlete's own consent: athlete
   * centrality expressed as an authorisation rule rather than a statement of
   * intent.
   */
  private requireAthlete(ctx: Context): void {
    const msp = this.caller(ctx);
    if (msp !== MSP.ATHLETE) {
      throw new Error(
        `only the athlete may grant or withdraw consent over their own data; caller is ${msp}`,
      );
    }
  }

  private evaluate(ctx: Context, athleteHash: string, purpose: string, categories: DataCategory[], at: Date) {
    const request: AccessRequest = {
      athleteHash,
      requestingMSP: this.caller(ctx),
      declaredPurpose: purpose,
      requestedCategories: categories,
      at: at.toISOString(),
    };
    return this.get<ConsentGrant>(ctx, this.consentKey(ctx, athleteHash, request.requestingMSP, purpose)).then(
      (grant) => evaluateAccess(request, grant),
    );
  }

  // ------------------------------------------ Article 25 — privacy by default

  /** GDPR Article 25(2): register an athlete with nothing shared with anyone. Input: { athleteHash }. */
  @Transaction()
  @Returns('string')
  public async applyDefaultPrivacySettings(ctx: Context): Promise<string> {
    this.requireAthlete(ctx);
    const now = this.boundedTime(ctx);
    const { athleteHash } = this.input<{ athleteHash: string }>(ctx);
    this.requirePseudonym(athleteHash);
    await this.put(ctx, ctx.stub.createCompositeKey(KEY.DEFAULTS, [athleteHash]), {
      docType: 'privacyDefaults',
      ...defaultPrivacySettings(athleteHash),
      appliedAt: now.toISOString(),
      gdprArticle: 'Article 25(2)',
    });
    return JSON.stringify({ applied: true });
  }

  /**
   * GDPR Article 25(1): narrow a requested category set to what the declared
   * purpose justifies, before any consent record is consulted.
   */
  @Transaction(false)
  @Returns('string')
  public async enforceDataMinimisation(
    ctx: Context,
    declaredPurpose: string,
    requestedCategories: string,
  ): Promise<string> {
    const requested = this.parseCategories(requestedCategories);
    const minimised = minimiseForPurpose(declaredPurpose, requested);
    return JSON.stringify({
      declaredPurpose,
      requested,
      minimised,
      excluded: requested.filter((c) => !minimised.includes(c)),
      purposeRecognised: Object.prototype.hasOwnProperty.call(PURPOSE_LIMITS, declaredPurpose),
      gdprArticle: 'Article 5(1)(c) / Article 25(1)',
    });
  }

  // ---------------------------------------------------- Article 7 — consent

  /**
   * GDPR Article 7: grant or amend consent.
   * Input: { athleteHash, grantedToMSP, purpose, categories, validFrom, validUntil, specialCategoryAuthorised }.
   */
  @Transaction()
  @Returns('string')
  public async recordConsentTransaction(ctx: Context): Promise<string> {
    this.requireAthlete(ctx);
    const now = this.boundedTime(ctx);
    const input = this.input<{
      athleteHash: string;
      grantedToMSP: string;
      purpose: string;
      categories: string | string[];
      validFrom: string;
      validUntil: string;
      specialCategoryAuthorised: boolean;
    }>(ctx);
    this.requirePseudonym(input.athleteHash);

    const categories = this.parseCategories(input.categories);
    if (categories.length === 0) throw new Error('a consent record must name at least one category');
    if (Number.isNaN(Date.parse(input.validFrom)) || Number.isNaN(Date.parse(input.validUntil))) {
      throw new Error('validFrom and validUntil must be ISO-8601 timestamps');
    }
    if (Date.parse(input.validUntil) <= Date.parse(input.validFrom)) {
      throw new Error('validUntil must be after validFrom');
    }

    const grant: ConsentGrant = {
      athleteHash: input.athleteHash,
      grantedToMSP: input.grantedToMSP,
      purpose: input.purpose,
      categories,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      specialCategoryAuthorised: input.specialCategoryAuthorised === true,
      revoked: false,
    };
    await this.put(ctx, this.consentKey(ctx, input.athleteHash, input.grantedToMSP, input.purpose), {
      docType: 'consent',
      ...grant,
      recordedAt: now.toISOString(),
      recordedBy: this.caller(ctx),
      gdprArticle: 'Article 7',
    });
    return JSON.stringify({ recorded: true });
  }

  /** GDPR Article 7(3): withdrawal must be as easy as giving consent. Input: { athleteHash, grantedToMSP, purpose }. */
  @Transaction()
  @Returns('string')
  public async withdrawConsent(ctx: Context): Promise<string> {
    this.requireAthlete(ctx);
    const now = this.boundedTime(ctx);
    const input = this.input<{ athleteHash: string; grantedToMSP: string; purpose: string }>(ctx);
    const key = this.consentKey(ctx, input.athleteHash, input.grantedToMSP, input.purpose);
    const record = await this.get<ConsentGrant & { docType: string }>(ctx, key);
    if (!record) throw new Error(`no consent record for ${input.grantedToMSP} / ${input.purpose}`);
    await this.put(ctx, key, {
      ...record,
      revoked: true,
      withdrawnAt: now.toISOString(),
      gdprArticle: 'Article 7(3)',
    });
    return JSON.stringify({ withdrawn: true });
  }

  /**
   * The ABAC gate. Evaluates a request against the athlete's consent record
   * and the purpose-limitation ceiling and writes the decision, granted or
   * not, to the access audit. The response is only a reference: the decision
   * itself is read back by the requester through getAccessDecision(), which an
   * athlete-organisation peer evaluates without writing anything to a block.
   *
   * Input: { athleteHash, declaredPurpose, requestedCategories }.
   */
  @Transaction()
  @Returns('string')
  public async validateConsent(ctx: Context): Promise<string> {
    const now = this.boundedTime(ctx);
    const input = this.input<{
      athleteHash: string;
      declaredPurpose: string;
      requestedCategories: string | string[];
    }>(ctx);
    const decision = await this.evaluate(
      ctx,
      input.athleteHash,
      input.declaredPurpose,
      this.parseCategories(input.requestedCategories),
      now,
    );
    const auditRef = ctx.stub.getTxID();
    const audit: AuditRecord = { docType: 'accessAudit', auditRef, ...decision, decidedAt: now.toISOString() };
    await this.put(
      ctx,
      ctx.stub.createCompositeKey(KEY.AUDIT, [input.athleteHash, this.caller(ctx), auditRef]),
      audit,
    );
    // Remember who has ever been released each category, for Article 17(2).
    // Erasure reads this key rather than range-querying the audit, because
    // Fabric refuses writes in a transaction that range-queried private data.
    // Written only the first time a recipient appears, so repeated requests
    // by the same organisation do not contend on it.
    for (const category of decision.granted) {
      const key = ctx.stub.createCompositeKey(KEY.RECIPIENTS, [input.athleteHash, category]);
      const recipients = (await this.get<{ msps: string[] }>(ctx, key)) ?? { msps: [] };
      if (!recipients.msps.includes(this.caller(ctx))) {
        recipients.msps.push(this.caller(ctx));
        await this.put(ctx, key, recipients);
      }
    }
    ctx.stub.setEvent('AccessDecisionRecorded', Buffer.from(JSON.stringify({ auditRef })));
    return JSON.stringify({ auditRef });
  }

  /** Read back a recorded access decision. Only the requester or the athlete organisation may. */
  @Transaction(false)
  @Returns('string')
  public async getAccessDecision(
    ctx: Context,
    athleteHash: string,
    requestingMSP: string,
    auditRef: string,
  ): Promise<string> {
    const caller = this.caller(ctx);
    if (caller !== requestingMSP && caller !== MSP.ATHLETE) {
      throw new Error(`${caller} may not read an access decision made for ${requestingMSP}`);
    }
    const audit = await this.get<AuditRecord>(
      ctx,
      ctx.stub.createCompositeKey(KEY.AUDIT, [athleteHash, requestingMSP, auditRef]),
    );
    if (!audit) throw new Error(`no access decision ${auditRef}`);
    return JSON.stringify(audit);
  }

  /** Evaluate without writing, for the user interface and for benchmarking the read path. */
  @Transaction(false)
  @Returns('string')
  public async previewConsentDecision(
    ctx: Context,
    athleteHash: string,
    declaredPurpose: string,
    requestedCategories: string,
  ): Promise<string> {
    return JSON.stringify(
      await this.evaluate(ctx, athleteHash, declaredPurpose, this.parseCategories(requestedCategories), this.txTime(ctx)),
    );
  }

  // -------------------------------------- Article 9 — special-category data

  /** GDPR Article 9: does an explicit authorisation exist for the caller's purpose? */
  @Transaction(false)
  @Returns('string')
  public async checkSpecialCategoryAuthorization(
    ctx: Context,
    athleteHash: string,
    purpose: string,
    categories: string,
  ): Promise<string> {
    const requested = this.parseCategories(categories);
    const grant = await this.get<ConsentGrant>(ctx, this.consentKey(ctx, athleteHash, this.caller(ctx), purpose));
    const special = requested.filter((c) => SPECIAL_CATEGORY.includes(c));
    const authorised = grant?.specialCategoryAuthorised === true && grant.revoked === false;
    return JSON.stringify({
      athleteHash,
      purpose,
      requestingMSP: this.caller(ctx),
      specialCategoriesRequested: special,
      authorised: special.length === 0 ? true : authorised,
      reason:
        special.length === 0
          ? 'no special-category data requested'
          : authorised
            ? 'explicit Article 9 authorization is on record'
            : 'no explicit Article 9 authorization for special-category biological data',
      gdprArticle: 'Article 9(2)(a)',
    });
  }

  // ------------------------------- Article 22 — automated decision oversight

  /** GDPR Article 22: block an automated decision until a human reviews it. Input: { subjectId, decisionType, rationale }. */
  @Transaction()
  @Returns('string')
  public async flagForHumanReview(ctx: Context): Promise<string> {
    const now = this.boundedTime(ctx);
    const input = this.input<{ subjectId: string; decisionType: string; rationale: string }>(ctx);
    await this.put(ctx, ctx.stub.createCompositeKey(KEY.REVIEW, [input.subjectId, input.decisionType]), {
      docType: 'humanReviewFlag',
      ...input,
      raisedBy: this.caller(ctx),
      raisedAt: now.toISOString(),
      resolved: false,
      gdprArticle: 'Article 22(3)',
    });
    return JSON.stringify({ flagged: true });
  }

  /**
   * GDPR Article 22: clear an automated decision only with a named human
   * reviewer and a rationale. Input: { subjectId, decisionType, reviewerId, outcome, rationale }.
   */
  @Transaction()
  @Returns('string')
  public async enforceOversightRequirement(ctx: Context): Promise<string> {
    const now = this.boundedTime(ctx);
    const input = this.input<{
      subjectId: string;
      decisionType: string;
      reviewerId: string;
      outcome: string;
      rationale: string;
    }>(ctx);
    if (!input.reviewerId) throw new Error('Article 22 oversight requires a named human reviewer');
    if (!input.rationale) throw new Error('Article 22 oversight requires a recorded rationale');
    if (!['UPHOLD', 'REJECT', 'REQUEST_FURTHER_ANALYSIS'].includes(input.outcome)) {
      throw new Error(`invalid oversight outcome: ${input.outcome}`);
    }
    const flagKey = ctx.stub.createCompositeKey(KEY.REVIEW, [input.subjectId, input.decisionType]);
    const flag = await this.get<Record<string, unknown>>(ctx, flagKey);
    if (!flag) {
      throw new Error(
        `no human-review flag exists for ${input.subjectId} / ${input.decisionType}; ` +
          'call flagForHumanReview() before recording oversight',
      );
    }
    await this.put(ctx, ctx.stub.createCompositeKey(KEY.OVERSIGHT, [input.subjectId, input.decisionType]), {
      docType: 'consentOversight',
      ...input,
      reviewerMSP: this.caller(ctx),
      recordedAt: now.toISOString(),
      gdprArticle: 'Article 22(3)',
    });
    await this.put(ctx, flagKey, { ...flag, resolved: true, resolvedAt: now.toISOString() });
    return JSON.stringify({ recorded: true });
  }

  /** Read the state of a review flag and any oversight decision recorded against it. */
  @Transaction(false)
  @Returns('string')
  public async getOversight(ctx: Context, subjectId: string, decisionType: string): Promise<string> {
    const flag = await this.get(ctx, ctx.stub.createCompositeKey(KEY.REVIEW, [subjectId, decisionType]));
    const oversight = await this.get(ctx, ctx.stub.createCompositeKey(KEY.OVERSIGHT, [subjectId, decisionType]));
    return JSON.stringify({ flag, oversight });
  }

  // -------------------------------------------- Article 17 — right to erasure

  /**
   * Register an off-chain payload: the content identifier, the key reference
   * and a keyed commitment to the plaintext. An unkeyed digest of a
   * low-entropy payload could be confirmed by guessing; the keyed commitment
   * cannot be, and becomes unverifiable when the key is destroyed.
   *
   * Input: { athleteHash, category, cid, keyRef, commitment }.
   */
  @Transaction()
  @Returns('string')
  public async registerOffchainPayload(ctx: Context): Promise<string> {
    const msp = this.caller(ctx);
    if (![MSP.ATHLETE, MSP.LAB, MSP.NADO].includes(msp as never)) {
      throw new Error(`${msp} may not register biological payloads`);
    }
    const now = this.boundedTime(ctx);
    const input = this.input<{ athleteHash: string; category: string; cid: string; keyRef: string; commitment: string }>(ctx);
    this.requirePseudonym(input.athleteHash);
    if (!isDataCategory(input.category)) throw new Error(`unknown data category: ${input.category}`);
    if (!input.cid || !input.keyRef) throw new Error('an off-chain payload needs both a CID and a key reference');
    const record: PayloadRecord = {
      docType: 'offchainPayload',
      athleteHash: input.athleteHash,
      category: input.category,
      cid: input.cid,
      keyRef: input.keyRef,
      commitment: input.commitment,
      registeredBy: msp,
      registeredAt: now.toISOString(),
      keyRevoked: false,
      erased: false,
    };
    await this.put(ctx, this.payloadKey(ctx, input.athleteHash, input.category), record);
    return JSON.stringify({ registered: true });
  }

  /** The registered pointer for one category; the athlete organisation or a granted requester may read it. */
  @Transaction(false)
  @Returns('string')
  public async getOffchainPayload(ctx: Context, athleteHash: string, category: string): Promise<string> {
    const record = await this.get<PayloadRecord>(ctx, this.payloadKey(ctx, athleteHash, category));
    if (!record) throw new Error(`no off-chain payload registered for ${category}`);
    return JSON.stringify(record);
  }

  /**
   * Suspend access by revoking the working copy of the data-encryption key.
   * This is not erasure: the key remains recoverable from the athlete's
   * shares, and the record says so. Input: { athleteHash, category }.
   */
  @Transaction()
  @Returns('string')
  public async revokeDataAccessKey(ctx: Context): Promise<string> {
    this.requireAthlete(ctx);
    const now = this.boundedTime(ctx);
    const input = this.input<{ athleteHash: string; category: string }>(ctx);
    const key = this.payloadKey(ctx, input.athleteHash, input.category);
    const payload = await this.get<PayloadRecord>(ctx, key);
    if (!payload) throw new Error(`no off-chain payload registered for ${input.category}`);
    if (payload.erased) throw new Error(`${input.category} has been erased`);
    await this.put(ctx, key, { ...payload, keyRevoked: true, keyRevokedAt: now.toISOString(), reversible: true });
    return JSON.stringify({ revoked: true, reversible: true });
  }

  /**
   * Record that access was restored from recovery shares. The athlete must be
   * among the holders: the custodians together cannot restore it.
   * Input: { athleteHash, category, holders }.
   */
  @Transaction()
  @Returns('string')
  public async restoreDataAccessKey(ctx: Context): Promise<string> {
    this.requireAthlete(ctx);
    const now = this.boundedTime(ctx);
    const input = this.input<{ athleteHash: string; category: string; holders: string[] }>(ctx);
    if (!input.holders?.includes('athlete')) {
      throw new Error('key recovery requires the athlete among the share holders');
    }
    const key = this.payloadKey(ctx, input.athleteHash, input.category);
    const payload = await this.get<PayloadRecord>(ctx, key);
    if (!payload) throw new Error(`no off-chain payload registered for ${input.category}`);
    if (payload.erased) throw new Error(`${input.category} has been erased and cannot be restored`);
    await this.put(ctx, key, { ...payload, keyRevoked: false, restoredAt: now.toISOString(), restoredWith: input.holders });
    return JSON.stringify({ restored: true });
  }

  /**
   * GDPR Article 17 — erasure, and Article 17(2) — notice to recipients.
   *
   * Records the erasure certificate from the off-chain module, which must
   * attest that the data-encryption key and every recovery share were
   * destroyed. Then, from the access audit, lists every organisation that was
   * ever granted this category of this athlete's data, and records and emits
   * an Article 17(2) notice to each: copies they decrypted are outside the
   * reach of key destruction, and the notice is what the regulation requires
   * in respect of them. The ledger is appended to, never rewritten.
   *
   * Input: { athleteHash, category, erasureCertificate }.
   */
  @Transaction()
  @Returns('string')
  public async destroyIPFSAccessToken(ctx: Context): Promise<string> {
    this.requireAthlete(ctx);
    const now = this.boundedTime(ctx);
    const input = this.input<{
      athleteHash: string;
      category: string;
      erasureCertificate: {
        cid?: string;
        keyDestroyed?: boolean;
        sharesDestroyed?: string[];
        unpinResults?: { endpoint: string; unpinned: boolean }[];
        complete?: boolean;
      };
    }>(ctx);
    const key = this.payloadKey(ctx, input.athleteHash, input.category);
    const payload = await this.get<PayloadRecord>(ctx, key);
    if (!payload) throw new Error(`no off-chain payload registered for ${input.category}`);

    const certificate = input.erasureCertificate ?? {};
    if (certificate.cid !== payload.cid) {
      throw new Error(`erasure certificate is for ${certificate.cid}, but the registered payload is ${payload.cid}`);
    }
    if (certificate.keyDestroyed !== true) {
      throw new Error('erasure certificate does not attest that the key was destroyed');
    }
    const missing = RECOVERY_HOLDERS.filter((h) => !(certificate.sharesDestroyed ?? []).includes(h));
    if (missing.length > 0) {
      throw new Error(
        `erasure certificate does not attest destruction of the recovery shares held by ${missing.join(', ')}; ` +
          'while any share survives the key is recoverable and the data is not erased',
      );
    }

    const recipients = [
      ...((await this.get<{ msps: string[] }>(
        ctx,
        ctx.stub.createCompositeKey(KEY.RECIPIENTS, [input.athleteHash, input.category]),
      ))?.msps ?? []),
    ].sort();

    await this.put(ctx, key, { ...payload, erased: true, erasedAt: now.toISOString() });
    const erasureRef = ctx.stub.getTxID();
    await this.put(ctx, ctx.stub.createCompositeKey(KEY.ERASURE, [input.athleteHash, input.category]), {
      docType: 'erasureRecord',
      erasureRef,
      athleteHash: input.athleteHash,
      category: input.category,
      certificate,
      article17_2Recipients: recipients,
      recordedAt: now.toISOString(),
      gdprArticle: 'Article 17(1) and 17(2)',
      scope:
        'Key destruction and unpinning make the network-held ciphertext permanently undecryptable. ' +
        'They do not reach plaintext the laboratory held before encryption, or copies a recipient ' +
        'decrypted after an authorised release; those recipients are notified under Article 17(2).',
      legalCaveat:
        'Cryptographic inaccessibility is not confirmed by supervisory authorities as ' +
        'erasure within the meaning of GDPR Article 17.',
    });
    ctx.stub.setEvent('ErasureNotice', Buffer.from(JSON.stringify({ erasureRef, recipients })));
    return JSON.stringify({ erasureRef, recipientsNotified: recipients.length });
  }

  /** The erasure record for one category, including the Article 17(2) recipients. */
  @Transaction(false)
  @Returns('string')
  public async getErasureRecord(ctx: Context, athleteHash: string, category: string): Promise<string> {
    this.requireAthlete(ctx);
    const record = await this.get(ctx, ctx.stub.createCompositeKey(KEY.ERASURE, [athleteHash, category]));
    if (!record) throw new Error(`no erasure record for ${category}`);
    return JSON.stringify(record);
  }

  // ------------------------------------------------------------------ queries

  @Transaction(false)
  @Returns('string')
  public async getConsent(ctx: Context, athleteHash: string, grantedToMSP: string, purpose: string): Promise<string> {
    const caller = this.caller(ctx);
    if (caller !== MSP.ATHLETE && caller !== grantedToMSP) {
      throw new Error(`${caller} may not read a consent given to ${grantedToMSP}`);
    }
    const record = await this.get(ctx, this.consentKey(ctx, athleteHash, grantedToMSP, purpose));
    if (!record) throw new Error(`no consent record for ${grantedToMSP} / ${purpose}`);
    return JSON.stringify(record);
  }

  /** Every consent record an athlete holds — the sovereignty dashboard view. */
  @Transaction(false)
  @Returns('string')
  public async listConsents(ctx: Context, athleteHash: string): Promise<string> {
    this.requireAthlete(ctx);
    return JSON.stringify(await this.range(ctx, KEY.CONSENT, [athleteHash]));
  }

  /** Every access decision recorded against an athlete's data. */
  @Transaction(false)
  @Returns('string')
  public async listAccessDecisions(ctx: Context, athleteHash: string): Promise<string> {
    this.requireAthlete(ctx);
    return JSON.stringify(await this.range(ctx, KEY.AUDIT, [athleteHash]));
  }

  @Transaction(false)
  @Returns('string')
  public async getDataCategories(): Promise<string> {
    return JSON.stringify({
      categories: DATA_CATEGORIES,
      specialCategory: SPECIAL_CATEGORY,
      purposeLimits: PURPOSE_LIMITS,
    });
  }
}
