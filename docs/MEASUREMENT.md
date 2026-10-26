# Measurement protocol

## Configurations

| ID | Consensus | State database | Started |
| --- | --- | --- | --- |
| K1 | Raft, four nodes in four organisations | CouchDB 3.3.3 | clean |
| K2 | Raft, as K1 | LevelDB | clean |
| K3 | SmartBFT, same four nodes | LevelDB | clean |

Contracts, collections, endorsement policies and attestation protocols are
identical in all three. Baselines: a single-operator tamper-evident log
(`driver/telog/server.js`) and a single CouchDB instance.

    CONFIG=K1 CONSENSUS=raft STATE_DB=couchdb   ./scripts/evaluate-configuration.sh
    CONFIG=K2 CONSENSUS=raft STATE_DB=goleveldb ./scripts/evaluate-configuration.sh
    CONFIG=K3 CONSENSUS=bft  STATE_DB=goleveldb ./scripts/evaluate-configuration.sh
    ./scripts/run-baselines.sh
    ./scripts/host-info.sh
    python scripts/analyse-evaluation.py

## Isolation

Network containers are pinned to virtual processors 0–5 (`cpuset` in the
generated compose file) and the driver to 6–7. The partition is at the level
of the Docker Desktop virtual machine's scheduler; it does not give either
side exclusive physical cores (the host has four cores with two hardware
threads each).

## Driver

`driver/bench.js` with two worker processes (`driver/lib/worker.js`), each
holding Fabric Gateway connections to both peers of every organisation. Every
transaction is timed from proposal to commit status, with endorsement,
ordering and commit phases timed separately. Workers write disjoint keys.
State a transaction needs is provisioned before the round and not timed;
provisioning retries a transaction that fails with an MVCC or phantom-read
conflict (an endorsing peer one block behind), measured transactions never.

## Rounds

Every round: 15 s warm-up (excluded) then a 30 s window.

* **Closed loop** — a fixed number of transactions outstanding; capacity is
  committed throughput at a saturating concurrency. Custody initiation is
  swept at 4, 8, 16, 32, 64; other writes at 32, reads at 64.
* **Open loop** — fixed schedule at 2 transactions per second, below
  saturation in every configuration; latency percentiles are response times.

Open-loop rounds above saturation are not used for capacity: endorsement
continues at the offered rate while validation falls behind, and committed
throughput collapses (observed in development: 3.6 committed at 5 offered,
1.3 at 40 offered on K1).

## Replication and drift

`scripts/gen-evaluation-plan.py`: three blocks, each with every capacity,
sweep and latency round in seeded random order, opened and closed by an
identical sentinel round (custody initiation, concurrency 32). Endorsement
cost: one- versus two-organisation endorsement of custody initiation on the
`custodyor` definition (OR policy, same package), in ABBA, BAAB, ABBA blocks.

## Earlier protocol

The first build cycle's measurements (Hyperledger Caliper, driver co-resident
with the network, unpinned) are in commit `6f6601d`; the rounds analysed
here are kept in `docs/archive-cycle1/state-scaling.json`. Their
twelve "identical" rounds show serial dependence (lag-1 autocorrelation 0.54,
permutation p = 0.009; quadratic trend R² = 0.72;
`scripts/analyse-state-scaling.py`), so no result of that protocol is reported.
