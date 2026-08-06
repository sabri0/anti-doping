'use strict';
/** WADA Article 5.3 - open a chain of custody. One ledger write per transaction. */
const { BaseWorkload } = require('./base');

class InitiateSampleCustody extends BaseWorkload {
  async submitTransaction() {
    this.cursor += 1;
    await this.sutAdapter.sendRequests(
      this.req(
        'custody',
        'initiateSampleCustody',
        [this.code(this.cursor), this.athleteHash, `seal-${this.cursor}`, 'Tunis National Testing Centre'],
        'NADOMSP',
        false,
        ['NADOMSP'],
      ),
    );
  }
}
module.exports.createWorkloadModule = () => new InitiateSampleCustody();
