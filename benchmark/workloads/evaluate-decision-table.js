'use strict';
/**
 * The Table 2 decision engine in isolation - read-only, no ledger access.
 * Separates the cost of the regulatory logic from state I/O and consensus.
 */
const { BaseWorkload } = require('./base');

class EvaluateDecisionTable extends BaseWorkload {
  async submitTransaction() {
    this.cursor += 1;
    const i = this.cursor;
    const facts = {
      sampleAnalysisPositive: i % 2 === 0,
      laboratoryAccreditation: ['VERIFIED', 'PENDING', 'UNVERIFIED'][i % 3],
      longitudinalProfileAnomaly: i % 5 === 0,
      expertPanelReviewRequired: i % 7 === 0,
      thirdWhereaboutsFailure: i % 11 === 0,
      allFailuresLedgerVerified: i % 13 === 0,
      mandatoryCustodyStepVerified: i % 17 !== 0,
    };
    await this.sutAdapter.sendRequests(
      this.req('custody', 'evaluateDecisionTable', [JSON.stringify(facts)], 'NADOMSP', true, ['NADOMSP']),
    );
  }
}
module.exports.createWorkloadModule = () => new EvaluateDecisionTable();
