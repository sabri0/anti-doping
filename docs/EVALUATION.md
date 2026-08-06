# Evaluation

> **This file reports a single pass of the suite.** A single benchmark round on
> this host is one draw from a distribution spanning a factor of 2.31 (see
> [MEASUREMENT.md](MEASUREMENT.md)). Treat the figures below as one observation,
> not as the network's capacity; the replicated summary is in
> `benchmark-summary.json` and the full account in `MEASUREMENT.md`.

Measured results for the deployed five-organization network. Every number
here is generated from `docs/benchmark-results.json` by
[scripts/gen-evaluation.py](../scripts/gen-evaluation.py); nothing is transcribed by hand.

Regenerate with:

```bash
./scripts/run-benchmark.sh
python scripts/parse-benchmark.py benchmark/caliper.log -o docs/benchmark-results.json
python scripts/gen-evaluation.py
```

## Measurement environment

| | |
| --- | --- |
| Platform | Hyperledger Fabric 2.5.13, Fabric CA 1.5.15 |
| Ordering | Raft, single orderer, batch timeout 2 s, max batch 500 |
| State database | CouchDB 3.3.3, one per peer (10 total) |
| Organizations | 5 classes, 2 peers each, 1 CA each |
| Off-chain | IPFS Kubo v0.29.0, 3 nodes, private cluster |
| Chaincode | TypeScript, chaincode-as-a-service |
| Driver | Hyperledger Caliper 0.6.0, 2 local workers, in-cluster |
| Host | 8 vCPU / 11.6 GB available to the container runtime |

**All 36 containers, including the load driver, share one host.** This is the
single most important qualification on every figure below: the measurements
characterise this deployment, not a provisioned production cluster.

Total transactions executed: **9774**, of which **0 failed**.
Every round completed with a 100 % success rate, so each throughput figure
reflects committed work rather than a rejection rate.

## 1. Saturation

The same write transaction (`initiateSampleCustody`, WADA Article 5.3) at rising
offered load. This replaces the projected throughput curve of the original Figure 6.

| Offered load (TPS) | Achieved send rate (TPS) | Throughput (TPS) | Mean latency (s) | Max latency (s) |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 10.0 | **8.7** | 5.9 | 8.5 |
| 25 | 24.1 | **9.7** | 23.5 | 28.6 |
| 50 | 25.0 | **11.0** | 27.2 | 33.1 |
| 60 | 31.0 | **10.4** | 37.1 | 47.4 |
| 100 | 28.9 | **10.8** | 33.5 | 45.4 |

Throughput saturates at approximately **11 TPS**. Past that point,
additional offered load becomes queueing delay rather than throughput — latency
rises steeply while throughput stays flat, which is the signature of a saturated
system rather than of a driver limit.

## 2. Cost of cross-organizational endorsement

The §4.1 mitigation against insider collusion requires critical state to be
endorsed by two distinct organizational classes. Here the *identical* transaction
is endorsed by one organization and then by two, so the difference is attributable
to endorsement alone.

| Endorsing organizations | Throughput (TPS) | Mean latency (s) |
| --- | ---: | ---: |
| 1 (NADO) | 9.7 | 28.8 |
| 2 (NADO + Laboratory) | 10.6 | 29.6 |

The framework's principal integrity control costs approximately **-9 %**
of write throughput. That is a cheap price for the property it buys, and it is worth
stating precisely because the manuscript previously could not price it at all.

## 3. Per-operation throughput

One round per smart contract function named in Tables 1 and 3, each endorsed by
exactly the organizations its policy requires.

| Function | Article | Endorsement | Throughput (TPS) | Mean latency (s) | Transactions |
| --- | --- | --- | ---: | ---: | ---: |
| `initiateSampleCustody` | 5.3 | one organization | 9.7 | 28.8 | 500 |
| `initiateSampleCustody` | 5.3 | two organizations | 10.6 | 29.6 | 500 |
| `recordCustodyTransfer` | 5.4 | two organizations | 10.9 | 24.9 | 400 |
| `recordSampleAnalysisResult` | 2.1 | one organization | 16.1 | 12.7 | 400 |
| `triggerResultsManagement` | 7.1 | two organizations | 5.4 | 42.9 | 300 |
| `validateConsent` | GDPR 7 | one organization | 33.2 | 6.0 | 400 |

Read-only operations require neither ordering nor commitment:

| Function | What it measures | Throughput (TPS) | Mean latency (s) | Transactions |
| --- | --- | ---: | ---: | ---: |
| `evaluateDecisionTable` | Table 2 logic in isolation | **183.0** | 0.04 | 2000 |
| `previewConsentDecision` | six-category ABAC evaluation | **167.4** | 0.09 | 1500 |
| `getCustodyChain` | custody-chain range query | **119.5** | 2.0 | 1500 |

Peak read throughput reached approximately **183 TPS**.

## 4. Where the cost goes

Container CPU sampled during a sustained saturating write round:

| Component | CPU (% of one core) | Share of total | Mean memory per container |
| --- | ---: | ---: | ---: |
| CouchDB (10 instances) | 358.3 | **73.1 %** | 94 MiB |
| Peers (10 instances) | 112.2 | 22.9 % | 223 MiB |
| IPFS (3 nodes) | 9.6 | 2.0 % | 37 MiB |
| Certification authorities (6) | 5.8 | 1.2 % | 14 MiB |
| Benchmark driver | 3.9 | 0.8 % | 310 MiB |
| Ordering service | 0.2 | 0.0 % | 264 MiB |
| Chaincode containers | 0.0 | 0.0 % | 59 MiB |
| Other tooling | 0.0 | 0.0 % | 14 MiB |

Aggregate utilisation reached approximately **61 % of the 8 available vCPUs**. The host is therefore not fully
CPU-saturated, and the ceiling is not attributable to raw CPU exhaustion alone: the
two-second ordering batch timeout also bounds latency whenever blocks are not full.
What the sampling does establish is **where the cost falls**, and the answer is state
persistence rather than consensus — the ordering service, which intuition blames first,
is close to negligible.

CouchDB is not an incidental choice. The six-category attribute-based access control
model of §3.5 needs rich queries over consent records, which LevelDB cannot serve.
The cost of granular athlete data sovereignty is therefore real, measurable, and paid
in state-database CPU.

> Sampled with `docker stats` over 4 intervals during a sustained saturating write round (initiateSampleCustody at 60 TPS offered). Used for CPU proportions only: the sampling itself adds load, so that round's own throughput (13.0 TPS) is lower than the headline figure and is not reported as a measurement.

> This is an attribution from resource sampling, not a controlled experiment. A
> LevelDB counterfactual was not run, so the size of the CouchDB penalty is not
> quantified here — only its dominance of CPU under load.

## 5. Against the operational demand line

§5.1 of the manuscript derives a reference figure of roughly **27 TPS** from WADA's
2022 total of ~330,000 samples at ~30 custody transactions per sample, concentrated
into peak testing periods.

Measured sustained write throughput of ~11 TPS sits **below** that line
on this hardware. Two things follow, and both matter more than a favourable number would.

1. **The original projection was wrong for a deployment of this kind.** The manuscript
   projected 300–500 TPS for a 5-organization network. Measurement returns roughly an
   order of magnitude less (~11 TPS). Reporting this is the point of
   building the prototype: a measured result that corrects a projection is a firmer
   contribution than a projection that happens to be right.
2. **The constraint is not intrinsic to the architecture.** It is a single host running
   36 containers, including the load driver, on 8 vCPUs, with CouchDB dominating. A
   provisioned deployment — peers on separate hosts, tuned state databases — is the
   obvious next measurement. It was not performed, so no figure for it is offered here.

What can be claimed on this evidence is narrower and firmer than the original
projection: the framework executes its complete regulatory workflow correctly under
sustained load with a 100 % commit rate, and on commodity single-host hardware its
write throughput is bounded by state-database cost at a level near, rather than
comfortably above, the estimated peak demand of a national testing programme.

## 6. Correctness results

Performance is only half the answer to the objection that the framework was never verified.

| Suite | Tests | What it establishes |
| --- | ---: | --- |
| Custody chaincode | 47 | Table 1 enforcement; **all 192** Q001–Q007 vectors; 7 invariants |
| Consent chaincode | 28 | Table 3 enforcement; §3.5 scenario; 5 ABAC invariants |
| Off-chain / erasure | 20 | AES-256-GCM, Shamir 2-of-3, Article 17 erasure against live IPFS |
| FHIR adapter | 15 | R4 structural validity; pseudonymity invariant |
| On-chain end-to-end | 11 | full regulatory workflow against the deployed network |

The decision-table suite enumerates the **complete** condition space — exhaustive
verification, not sampling. Resolution across the 192 vectors:

| Outcome | Vectors |
| --- | ---: |
| `PROCESS_INVALIDATED` | 96 |
| `NO_ACTION_REQUIRED` | 27 |
| `AAF_CONFIRMED` | 16 |
| `AAF_PENDING_REVIEW` | 16 |
| `ANALYSIS_REJECTED` | 16 |
| `ABP_ALERT_INITIATED` | 12 |
| `WHEREABOUTS_ADRV` | 9 |

Two properties the manuscript asserted are now enforced and tested against the live network:

- a single organization attempting to alter committed results-management state is
  rejected with `ENDORSEMENT_POLICY_FAILURE` (§4.1 collusion mitigation);
- a researcher authorized for a cardiovascular study receives 2 of 6 data categories
  and is refused the other 4, each refusal carrying a recorded justification (§3.5).

Dependency audit: **0 known vulnerabilities in production dependency trees** across all
packages. The advisories that are reported affect development-only test tooling
(`serialize-javascript`, reachable solely through `mocha`) and do not reach deployed chaincode.

## 7. What was not measured

Stated so no reader infers coverage that does not exist:

- 15-, 30- and 100-organization configurations — **not run, and not extrapolated**;
- multi-host or multi-region deployment;
- a LevelDB counterfactual to size the CouchDB penalty;
- Byzantine fault-tolerant ordering (the baseline is Raft, crash-fault-tolerant only);
- sustained soak testing or failure/recovery behaviour;
- adversarial penetration testing of the REST gateway.

