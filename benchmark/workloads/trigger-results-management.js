'use strict';
/**
 * WADA Article 7.1 - the automation the manuscript title claims.
 *
 * The heaviest transaction in the framework: it range-queries the custody
 * chain, the exception log and the whereabouts history, evaluates the Table 2
 * decision engine, writes the outcome, and installs a cross-organizational
 * state-based endorsement policy on the results key.
 */
const { BaseWorkload } = require('./base');

class TriggerResultsManagement extends BaseWorkload {
  async initializeWorkloadModule(...args) {
    await super.initializeWorkloadModule(...args);
    await this.registerList();
    await this.provision({ withChain: true, withAnalysis: true });
  }

  async submitTransaction() {
    await this.sutAdapter.sendRequests(
      this.req('custody', 'triggerResultsManagement', [this.next()], 'NADOMSP'),
    );
  }
}
module.exports.createWorkloadModule = () => new TriggerResultsManagement();
