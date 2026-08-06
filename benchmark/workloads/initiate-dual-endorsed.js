'use strict';
/**
 * Article 5.3 custody initiation, but endorsed by two organizational classes.
 *
 * Paired with initiate-sample-custody.js (single-organization endorsement) this
 * isolates the throughput and latency cost of the cross-organizational
 * endorsement requirement that §4.1 relies on to defeat insider collusion. The
 * transaction and its ledger writes are otherwise identical.
 */
const { BaseWorkload } = require('./base');

class InitiateDualEndorsed extends BaseWorkload {
  async submitTransaction() {
    this.cursor += 1;
    await this.sutAdapter.sendRequests(
      this.req(
        'custody',
        'initiateSampleCustody',
        [this.code(this.cursor), this.athleteHash, `seal-${this.cursor}`, 'Tunis National Testing Centre'],
        'NADOMSP',
        false,
        ['NADOMSP', 'LabMSP'],
      ),
    );
  }
}
module.exports.createWorkloadModule = () => new InitiateDualEndorsed();
