'use strict';
/** WADA Article 2.1 - laboratory commits an analysis result against a hash-verified list. */
const { BaseWorkload, LIST_VERSION, LIST_HASH } = require('./base');

class RecordAnalysisResult extends BaseWorkload {
  async initializeWorkloadModule(...args) {
    await super.initializeWorkloadModule(...args);
    await this.registerList();
    await this.provision({ withChain: true });
  }

  async submitTransaction() {
    await this.sutAdapter.sendRequests(
      this.req(
        'custody',
        'recordSampleAnalysisResult',
        [this.next(), 'true', 'EPO', LIST_VERSION, LIST_HASH, 'VERIFIED'],
        'LabMSP',
        false,
        ['LabMSP'],
      ),
    );
  }
}
module.exports.createWorkloadModule = () => new RecordAnalysisResult();
