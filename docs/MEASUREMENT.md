# Measurement campaign

What was measured, in what order, and which of our own hypotheses did not survive.
Every raw output is in [`measurements/`](measurements/); every number in the
manuscript is derived from these files by the scripts named below, so nothing is
transcribed by hand.

All measurements were taken on one commodity host: 8 virtual processors, 11.6 GB
available to the container runtime, 34 running containers including the load
driver.

---

## 1. Three sequential passes — and a hypothesis

`scripts/run-benchmark.sh` × 3, results in `measurements/results-r1..r3.json`.

The suite was run three times in a row on one network, on the assumption that the
three passes were replicates. They were not. Custody-write throughput at a
configured 100 TPS came out at **54.3, 13.9, 15.5** — a factor of 3.9 — while read
paths and writes that do not accumulate sample records barely moved:

| round | r1 | r2 | r3 |
| --- | ---: | ---: | ---: |
| `sweep-100tps` | 54.3 | 13.9 | 15.5 |
| `endorse-1org` | 47.9 | 12.1 | 13.4 |
| `recordSampleAnalysisResult` | 25.5 | 25.4 | 23.9 |
| `evaluateDecisionTable` | 235.0 | 227.2 | 183.8 |

The obvious explanation was the size of the state database: r2 wrote into a ledger
r1 had already filled.

## 2. Testing it — the hypothesis fails

`benchmark/state-scaling.yaml` on a network brought up clean, twelve identical
rounds, results in `measurements/state-scaling.json`, analysed by
`scripts/analyse-controls.py`.

If accumulated state were the cause, throughput would fall monotonically across
the twelve rounds. It does not:

| | |
| --- | ---: |
| rounds | 12 (600 transactions each) |
| median | 26.2 TPS |
| range | 15.7 – 36.3 TPS (**2.31×**) |
| coefficient of variation | **31.9 %** |
| first three rounds | 34.1 TPS |
| last three rounds | 33.4 TPS |
| correlation with round index | **0.047** |

**Accumulated state explains nothing.** What the twelve rounds do establish is the
between-round variation of this deployment, and that is the more useful result: it
is the distribution that any single benchmark round is one draw from — including
the 17.7 TPS reported in the previous version of the manuscript.

Everything downstream is reported as a range across replicated rounds, and any
comparison between two configurations is made within pairs.

## 3. Replicates, and the operation table

`scripts/run-benchmark.sh` × 3 more (`measurements/results-r4..r6.json`),
aggregated by `scripts/aggregate-replicates.py` into `benchmark-summary.json`:
mean, standard deviation and range per round, with n stated.

29,322 transactions, 0 failed.

## 4. Paired endorsement

`benchmark/endorsement-paired.yaml`, analysed by `scripts/analyse-controls.py`.

The arms alternate so that the members of a pair are adjacent in time. A leading
warm-up round is discarded, and a pair is excluded when either arm's latency
exceeds five times the median — a rule that exists because the first execution of
this experiment produced a round at 0.3 TPS and a mean latency of nineteen
minutes, which was measuring the state databases absorbing the previous phase.

| | |
| --- | ---: |
| pairs | 4 |
| one organisation | 10.7 TPS |
| two organisations | 9.5 TPS |
| paired reduction | **11.1 %** (range 1.8 – 17.8) |
| same sign in every pair | yes |
| drift of the one-org arm across the experiment | −2.8 % |

The previously reported 7 % was the difference between two rounds measured at
different moments, on a host whose between-round variation is larger than the
effect.

## 5. Driver-saturation control

`benchmark/driver-control.yaml` — the two highest sweep points repeated with six
workers instead of two, plus a point at a configured 200 TPS.

| configured | offered | committed |
| ---: | ---: | ---: |
| 50 | 25.1 | 9.8 |
| 100 | 43.0 | 10.9 |
| 200 | 38.1 | 10.3 |

Six workers offered **less** than two and committed less. The driver competes for
the same processors as the network it measures — resource sampling puts its own
consumption at 11 % of the deployment's load — so on a single host it cannot be
separated from the system under test.

**Every throughput figure in this repository and in the manuscript is therefore a
lower bound on network capacity, not a saturation point.** Establishing a ceiling
requires a driver on separate hardware.

## 6. Resource attribution

`scripts/sample-resources.py --interval 3`, n = 38 samples across a 3,000-transaction
saturating write round.

| component | CPU (% of one core) | share of load | sd |
| --- | ---: | ---: | ---: |
| CouchDB (10 instances) | 335.2 | **59.4 %** | 97.6 |
| peers (10) | 130.8 | 23.2 % | 24.4 |
| load driver | 59.6 | 10.6 % | 51.4 |
| certification authorities | 14.5 | 2.6 % | 10.0 |
| IPFS (3) | 8.2 | 1.5 % | 7.2 |
| orderer | 6.8 | **1.2 %** | 7.0 |

State persistence dominates; consensus is negligible. CouchDB is required by the
six-category access-control model, so the cost of granular data sovereignty is
real and is paid in storage. This is an attribution, not a controlled
substitution — no embedded-state-database counterfactual was run.

Two earlier attempts at this measurement produced n = 1 and were discarded. The
first sampled a round too short for a `docker stats` sweep over 35 containers; the
second never ran the round at all, because `bash` in the sampler's subprocess
resolved to WSL's launcher in System32 rather than to Git Bash. The script now
fails loudly rather than reporting an idle host as a saturating one.

## 7. Centralised control arm

`benchmark/baseline/centralised-baseline.js` — the same custody-initiation write
(sample record and step-0 custody event, atomic, flushed to disk) against a single
unreplicated CouchDB with no endorsement, ordering, validation or second copy.

| | |
| --- | ---: |
| throughput | 156.5 TPS (144.1 – 172.6) |
| mean latency | 0.15 s |
| ratio to the equivalent ledger write | **≥ 7.7×** |

The control was itself bounded by its own client concurrency — throughput equalled
its achieved send rate throughout — so the ratio understates the difference. The
first version of this arm ran two workers and reported 44 TPS at a 45 ms round
trip, which is two requests in flight rather than a property of the database.

## Reproducing

```bash
./scripts/network-up.sh && ./scripts/deploy-chaincode.sh
./scripts/run-benchmark.sh                       # one pass; repeat for replicates
python scripts/aggregate-replicates.py docs/measurements/results-r4.json \
       docs/measurements/results-r5.json docs/measurements/results-r6.json \
       -o docs/benchmark-summary.json
CONFIG=benchmark/state-scaling.yaml LOG=benchmark/state-scaling.log \
       ./scripts/run-benchmark.sh                # against a CLEAN network
CONFIG=benchmark/endorsement-paired.yaml LOG=benchmark/endorsement-paired.log \
       ./scripts/run-benchmark.sh
./scripts/run-controls.sh
python scripts/analyse-controls.py
python scripts/gen-figure-performance.py
```
