'use strict';
/** Read-only ABAC evaluation - the query path the athlete dashboard uses. */
const { BaseWorkload } = require('./base');

const ALL_CATEGORIES =
  'gps_accelerometry,biochemical_markers,abp_haematological,abp_steroidal,psychological,genetic';

class PreviewConsentDecision extends BaseWorkload {
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
        'previewConsentDecision',
        [this.athleteHash, 'cardiovascular_research', ALL_CATEGORIES],
        'ResearchMSP',
        true,
        ['ResearchMSP'],
      ),
    );
  }
}
module.exports.createWorkloadModule = () => new PreviewConsentDecision();
