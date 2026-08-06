'use strict';
/** Read-only custody-chain range query - the provenance view. */
const { BaseWorkload } = require('./base');

class GetCustodyChain extends BaseWorkload {
  async initializeWorkloadModule(...args) {
    await super.initializeWorkloadModule(...args);
    await this.provision({ withChain: true });
  }

  async submitTransaction() {
    await this.sutAdapter.sendRequests(
      this.req('custody', 'getCustodyChain', [this.next()], 'NADOMSP', true, ['NADOMSP']),
    );
  }
}
module.exports.createWorkloadModule = () => new GetCustodyChain();
