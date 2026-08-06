/**
 * Attribute-based access control over the six biological data categories.
 *
 * §3.5 of the manuscript specifies granular athlete control across six
 * categories and a worked scenario: a researcher authorized for a
 * cardiovascular study receives haematological and accelerometry data only,
 * while steroidal, psychological and genetic categories are refused
 * automatically. That scenario is an executing acceptance test here.
 *
 * Two principles govern every decision (GDPR Article 25):
 *   - deny by default: absent an affirmative, in-date, purpose-matched consent
 *     record, access is refused;
 *   - data minimisation: a request is narrowed to the intersection of what the
 *     athlete consented to and what the declared purpose actually needs. Asking
 *     for more than the purpose requires does not widen the release.
 */

/** The six categories of §3.5. */
export const DATA_CATEGORIES = [
  'gps_accelerometry',
  'biochemical_markers',
  'abp_haematological',
  'abp_steroidal',
  'psychological',
  'genetic',
] as const;

export type DataCategory = (typeof DATA_CATEGORIES)[number];

/**
 * Categories that are special-category personal data under GDPR Article 9 and
 * therefore need an explicit Article 9 authorization on top of consent.
 * Every biological category here concerns health; genetic data is called out
 * separately by Article 9(1) and carries the strictest handling.
 */
export const SPECIAL_CATEGORY: DataCategory[] = [
  'biochemical_markers',
  'abp_haematological',
  'abp_steroidal',
  'psychological',
  'genetic',
];

/**
 * Purpose limitation: the maximum category set any declared purpose may ever
 * justify. This is the data-minimisation ceiling, applied before consent is
 * even considered.
 */
export const PURPOSE_LIMITS: Record<string, DataCategory[]> = {
  cardiovascular_research: ['abp_haematological', 'gps_accelerometry'],
  anti_doping_results_management: [
    'abp_haematological',
    'abp_steroidal',
    'biochemical_markers',
  ],
  injury_prevention: ['gps_accelerometry', 'biochemical_markers'],
  workload_monitoring: ['gps_accelerometry'],
  clinical_care: [
    'biochemical_markers',
    'abp_haematological',
    'abp_steroidal',
    'psychological',
    'genetic',
  ],
  genetic_research: ['genetic'],
};

export type Decision = 'GRANTED' | 'DENIED';

export interface CategoryOutcome {
  category: DataCategory;
  decision: Decision;
  /** Machine-readable reason, so denials are auditable rather than opaque. */
  reason: string;
  gdprArticle: string;
}

export interface AccessRequest {
  athleteHash: string;
  requestingMSP: string;
  declaredPurpose: string;
  requestedCategories: DataCategory[];
  /** Evaluation instant, ISO-8601, taken from the transaction timestamp. */
  at: string;
}

export interface ConsentGrant {
  athleteHash: string;
  grantedToMSP: string;
  purpose: string;
  categories: DataCategory[];
  validFrom: string;
  validUntil: string;
  /** Article 9 explicit authorization for special-category processing. */
  specialCategoryAuthorised: boolean;
  revoked: boolean;
}

export interface AccessDecision {
  request: AccessRequest;
  outcomes: CategoryOutcome[];
  granted: DataCategory[];
  denied: DataCategory[];
  /** True when at least one category was released. */
  anyGranted: boolean;
}

export function isDataCategory(value: string): value is DataCategory {
  return (DATA_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Evaluate one access request against the athlete's consent record.
 *
 * Pure and total: the same request and grant always yield the same decision,
 * and every requested category receives an explicit outcome with a reason.
 */
export function evaluateAccess(
  request: AccessRequest,
  grant: ConsentGrant | null,
): AccessDecision {
  const purposeCeiling = PURPOSE_LIMITS[request.declaredPurpose];
  const now = Date.parse(request.at);

  const outcomes: CategoryOutcome[] = request.requestedCategories.map((category) => {
    // 1. Deny by default — no consent record at all.
    if (!grant) {
      return {
        category,
        decision: 'DENIED',
        reason: 'no consent record exists for this athlete and organization (deny by default)',
        gdprArticle: 'Article 25',
      };
    }

    // 2. The purpose must be one the framework recognises.
    if (!purposeCeiling) {
      return {
        category,
        decision: 'DENIED',
        reason: `declared purpose "${request.declaredPurpose}" is not a recognised processing purpose`,
        gdprArticle: 'Article 5(1)(b)',
      };
    }

    // 3. Consent must have been granted for this purpose, to this organization.
    if (grant.purpose !== request.declaredPurpose) {
      return {
        category,
        decision: 'DENIED',
        reason: `consent was given for "${grant.purpose}", not "${request.declaredPurpose}"`,
        gdprArticle: 'Article 5(1)(b)',
      };
    }
    if (grant.grantedToMSP !== request.requestingMSP) {
      return {
        category,
        decision: 'DENIED',
        reason: `consent was given to ${grant.grantedToMSP}, not ${request.requestingMSP}`,
        gdprArticle: 'Article 7',
      };
    }

    // 4. Consent must be live.
    if (grant.revoked) {
      return {
        category,
        decision: 'DENIED',
        reason: 'consent has been withdrawn by the athlete',
        gdprArticle: 'Article 7(3)',
      };
    }
    if (now < Date.parse(grant.validFrom) || now > Date.parse(grant.validUntil)) {
      return {
        category,
        decision: 'DENIED',
        reason: `consent is outside its validity period (${grant.validFrom} to ${grant.validUntil})`,
        gdprArticle: 'Article 7',
      };
    }

    // 5. Data minimisation — the purpose ceiling, independent of consent.
    if (!purposeCeiling.includes(category)) {
      return {
        category,
        decision: 'DENIED',
        reason:
          `category is not necessary for the declared purpose ` +
          `"${request.declaredPurpose}" (data minimisation)`,
        gdprArticle: 'Article 5(1)(c) / Article 25',
      };
    }

    // 6. The athlete must have consented to this specific category.
    if (!grant.categories.includes(category)) {
      return {
        category,
        decision: 'DENIED',
        reason: 'the athlete did not consent to this data category',
        gdprArticle: 'Article 7',
      };
    }

    // 7. Special-category data needs an explicit Article 9 authorization.
    if (SPECIAL_CATEGORY.includes(category) && !grant.specialCategoryAuthorised) {
      return {
        category,
        decision: 'DENIED',
        reason: 'special-category biological data requires explicit Article 9 authorization',
        gdprArticle: 'Article 9',
      };
    }

    return {
      category,
      decision: 'GRANTED',
      reason: 'consented, in date, and necessary for the declared purpose',
      gdprArticle: 'Article 6(1)(a) / Article 9(2)(a)',
    };
  });

  const granted = outcomes.filter((o) => o.decision === 'GRANTED').map((o) => o.category);
  const denied = outcomes.filter((o) => o.decision === 'DENIED').map((o) => o.category);

  return { request, outcomes, granted, denied, anyGranted: granted.length > 0 };
}

/**
 * `applyDefaultPrivacySettings()` — GDPR Article 25(2).
 * The default for a new athlete is that nothing is shared with anyone.
 */
export function defaultPrivacySettings(athleteHash: string): ConsentGrant {
  return {
    athleteHash,
    grantedToMSP: '',
    purpose: '',
    categories: [],
    validFrom: '1970-01-01T00:00:00.000Z',
    validUntil: '1970-01-01T00:00:00.000Z',
    specialCategoryAuthorised: false,
    revoked: true,
  };
}

/**
 * `enforceDataMinimisation()` — narrow a requested category set to what the
 * declared purpose can justify, before any consent lookup.
 */
export function minimiseForPurpose(
  purpose: string,
  requested: DataCategory[],
): DataCategory[] {
  const ceiling = PURPOSE_LIMITS[purpose] ?? [];
  return requested.filter((c) => ceiling.includes(c));
}
