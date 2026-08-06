'use strict';
/** GDPR Article 7 - the ABAC gate over all six data categories, writing an audit record for every decision. */
const { BaseWorkload } = require('./base');

const ALL_CATEGORIES =
  'gps_accelerometry,biochemical_markers,abp_haematological,abp_steroidal,psychological,genetic';

class ValidateConsent extends BaseWorkload {
  async initializeWorkloadModule(...args) {
    await super.initializeWorkloadModule(...args);
    await this.sutAdapter.sendRequests(
      this.req(
        'consent',
        'recordConsentTransaction',
        [
          this.athleteHash,
          'ResearchMSP',
          'cardiovascular_research',
          ALL_CATEGORIES,
          '2026-01-01T00:00:00.000Z',
          '2027-01-01T00:00:00.000Z',
          'true',
        ],
        'AthleteMSP',
        false,
        ['AthleteMSP'],
      ),
    );
  }

  async submitTransaction() {
    await this.sutAdapter.sendRequests(
      this.req(
        'consent',
        'validateConsent',
        [this.athleteHash, 'cardiovascular_research', ALL_CATEGORIES],
        'ResearchMSP',
        false,
        ['ResearchMSP'],
      ),
    );
  }
}
module.exports.createWorkloadModule = () => new ValidateConsent();
