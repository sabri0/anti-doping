/**
 * Verification of the FHIR R4 adapter.
 *
 * Two things are checked: that the emitted resources satisfy the R4 structural
 * requirements for Patient, Observation, DiagnosticReport and Bundle, and that
 * the export never widens the data leaving the framework — no direct identifier
 * may appear, however the mapping is driven.
 */

import { expect } from 'chai';
import fc from 'fast-check';
import {
  AnalysisRecord,
  toBundle,
  toDiagnosticReport,
  toObservation,
  toPatient,
  validate,
  validateBundle,
} from '../src/index';

const ATHLETE = { athleteHash: 'a'.repeat(64), discipline: 'road cycling' };

const ANALYSIS: AnalysisRecord = {
  sampleCode: 'SMP-2026-000123',
  athleteHash: ATHLETE.athleteHash,
  laboratoryMSP: 'LabMSP',
  adverse: true,
  substance: 'Erythropoietin',
  prohibitedListVersion: '2026-01',
  recordedAt: '2026-02-14T08:12:00.000Z',
  observations: [
    { marker: 'HGB', value: 15.2, unit: 'g/dL', effectiveDateTime: '2026-02-14T08:12:00.000Z', abnormal: true },
    { marker: 'RET%', value: 1.06, unit: '%', effectiveDateTime: '2026-02-14T08:12:00.000Z', abnormal: false },
    { marker: 'OFF-score', value: 92.4, effectiveDateTime: '2026-02-14T08:12:00.000Z' },
  ],
};

describe('Patient mapping', () => {
  it('is structurally valid', () => {
    expect(validate(toPatient(ATHLETE))).to.deep.equal([]);
  });

  it('carries the pseudonymous identifier and no direct identifier', () => {
    const p = toPatient(ATHLETE) as Record<string, any>;
    expect(p.identifier[0].value).to.equal(ATHLETE.athleteHash);
    for (const forbidden of ['name', 'birthDate', 'telecom', 'address', 'photo']) {
      expect(p[forbidden], forbidden).to.equal(undefined);
    }
    expect(JSON.stringify(p)).to.not.contain('road cycling');
  });

  it('is marked restricted confidentiality', () => {
    const p = toPatient(ATHLETE) as Record<string, any>;
    expect(p.meta.security[0].code).to.equal('R');
  });
});

describe('Observation mapping', () => {
  it('maps known markers to LOINC', () => {
    const o = toObservation(ANALYSIS, ANALYSIS.observations[0]) as Record<string, any>;
    expect(o.code.coding[0].system).to.equal('http://loinc.org');
    expect(o.code.coding[0].code).to.equal('718-7');
    expect(validate(o)).to.deep.equal([]);
  });

  it('falls back to a WADA-scoped code for markers with no LOINC equivalent', () => {
    const o = toObservation(ANALYSIS, ANALYSIS.observations[2]) as Record<string, any>;
    expect(o.code.coding[0].system).to.contain('wada-ama.org');
    expect(o.code.coding[0].code).to.equal('OFF-score');
    expect(validate(o)).to.deep.equal([]);
  });

  it('references the Patient rather than embedding athlete data', () => {
    const o = toObservation(ANALYSIS, ANALYSIS.observations[0]) as Record<string, any>;
    expect(o.subject.reference).to.match(/^Patient\//);
  });

  it('records interpretation when a reference range was applied', () => {
    const o = toObservation(ANALYSIS, ANALYSIS.observations[0]) as Record<string, any>;
    expect(o.interpretation[0].coding[0].code).to.equal('A');
  });

  it('is rejected when no value and no dataAbsentReason is present (obs-7)', () => {
    const o = toObservation(ANALYSIS, ANALYSIS.observations[0]) as Record<string, any>;
    delete o.valueQuantity;
    expect(validate(o).map((i) => i.path)).to.include('Observation.value[x]');
  });
});

describe('DiagnosticReport mapping', () => {
  it('is structurally valid and references every Observation', () => {
    const r = toDiagnosticReport(ANALYSIS) as Record<string, any>;
    expect(validate(r)).to.deep.equal([]);
    expect(r.result).to.have.lengthOf(3);
  });

  it('states the finding and the Prohibited List revision in the conclusion', () => {
    const r = toDiagnosticReport(ANALYSIS) as Record<string, any>;
    expect(r.conclusion).to.contain('Adverse analytical finding');
    expect(r.conclusion).to.contain('2026-01');
    expect(r.conclusionCode[0].coding[0].code).to.equal('AAF');
  });

  it('reports a negative analysis as negative', () => {
    const r = toDiagnosticReport({ ...ANALYSIS, adverse: false }) as Record<string, any>;
    expect(r.conclusionCode[0].coding[0].code).to.equal('NEGATIVE');
  });
});

describe('Bundle export', () => {
  it('validates end to end with no dangling references', () => {
    expect(validateBundle(toBundle(ANALYSIS, ATHLETE))).to.deep.equal([]);
  });

  it('contains one Patient, one DiagnosticReport and one Observation per marker', () => {
    const b = toBundle(ANALYSIS, ATHLETE) as Record<string, any>;
    const types = b.entry.map((e: any) => e.resource.resourceType);
    expect(types.filter((t: string) => t === 'Patient')).to.have.lengthOf(1);
    expect(types.filter((t: string) => t === 'DiagnosticReport')).to.have.lengthOf(1);
    expect(types.filter((t: string) => t === 'Observation')).to.have.lengthOf(3);
  });

  it('detects a dangling reference if the Patient is removed', () => {
    const b = toBundle(ANALYSIS, ATHLETE) as Record<string, any>;
    b.entry = b.entry.filter((e: any) => e.resource.resourceType !== 'Patient');
    expect(validateBundle(b).some((i) => i.message.includes('dangling'))).to.equal(true);
  });
});

describe('Pseudonymity invariant (property-based)', () => {
  it('no export ever contains a direct identifier, whatever the input', () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 64, maxLength: 64 }),
        fc.array(
          fc.record({
            marker: fc.constantFrom('HGB', 'RET%', 'RBC', 'HCT', 'TE_RATIO', 'OFF-score'),
            value: fc.double({ min: 0, max: 100, noNaN: true }),
            effectiveDateTime: fc.constant('2026-02-14T08:12:00.000Z'),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.boolean(),
        (hash, observations, adverse) => {
          const bundle = toBundle(
            { ...ANALYSIS, athleteHash: hash, adverse, observations },
            { athleteHash: hash, discipline: 'SECRET-DISCIPLINE' },
          );
          const text = JSON.stringify(bundle);
          return (
            validateBundle(bundle).length === 0 &&
            !text.includes('SECRET-DISCIPLINE') &&
            !text.includes('"name"') &&
            !text.includes('birthDate')
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});
