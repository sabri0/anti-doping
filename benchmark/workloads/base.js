'use strict';

/**
 * Shared base for the Caliper workload modules.
 *
 * Two design points matter for the validity of the measurements:
 *
 *  1. Disjoint key namespaces. Each worker writes only to keys carrying its own
 *     worker and round index. Without this, concurrent workers collide on the
 *     same ledger key and the benchmark measures MVCC read-conflict rate rather
 *     than network capacity.
 *
 *  2. Setup outside the measured round. Transactions that need pre-existing
 *     state (a transfer needs a sample; results management needs a complete
 *     custody chain) provision a pool of keys during initialisation, which
 *     Caliper does not time. The measured round then performs exactly one
 *     ledger transaction per recorded transaction.
 */

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

const LIST_VERSION = '2026-01';
const LIST_HASH = 'f'.repeat(64);

const IDENTITY = {
  NADOMSP: 'nado-admin',
  LabMSP: 'lab-admin',
  AthleteMSP: 'athlete-admin',
  ResearchMSP: 'research-admin',
  FederationMSP: 'federation-admin',
};

class BaseWorkload extends WorkloadModuleBase {
  constructor() {
    super();
    this.cursor = 0;
  }

  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    // A per-run salt keeps sample codes unique across repeated benchmark runs;
    // without it a second run collides with the first run's keys and every
    // transaction fails with "sample already exists".
    this.tag = `w${workerIndex}r${roundIndex}t${Date.now().toString(36)}`;
    this.athleteHash = `${'a'.repeat(56)}${String(workerIndex).padStart(8, '0')}`;
    // roundArguments is undefined for rounds that declare no `arguments` block.
    this.poolSize = Number((roundArguments || {}).poolSize || 0);
  }

  code(i) {
    return `SMP-${this.tag}-${i}`;
  }

  /** Build a request. `contract` is 'custody' or 'consent'. */
  req(contract, fn, args, msp, readOnly = false, targets = ['NADOMSP', 'LabMSP']) {
    return {
      contractId: contract,
      contractFunction: fn,
      contractArguments: args,
      invokerMspId: msp,
      invokerIdentity: IDENTITY[msp],
      readOnly,
      targetOrganizations: targets,
    };
  }

  async registerList() {
    await this.sutAdapter.sendRequests(
      this.req('custody', 'registerProhibitedList', [LIST_VERSION, LIST_HASH], 'NADOMSP', false, ['NADOMSP']),
    );
  }

  /**
   * Provision `poolSize` samples, optionally with a complete custody chain.
   *
   * Provisioning runs in phases (all initiations, then all transport handoffs,
   * then all laboratory receipts, then all analyses) and each phase is sent in
   * concurrent batches. Two reasons:
   *
   *  - Awaiting each transaction individually costs a full commit round trip per
   *    sample, which made provisioning dominate the wall-clock time of a round.
   *  - Phasing guarantees that no two in-flight transactions touch the same
   *    sample record. Every custody write also updates the sample's sequence
   *    counter, so overlapping writes to one sample produce MVCC read conflicts
   *    and the benchmark would measure conflict rate instead of capacity.
   */
  async provision({ withChain = false, withAnalysis = false } = {}) {
    const BATCH = 20;

    const phase = async (build) => {
      for (let start = 0; start < this.poolSize; start += BATCH) {
        const end = Math.min(start + BATCH, this.poolSize);
        const requests = [];
        for (let i = start; i < end; i += 1) requests.push(build(this.code(i), i));
        await this.sutAdapter.sendRequests(requests);
      }
    };

    await phase((c, i) =>
      this.req('custody', 'initiateSampleCustody', [c, this.athleteHash, `seal-${i}`, 'Tunis'], 'NADOMSP', false, ['NADOMSP']),
    );

    if (withChain) {
      await phase((c) =>
        this.req('custody', 'recordCustodyTransfer', [c, 'TRANSPORT_HANDOFF', 'NADOMSP', 'LabMSP', 'true', '48'], 'NADOMSP'),
      );
      await phase((c) =>
        this.req('custody', 'recordCustodyTransfer', [c, 'LABORATORY_RECEIPT', 'NADOMSP', 'LabMSP', 'true', '48'], 'LabMSP'),
      );
    }

    if (withAnalysis) {
      await phase((c) =>
        this.req('custody', 'recordSampleAnalysisResult', [c, 'true', 'EPO', LIST_VERSION, LIST_HASH, 'VERIFIED'], 'LabMSP', false, ['LabMSP']),
      );
    }
  }

  /**
   * Next key from the provisioned pool. The pool is sized to the round's
   * per-worker transaction count, so this never wraps in a correctly configured
   * round; wrapping would mean two transactions writing the same sample and
   * would measure MVCC conflict rate rather than throughput.
   */
  next() {
    const c = this.code(this.cursor % Math.max(this.poolSize, 1));
    this.cursor += 1;
    return c;
  }
}

module.exports = { BaseWorkload, LIST_VERSION, LIST_HASH, IDENTITY };
