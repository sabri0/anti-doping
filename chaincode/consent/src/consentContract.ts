/**
 * Consent and data-sovereignty chaincode.
 *
 * Implements every function named in Table 3 of the manuscript with its
 * published signature:
 *
 *   Article 7  -> validateConsent(), recordConsentTransaction()
 *   Article 9  -> checkSpecialCategoryAuthorization()
 *   Article 17 -> revokeDataAccessKey(), destroyIPFSAccessToken()
 *   Article 22 -> flagForHumanReview(), enforceOversightRequirement()
 *   Article 25 -> enforceDataMinimisation(), applyDefaultPrivacySettings()
 *
 * The ledger holds consent state, off-chain pointers and erasure certificates.
 * Biological payloads live in IPFS as ciphertext and never touch the ledger.
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import {
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

const KEY = {
  CONSENT: 'CONSENT',
  PAYLOAD: 'PAYLOAD',
  ERASURE: 'ERASURE',
  REVIEW: 'REVIEW',
  OVERSIGHT: 'CONSENTOVERSIGHT',
  AUDIT: 'ACCESSAUDIT',
} as const;

const MSP = {
  ATHLETE: 'AthleteMSP',
  FEDERATION: 'FederationMSP',
  NADO: 'NADOMSP',
  LAB: 'LabMSP',
  RESEARCH: 'ResearchMSP',
} as const;

@Info({
  title: 'ConsentContract',
  description: 'GDPR consent, six-category ABAC and Article 17 erasure (Table 3)',
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

  private caller(ctx: Context): string {
    return ctx.clientIdentity.getMSPID();
  }

  private async put(ctx: Context, key: string, value: unknown): Promise<void> {
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(value)));
  }

  private async get<T>(ctx: Context, key: string): Promise<T | null> {
    const data = await ctx.stub.getState(key);
    return data && data.length > 0 ? (JSON.parse(data.toString()) as T) : null;
  }

  private consentKey(ctx: Context, athleteHash: string, msp: string, purpose: string): string {
    return ctx.stub.createCompositeKey(KEY.CONSENT, [athleteHash, msp, purpose]);
  }

  private parseCategories(csv: string): DataCategory[] {
    const parts = csv
      .split(',')
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

  /**
   * Only the athlete organization may act on an athlete's own consent. This is
   * the "athlete centrality" design principle of §3.1 expressed as an
   * authorization rule rather than a statement of intent.
   */
  private requireAthlete(ctx: Context): void {
    const msp = this.caller(ctx);
    if (msp !== MSP.ATHLETE) {
      throw new Error(
        `only the athlete may grant or withdraw consent over their own data; ` +
          `caller is ${msp}`,
      );
    }
  }

  // ------------------------------------------ Article 25 — privacy by default

  /**
   * `applyDefaultPrivacySettings()` — GDPR Article 25(2).
   * Registers an athlete with nothing shared with anyone.
   */
  @Transaction()
  @Returns('string')
  public async applyDefaultPrivacySettings(
    ctx: Context,
    athleteHash: string,
  ): Promise<string> {
    this.requireAthlete(ctx);
    const settings = {
      docType: 'privacyDefaults',
      ...defaultPrivacySettings(athleteHash),
      appliedAt: this.txTime(ctx).toISOString(),
      gdprArticle: 'Article 25(2)',
    };
    await this.put(ctx, ctx.stub.createCompositeKey('PRIVACYDEFAULTS', [athleteHash]), settings);
    ctx.stub.setEvent('DefaultPrivacyApplied', Buffer.from(JSON.stringify(settings)));
    return JSON.stringify(settings);
  }

  /**
   * `enforceDataMinimisation()` — GDPR Article 25(1).
   * Narrows a requested category set to what the declared purpose justifies,
   * before any consent record is consulted.
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
   * `recordConsentTransaction()` — GDPR Article 7.
   * Writes an on-chain consent record: category set, requesting organization,
   * declared purpose and validity period.
   */
  @Transaction()
  @Returns('string')
  public async recordConsentTransaction(
    ctx: Context,
    athleteHash: string,
    grantedToMSP: string,
    purpose: string,
    categories: string,
    validFrom: string,
    validUntil: string,
    specialCategoryAuthorised: string,
  ): Promise<string> {
    this.requireAthlete(ctx);

    const parsed = this.parseCategories(categories);
    if (parsed.length === 0) throw new Error('a consent record must name at least one category');
    if (Number.isNaN(Date.parse(validFrom)) || Number.isNaN(Date.parse(validUntil))) {
      throw new Error('validFrom and validUntil must be ISO-8601 timestamps');
    }
    if (Date.parse(validUntil) <= Date.parse(validFrom)) {
      throw new Error('validUntil must be after validFrom');
    }

    const grant: ConsentGrant = {
      athleteHash,
      grantedToMSP,
      purpose,
      categories: parsed,
      validFrom,
      validUntil,
      specialCategoryAuthorised: specialCategoryAuthorised === 'true',
      revoked: false,
    };
    const record = {
      docType: 'consent',
      ...grant,
      recordedAt: this.txTime(ctx).toISOString(),
      recordedBy: this.caller(ctx),
      gdprArticle: 'Article 7',
    };

    await this.put(ctx, this.consentKey(ctx, athleteHash, grantedToMSP, purpose), record);
    ctx.stub.setEvent('ConsentRecorded', Buffer.from(JSON.stringify(record)));
    return JSON.stringify(record);
  }

  /** GDPR Article 7(3) — withdrawal must be as easy as giving consent. */
  @Transaction()
  @Returns('string')
  public async withdrawConsent(
    ctx: Context,
    athleteHash: string,
    grantedToMSP: string,
    purpose: string,
  ): Promise<string> {
    this.requireAthlete(ctx);
    const key = this.consentKey(ctx, athleteHash, grantedToMSP, purpose);
    const record = await this.get<ConsentGrant & { docType: string }>(ctx, key);
    if (!record) throw new Error(`no consent record for ${grantedToMSP} / ${purpose}`);

    const updated = {
      ...record,
      revoked: true,
      withdrawnAt: this.txTime(ctx).toISOString(),
      gdprArticle: 'Article 7(3)',
    };
    await this.put(ctx, key, updated);
    ctx.stub.setEvent('ConsentWithdrawn', Buffer.from(JSON.stringify(updated)));
    return JSON.stringify(updated);
  }

  /**
   * `validateConsent()` — the ABAC gate.
   *
   * Evaluates a data access request against the athlete's consent record and
   * the purpose-limitation ceiling, returning a per-category decision with a
   * reason for every refusal. Deny-by-default: an athlete with no consent
   * record releases nothing.
   */
  @Transaction()
  @Returns('string')
  public async validateConsent(
    ctx: Context,
    athleteHash: string,
    declaredPurpose: string,
    requestedCategories: string,
  ): Promise<string> {
    const request: AccessRequest = {
      athleteHash,
      requestingMSP: this.caller(ctx),
      declaredPurpose,
      requestedCategories: this.parseCategories(requestedCategories),
      at: this.txTime(ctx).toISOString(),
    };

    const grant = await this.get<ConsentGrant>(
      ctx,
      this.consentKey(ctx, athleteHash, request.requestingMSP, declaredPurpose),
    );
    const decision = evaluateAccess(request, grant);

    // Every access evaluation is auditable, granted or not (§4.2).
    const audit = {
      docType: 'accessAudit',
      ...decision,
      decidedAt: request.at,
    };
    await this.put(
      ctx,
      ctx.stub.createCompositeKey(KEY.AUDIT, [
        athleteHash,
        request.requestingMSP,
        ctx.stub.getTxID(),
      ]),
      audit,
    );
    ctx.stub.setEvent('AccessDecision', Buffer.from(JSON.stringify(audit)));
    return JSON.stringify(decision);
  }

  /** Read-only evaluation, for the UI and for benchmarking without a write. */
  @Transaction(false)
  @Returns('string')
  public async previewConsentDecision(
    ctx: Context,
    athleteHash: string,
    declaredPurpose: string,
    requestedCategories: string,
  ): Promise<string> {
    const request: AccessRequest = {
      athleteHash,
      requestingMSP: this.caller(ctx),
      declaredPurpose,
      requestedCategories: this.parseCategories(requestedCategories),
      at: this.txTime(ctx).toISOString(),
    };
    const grant = await this.get<ConsentGrant>(
      ctx,
      this.consentKey(ctx, athleteHash, request.requestingMSP, declaredPurpose),
    );
    return JSON.stringify(evaluateAccess(request, grant));
  }

  // -------------------------------------- Article 9 — special-category data

  /**
   * `checkSpecialCategoryAuthorization()` — GDPR Article 9.
   * Confirms an explicit authorization exists before special-category
   * biological data may be processed.
   */
  @Transaction(false)
  @Returns('string')
  public async checkSpecialCategoryAuthorization(
    ctx: Context,
    athleteHash: string,
    purpose: string,
    categories: string,
  ): Promise<string> {
    const requested = this.parseCategories(categories);
    const grant = await this.get<ConsentGrant>(
      ctx,
      this.consentKey(ctx, athleteHash, this.caller(ctx), purpose),
    );

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

  /**
   * `flagForHumanReview()` — GDPR Article 22.
   * Blocks an automated, career-affecting decision until a human reviews it.
   */
  @Transaction()
  @Returns('string')
  public async flagForHumanReview(
    ctx: Context,
    subjectId: string,
    decisionType: string,
    rationale: string,
  ): Promise<string> {
    const flag = {
      docType: 'humanReviewFlag',
      subjectId,
      decisionType,
      rationale,
      raisedBy: this.caller(ctx),
      raisedAt: this.txTime(ctx).toISOString(),
      resolved: false,
      gdprArticle: 'Article 22(3)',
    };
    await this.put(ctx, ctx.stub.createCompositeKey(KEY.REVIEW, [subjectId, decisionType]), flag);
    ctx.stub.setEvent('HumanReviewRequired', Buffer.from(JSON.stringify(flag)));
    return JSON.stringify(flag);
  }

  /**
   * `enforceOversightRequirement()` — GDPR Article 22.
   * Refuses to clear an automated decision unless a named human has reviewed
   * it. Returns the oversight record that downstream contracts require.
   */
  @Transaction()
  @Returns('string')
  public async enforceOversightRequirement(
    ctx: Context,
    subjectId: string,
    decisionType: string,
    reviewerId: string,
    outcome: string,
    rationale: string,
  ): Promise<string> {
    if (!reviewerId) throw new Error('Article 22 oversight requires a named human reviewer');
    if (!rationale) throw new Error('Article 22 oversight requires a recorded rationale');
    if (!['UPHOLD', 'REJECT', 'REQUEST_FURTHER_ANALYSIS'].includes(outcome)) {
      throw new Error(`invalid oversight outcome: ${outcome}`);
    }

    const flagKey = ctx.stub.createCompositeKey(KEY.REVIEW, [subjectId, decisionType]);
    const flag = await this.get<{ resolved: boolean }>(ctx, flagKey);
    if (!flag) {
      throw new Error(
        `no human-review flag exists for ${subjectId} / ${decisionType}; ` +
          'call flagForHumanReview() before recording oversight',
      );
    }

    const now = this.txTime(ctx).toISOString();
    const record = {
      docType: 'consentOversight',
      subjectId,
      decisionType,
      reviewerId,
      reviewerMSP: this.caller(ctx),
      outcome,
      rationale,
      recordedAt: now,
      gdprArticle: 'Article 22(3)',
    };
    await this.put(ctx, ctx.stub.createCompositeKey(KEY.OVERSIGHT, [subjectId, decisionType]), record);
    await this.put(ctx, flagKey, { ...flag, resolved: true, resolvedAt: now });
    ctx.stub.setEvent('OversightRecorded', Buffer.from(JSON.stringify(record)));
    return JSON.stringify(record);
  }

  // -------------------------------------------- Article 17 — right to erasure

  /**
   * Register an off-chain payload. Only the content identifier and the key
   * reference are written; the biological data itself stays in IPFS as
   * ciphertext (§3.5, §4.3).
   */
  @Transaction()
  @Returns('string')
  public async registerOffchainPayload(
    ctx: Context,
    athleteHash: string,
    category: string,
    cid: string,
    keyRef: string,
    plaintextDigest: string,
  ): Promise<string> {
    if (!isDataCategory(category)) throw new Error(`unknown data category: ${category}`);
    if (!cid || !keyRef) throw new Error('an off-chain payload needs both a CID and a key reference');

    const record = {
      docType: 'offchainPayload',
      athleteHash,
      category,
      cid,
      keyRef,
      plaintextDigest,
      registeredBy: this.caller(ctx),
      registeredAt: this.txTime(ctx).toISOString(),
      erased: false,
    };
    await this.put(ctx, ctx.stub.createCompositeKey(KEY.PAYLOAD, [athleteHash, category]), record);
    return JSON.stringify(record);
  }

  /**
   * `revokeDataAccessKey()` — GDPR Article 17, first half.
   * Marks the data-encryption key as revoked on-chain. The key material itself
   * is destroyed off-chain by the key vault; the ledger records that it was.
   */
  @Transaction()
  @Returns('string')
  public async revokeDataAccessKey(
    ctx: Context,
    athleteHash: string,
    category: string,
  ): Promise<string> {
    this.requireAthlete(ctx);
    const key = ctx.stub.createCompositeKey(KEY.PAYLOAD, [athleteHash, category]);
    const payload = await this.get<{ keyRef: string; cid: string }>(ctx, key);
    if (!payload) throw new Error(`no off-chain payload registered for ${category}`);

    const record = {
      ...payload,
      keyRevoked: true,
      keyRevokedAt: this.txTime(ctx).toISOString(),
      gdprArticle: 'Article 17',
    };
    await this.put(ctx, key, record);
    ctx.stub.setEvent('DataAccessKeyRevoked', Buffer.from(JSON.stringify(record)));
    return JSON.stringify(record);
  }

  /**
   * `destroyIPFSAccessToken()` — GDPR Article 17, completed.
   *
   * Records the erasure certificate produced by the off-chain module: which
   * key was destroyed, which IPFS nodes were unpinned, and the standing legal
   * caveat that cryptographic inaccessibility is not confirmed by supervisory
   * authorities to constitute erasure. The ledger is appended to, never
   * rewritten — that is what makes the scheme compatible with immutability.
   */
  @Transaction()
  @Returns('string')
  public async destroyIPFSAccessToken(
    ctx: Context,
    athleteHash: string,
    category: string,
    erasureCertificate: string,
  ): Promise<string> {
    this.requireAthlete(ctx);
    const key = ctx.stub.createCompositeKey(KEY.PAYLOAD, [athleteHash, category]);
    const payload = await this.get<{ cid: string; keyRef: string }>(ctx, key);
    if (!payload) throw new Error(`no off-chain payload registered for ${category}`);

    let certificate: { cid?: string; keyDestroyed?: boolean; complete?: boolean };
    try {
      certificate = JSON.parse(erasureCertificate);
    } catch {
      throw new Error('erasureCertificate must be the JSON document returned by the off-chain module');
    }
    if (certificate.cid !== payload.cid) {
      throw new Error(
        `erasure certificate is for ${certificate.cid}, but the registered payload is ${payload.cid}`,
      );
    }
    if (certificate.keyDestroyed !== true) {
      throw new Error('erasure certificate does not attest that the key was destroyed');
    }

    const now = this.txTime(ctx).toISOString();
    await this.put(ctx, key, { ...payload, erased: true, erasedAt: now });

    const record = {
      docType: 'erasureCertificate',
      athleteHash,
      category,
      certificate,
      recordedAt: now,
      gdprArticle: 'Article 17',
      legalCaveat:
        'Cryptographic inaccessibility is not confirmed by supervisory authorities as ' +
        'erasure within the meaning of GDPR Article 17.',
    };
    await this.put(ctx, ctx.stub.createCompositeKey(KEY.ERASURE, [athleteHash, category]), record);
    ctx.stub.setEvent('IPFSAccessTokenDestroyed', Buffer.from(JSON.stringify(record)));
    return JSON.stringify(record);
  }

  // ------------------------------------------------------------------ queries

  @Transaction(false)
  @Returns('string')
  public async getConsent(
    ctx: Context,
    athleteHash: string,
    grantedToMSP: string,
    purpose: string,
  ): Promise<string> {
    const record = await this.get(ctx, this.consentKey(ctx, athleteHash, grantedToMSP, purpose));
    if (!record) throw new Error(`no consent record for ${grantedToMSP} / ${purpose}`);
    return JSON.stringify(record);
  }

  /** Every consent record an athlete holds — the sovereignty dashboard view. */
  @Transaction(false)
  @Returns('string')
  public async listConsents(ctx: Context, athleteHash: string): Promise<string> {
    // fabric-shim iterators expose next()/close(), not Symbol.asyncIterator.
    const it = await ctx.stub.getStateByPartialCompositeKey(KEY.CONSENT, [athleteHash]);
    const out: unknown[] = [];
    try {
      let res = await it.next();
      while (!res.done) {
        const s = res.value?.value?.toString();
        if (s) out.push(JSON.parse(s));
        res = await it.next();
      }
    } finally {
      await it.close();
    }
    return JSON.stringify(out);
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
