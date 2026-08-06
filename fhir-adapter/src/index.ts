/**
 * FHIR R4 adapter.
 *
 * §3.6 of the manuscript observes that sports medicine has no interoperability
 * standard comparable to HL7 FHIR, and proposes mapping the framework's
 * records onto FHIR resources. This module performs that mapping:
 *
 *   athlete (pseudonymized)      -> Patient
 *   individual biological marker -> Observation
 *   laboratory analysis result   -> DiagnosticReport
 *
 * Pseudonymity is preserved throughout: the Patient resource carries the
 * athlete hash as an identifier and never a name, birth date or any other
 * direct identifier. A FHIR export of this framework therefore cannot
 * re-identify an athlete on its own.
 */

export type FhirResource = Record<string, unknown>;

/** WADA / ABP markers mapped to LOINC where a LOINC code exists. */
const LOINC: Record<string, { code: string; display: string; unit: string }> = {
  HGB: { code: '718-7', display: 'Hemoglobin [Mass/volume] in Blood', unit: 'g/dL' },
  'RET%': {
    code: '17849-1',
    display: 'Reticulocytes/100 erythrocytes in Blood',
    unit: '%',
  },
  RBC: { code: '789-8', display: 'Erythrocytes [#/volume] in Blood', unit: '10*6/uL' },
  HCT: { code: '4544-3', display: 'Hematocrit [Volume Fraction] of Blood', unit: '%' },
  TE_RATIO: {
    code: '58448-2',
    display: 'Testosterone/Epitestosterone ratio in Urine',
    unit: '{ratio}',
  },
};

const ABP_SYSTEM = 'https://www.wada-ama.org/en/athlete-biological-passport';

export interface AthleteRecord {
  athleteHash: string;
  /** Sport discipline; not identifying on its own. */
  discipline?: string;
}

export interface MarkerObservation {
  marker: string;
  value: number;
  unit?: string;
  effectiveDateTime: string;
  /** Whether the value falls outside the athlete's longitudinal reference range. */
  abnormal?: boolean;
}

export interface AnalysisRecord {
  sampleCode: string;
  athleteHash: string;
  laboratoryMSP: string;
  adverse: boolean;
  substance?: string;
  prohibitedListVersion: string;
  recordedAt: string;
  observations: MarkerObservation[];
}

/** Stable, pseudonymous resource ids derived from the athlete hash. */
const patientId = (athleteHash: string): string => `athlete-${athleteHash.slice(0, 16)}`;
const observationId = (sampleCode: string, marker: string): string =>
  `obs-${sampleCode}-${marker.replace(/[^A-Za-z0-9]/g, '')}`.toLowerCase();

/**
 * Map a pseudonymized athlete to a FHIR Patient.
 *
 * The resource deliberately carries no `name`, `birthDate`, `telecom` or
 * `address` element. Under GDPR Article 25 the export must not widen the data
 * that leaves the framework.
 */
export function toPatient(athlete: AthleteRecord): FhirResource {
  return {
    resourceType: 'Patient',
    id: patientId(athlete.athleteHash),
    meta: {
      profile: ['http://hl7.org/fhir/StructureDefinition/Patient'],
      security: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality',
          code: 'R',
          display: 'Restricted',
        },
      ],
    },
    identifier: [
      {
        use: 'secondary',
        type: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
              code: 'ANON',
              display: 'Anonymous identifier',
            },
          ],
        },
        system: ABP_SYSTEM,
        value: athlete.athleteHash,
      },
    ],
    active: true,
  };
}

/** Map a single biological marker reading to a FHIR Observation. */
export function toObservation(
  analysis: Pick<AnalysisRecord, 'sampleCode' | 'athleteHash'>,
  observation: MarkerObservation,
): FhirResource {
  const loinc = LOINC[observation.marker];

  const coding = loinc
    ? [{ system: 'http://loinc.org', code: loinc.code, display: loinc.display }]
    : [{ system: ABP_SYSTEM, code: observation.marker, display: observation.marker }];

  const resource: FhirResource = {
    resourceType: 'Observation',
    id: observationId(analysis.sampleCode, observation.marker),
    status: 'final',
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'laboratory',
            display: 'Laboratory',
          },
        ],
      },
    ],
    code: { coding, text: observation.marker },
    subject: { reference: `Patient/${patientId(analysis.athleteHash)}` },
    effectiveDateTime: observation.effectiveDateTime,
    valueQuantity: {
      value: observation.value,
      unit: observation.unit ?? loinc?.unit ?? '1',
      system: 'http://unitsofmeasure.org',
      code: observation.unit ?? loinc?.unit ?? '1',
    },
    specimen: { identifier: { system: ABP_SYSTEM, value: analysis.sampleCode } },
  };

  if (observation.abnormal !== undefined) {
    resource.interpretation = [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
            code: observation.abnormal ? 'A' : 'N',
            display: observation.abnormal ? 'Abnormal' : 'Normal',
          },
        ],
      },
    ];
  }
  return resource;
}

/** Map a laboratory analysis to a FHIR DiagnosticReport referencing its Observations. */
export function toDiagnosticReport(analysis: AnalysisRecord): FhirResource {
  return {
    resourceType: 'DiagnosticReport',
    id: `report-${analysis.sampleCode}`.toLowerCase(),
    status: 'final',
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
            code: 'LAB',
            display: 'Laboratory',
          },
        ],
      },
    ],
    code: {
      coding: [
        { system: 'http://loinc.org', code: '50190-8', display: 'Drug screen panel' },
      ],
      text: `Anti-doping analysis for sample ${analysis.sampleCode}`,
    },
    subject: { reference: `Patient/${patientId(analysis.athleteHash)}` },
    effectiveDateTime: analysis.recordedAt,
    issued: analysis.recordedAt,
    performer: [{ display: analysis.laboratoryMSP }],
    specimen: [{ identifier: { system: ABP_SYSTEM, value: analysis.sampleCode } }],
    result: analysis.observations.map((o) => ({
      reference: `Observation/${observationId(analysis.sampleCode, o.marker)}`,
    })),
    conclusion: analysis.adverse
      ? `Adverse analytical finding${analysis.substance ? `: ${analysis.substance}` : ''} ` +
        `(Prohibited List ${analysis.prohibitedListVersion})`
      : `Negative (Prohibited List ${analysis.prohibitedListVersion})`,
    conclusionCode: [
      {
        coding: [
          {
            system: ABP_SYSTEM,
            code: analysis.adverse ? 'AAF' : 'NEGATIVE',
            display: analysis.adverse ? 'Adverse Analytical Finding' : 'Negative',
          },
        ],
      },
    ],
  };
}

/** Package a complete analysis as a FHIR transaction Bundle. */
export function toBundle(analysis: AnalysisRecord, athlete: AthleteRecord): FhirResource {
  const resources: FhirResource[] = [
    toPatient(athlete),
    ...analysis.observations.map((o) => toObservation(analysis, o)),
    toDiagnosticReport(analysis),
  ];

  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: analysis.recordedAt,
    total: resources.length,
    entry: resources.map((r) => ({
      fullUrl: `urn:uuid:${r.resourceType as string}/${r.id as string}`,
      resource: r,
    })),
  };
}

/** Direct identifiers that must never appear in an export. */
const FORBIDDEN_ELEMENTS = ['name', 'birthDate', 'telecom', 'address', 'photo'];

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Structural validation against the R4 requirements for the resources this
 * adapter emits, plus the framework's own pseudonymity rule.
 *
 * This checks required elements, fixed value sets and reference integrity for
 * Patient, Observation, DiagnosticReport and Bundle. It is not a full FHIR
 * profile validator, and the Evaluation section says so; `npm run validate:spec`
 * additionally checks every emitted resource against the official R4 JSON
 * schema when that schema has been fetched.
 */
export function validate(resource: FhirResource): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const type = resource.resourceType as string | undefined;
  const req = (field: string) => {
    if (resource[field] === undefined || resource[field] === null) {
      issues.push({ path: `${type}.${field}`, message: `required element is missing` });
    }
  };

  if (!type) {
    return [{ path: '(root)', message: 'resourceType is required' }];
  }

  switch (type) {
    case 'Patient':
      req('id');
      for (const forbidden of FORBIDDEN_ELEMENTS) {
        if (resource[forbidden] !== undefined) {
          issues.push({
            path: `Patient.${forbidden}`,
            message: 'direct identifier must not appear in a pseudonymized export',
          });
        }
      }
      break;

    case 'Observation':
      req('status');
      req('code');
      req('subject');
      if (
        typeof resource.status === 'string' &&
        !['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'].includes(
          resource.status,
        )
      ) {
        issues.push({ path: 'Observation.status', message: `invalid status "${resource.status}"` });
      }
      // obs-7: a value must be present unless dataAbsentReason is.
      if (resource.valueQuantity === undefined && resource.dataAbsentReason === undefined) {
        issues.push({
          path: 'Observation.value[x]',
          message: 'obs-7: a value or a dataAbsentReason is required',
        });
      }
      break;

    case 'DiagnosticReport':
      req('status');
      req('code');
      req('subject');
      if (Array.isArray(resource.result)) {
        for (const [i, r] of (resource.result as { reference?: string }[]).entries()) {
          if (!r.reference?.startsWith('Observation/')) {
            issues.push({
              path: `DiagnosticReport.result[${i}]`,
              message: 'result must reference an Observation',
            });
          }
        }
      }
      break;

    case 'Bundle':
      req('type');
      if (!Array.isArray(resource.entry)) {
        issues.push({ path: 'Bundle.entry', message: 'entry must be an array' });
      }
      break;

    default:
      issues.push({ path: type, message: `unsupported resource type for this adapter` });
  }
  return issues;
}

/** Validate a whole bundle, including cross-resource reference integrity. */
export function validateBundle(bundle: FhirResource): ValidationIssue[] {
  const issues = validate(bundle);
  const entries = (bundle.entry as { resource: FhirResource }[] | undefined) ?? [];
  const ids = new Set(
    entries.map((e) => `${e.resource.resourceType as string}/${e.resource.id as string}`),
  );

  for (const entry of entries) {
    issues.push(...validate(entry.resource));

    const subject = entry.resource.subject as { reference?: string } | undefined;
    if (subject?.reference && !ids.has(subject.reference)) {
      issues.push({
        path: `${entry.resource.resourceType as string}.subject`,
        message: `dangling reference ${subject.reference}`,
      });
    }
    for (const [i, r] of ((entry.resource.result as { reference: string }[]) ?? []).entries()) {
      if (!ids.has(r.reference)) {
        issues.push({
          path: `DiagnosticReport.result[${i}]`,
          message: `dangling reference ${r.reference}`,
        });
      }
    }
  }
  return issues;
}
