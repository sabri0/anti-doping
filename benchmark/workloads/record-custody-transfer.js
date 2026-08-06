'use strict';
/** WADA Article 5.4 - dual-endorsed custody transfer over a provisioned sample pool. */
const { BaseWorkload } = require('./base');

class RecordCustodyTransfer extends BaseWorkload {
  async initializeWorkloadModule(...args) {
    await super.initializeWorkloadModule(...args);
    await this.provision();
  }

  async submitTransaction() {
    await this.sutAdapter.sendRequests(
      this.req(
        'custody',
        'recordCustodyTransfer',
        [this.next(), 'TRANSPORT_HANDOFF', 'NADOMSP', 'LabMSP', 'true', '48'],
        'NADOMSP',
      ),
    );
  }
}
module.exports.createWorkloadModule = () => new RecordCustodyTransfer();
