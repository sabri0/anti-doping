# Metrics

> **This file reports a single pass of the suite.** A single benchmark round on
> this host is one draw from a distribution spanning a factor of 2.31 (see
> [MEASUREMENT.md](MEASUREMENT.md)). Treat the figures below as one observation,
> not as the network's capacity; the replicated summary is in
> `benchmark-summary.json` and the full account in `MEASUREMENT.md`.

Every quantitative claim the article makes, with its source. Generated from
`docs/metrics.json` by [scripts/gen-metrics-doc.py](../scripts/gen-metrics-doc.py);
that JSON is collected from the running network, the test suites and the source
tree by [scripts/collect-metrics.py](../scripts/collect-metrics.py).

```bash
python scripts/collect-metrics.py     # measure
python scripts/gen-metrics-doc.py     # format
```

Nothing below is entered by hand. A metric that could not be collected reads
*not collected* rather than being estimated.

## 1. Headline figures

| Metric | Value |
| --- | ---: |
| Organizational classes deployed | 5 |
| Certification authorities | 6 |
| Peers | 10 |
| Compose services / running containers | 36 / 34 |
| Ledger height at collection | 1014 blocks |
| Smart contract functions mapped to regulation | 17 |
| …of which implemented | 17 |
| Automated tests | 112 passing, 0 failing |
| Decision-table condition space | 192 vectors, exhaustively enumerated |
| Executable regulatory scenarios | 13 (13 passing) |
| Benchmark transactions executed | 9774 (0 failed) |
| Peak measured write throughput | 17.7 TPS |
| Peak measured read throughput | 236.1 TPS |
| Source lines of code (excluding tests) | 6037 |
| Test lines of code | 3758 |

## 2. Regulatory coverage

Each article of the WADA Code and GDPR that the framework claims to automate,
with the function that implements it. Implementation is verified by locating the
function in the chaincode source, not asserted.

### WADA Code — 9/9 implemented

| Article | Requirement | Smart contract function | Implemented |
| --- | --- | --- | :-: |
| Article 2.1 | Prohibited substance present in the sample | `recordSampleAnalysisResult` | yes |
| Article 2.4 | Whereabouts failure documentation | `recordWhereaboutsStatus` | yes |
| Article 5.3 | Doping control process initiation | `initiateSampleCustody` | yes |
| Article 5.4 | Sample collection and custody transfer | `recordCustodyTransfer` | yes |
| Article 6.1 | Analysis by accredited laboratories | `recordSampleAnalysisResult / R2b` | yes |
| Article 7.1 | Results management after an adverse finding | `triggerResultsManagement` | yes |
| Article 7.3 | Athlete notification within the statutory period | `notifyAthleteOfAAF` | yes |
| Article 7.9 | Provisional suspension | `recordProvisionalSuspension` | yes |
| Article 14.1 | Confidentiality during results management | `enforceResultsConfidentiality` | yes |

### GDPR — 8/8 implemented

| Article | Requirement | Smart contract function | Implemented |
| --- | --- | --- | :-: |
| Article 5(1)(b) | Purpose limitation | `evaluateAccess (purpose ceiling)` | yes |
| Article 5(1)(c) | Data minimisation | `enforceDataMinimisation` | yes |
| Article 7 | Conditions for valid consent | `validateConsent / recordConsentTransaction` | yes |
| Article 7(3) | Withdrawal as easy as granting | `withdrawConsent` | yes |
| Article 9 | Special-category biological data | `checkSpecialCategoryAuthorization` | yes |
| Article 17 | Right to erasure | `revokeDataAccessKey / destroyIPFSAccessToken` | yes |
| Article 22 | Automated decisions with significant effect | `flagForHumanReview / enforceOversightRequirement` | yes |
| Article 25 | Data protection by design and by default | `applyDefaultPrivacySettings` | yes |

## 3. Decision-logic verification

The results-management engine is pure and total over 7 conditions
(Q001–Q007), giving **192 distinct condition vectors** — 2 values for each of six boolean conditions x 3 for tri-state Q002. The suite enumerates **all** of them: this is exhaustive
verification of the regulatory logic, not sampling.

| Outcome | Vectors | Share |
| --- | ---: | ---: |
| `PROCESS_INVALIDATED` | 96 | 50.0 % |
| `NO_ACTION_REQUIRED` | 27 | 14.1 % |
| `AAF_CONFIRMED` | 16 | 8.3 % |
| `AAF_PENDING_REVIEW` | 16 | 8.3 % |
| `ANALYSIS_REJECTED` | 16 | 8.3 % |
| `ABP_ALERT_INITIATED` | 12 | 6.2 % |
| `WHEREABOUTS_ADRV` | 9 | 4.7 % |
| **Total** | **192** | **100 %** |

Half the space resolving to `PROCESS_INVALIDATED` is correct, not a defect: Q007
is a precondition guard, so every vector with an unverified custody chain
invalidates regardless of the other six conditions.

## 4. Test suite and coverage

| Package | Tests | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| `chaincode/custody` | 49 | 91.0 % | 76.6 % | 87.7 % | 91.4 % |
| `chaincode/consent` | 28 | 81.4 % | 64.7 % | 78.4 % | 84.4 % |
| `offchain` | 20 | 90.3 % | 65.7 % | 94.7 % | 93.2 % |
| `fhir-adapter` | 15 | 89.2 % | 79.2 % | 100 % | 89.0 % |
| **Total** | **112** | | | | |

Coverage is line/branch coverage of the implementation packages. It is a weaker
guarantee than the exhaustive enumeration in §3, and is reported alongside it
rather than instead of it.

Beyond unit tests:

- **13 executable regulatory scenarios** driven against the running
  network — see [SCENARIOS.md](SCENARIOS.md).
- **11 on-chain properties** asserted by `scripts/e2e-demo.sh`.
- **12 property-based invariants** over randomly generated inputs (2000 runs each).

## 5. Scenario outcomes

| # | Scenario | Rule | Result |
| --- | --- | --- | --- |
| S1 | Adverse analytical finding confirmed on a verified custody chain | `R1_AAF_CONFIRMED` | pass |
| S2 | Incomplete chain of custody invalidates the process before any finding | `R5_PROCESS_INVALIDATED` | pass |
| S3 | Pending laboratory accreditation suspends automation pending human review | `R2_AAF_PENDING_REVIEW` | pass |
| S4 | Result from a non-accredited laboratory is rejected and audited | `R2B_ANALYSIS_REJECTED` | pass |
| S5 | Third ledger-verified whereabouts failure inside 12 months is an ADRV | `R4_WHEREABOUTS_ADRV` | pass |
| S6 | Athlete Biological Passport anomaly escalates to the expert panel | `R3_ABP_ALERT_INITIATED` | pass |
| S7 | Insider acting alone cannot alter committed results-management state | — | pass |
| S8 | Career-affecting decision blocked until a named human upholds it | — | pass |
| S9 | Purpose limitation releases two of six categories to an authorized researcher | — | pass |
| S10 | Consent withdrawal takes effect immediately | — | pass |
| S11 | Off-chain storage, key revocation with 2-of-3 recovery, then irreversible erasure | — | pass |
| S12 | Results are confidential during results management | — | pass |
| S13 | Late custody handover raises an exception and invalidates the process | `R5_PROCESS_INVALIDATED` | pass |

## 6. Performance

All rounds completed with **0 failed transactions** out of
**9774**, so every throughput figure reflects committed work.

### Saturation

| Offered load (TPS) | Throughput (TPS) | Mean latency (s) |
| ---: | ---: | ---: |
| 10 | 8.8 | 2.8 |
| 25 | 14.5 | 13.9 |
| 50 | 17.3 | 17.2 |
| 60 | 16.8 | 21.9 |
| 100 | 17.7 | 21.3 |

Saturates at **≈ 18 TPS**, against a WADA peak operational demand
reference of **≈ 27 TPS** (§5.1 of the manuscript).

### Per regulatory operation

| Operation | Type | Throughput (TPS) | Mean latency (s) | Transactions |
| --- | --- | ---: | ---: | ---: |
| `initiateSampleCustody — 1-org endorsement` | Write | 16.7 | 20.1 | 500 |
| `initiateSampleCustody — 2-org endorsement` | Write | 15.5 | 19.5 | 500 |
| `recordCustodyTransfer` | Write | 18.3 | 13.8 | 400 |
| `recordSampleAnalysisResult` | Write | 25.0 | 8.4 | 400 |
| `triggerResultsManagement` | Write | 6.1 | 35.8 | 300 |
| `validateConsent (six categories)` | Write | 38.2 | 3.5 | 400 |
| `evaluateDecisionTable (Table 2 alone)` | Read | 236.1 | 0.02 | 2000 |
| `previewConsentDecision` | Read | 199.8 | 2.6 | 1500 |
| `getCustodyChain` | Read | 174.2 | 0.31 | 1500 |

**Cost of the §4.1 cross-organizational endorsement mitigation: ≈ 7 %** of
write throughput, measured on the identical transaction endorsed by one
organization and then by two.

**The regulatory logic is not the cost.** The Table 2 engine alone runs at
236.1 TPS against 6.1 TPS for the full
on-chain results-management transaction — a factor of 39. What costs is
ledger I/O, endorsement and consensus, not the decision table.

## 7. Resource utilisation

Sampled with `docker stats` during a sustained saturating write round.

| Component | CPU (% of one core) | Share of load | Mean memory/container |
| --- | ---: | ---: | ---: |
| CouchDB (10) | 358.3 | 73.1 % | 94 MiB |
| Peers (10) | 112.2 | 22.9 % | 223 MiB |
| IPFS (3) | 9.6 | 2.0 % | 37 MiB |
| Certification authorities (6) | 5.8 | 1.2 % | 14 MiB |
| Benchmark driver | 3.9 | 0.8 % | 310 MiB |
| Ordering service | 0.2 | 0.0 % | 264 MiB |
| Chaincode (2) | 0.0 | 0.0 % | 59 MiB |
| Other tooling | 0.0 | 0.0 % | 14 MiB |

Aggregate: **490 %** of 800 % (**61 %** of 8 vCPUs).

**State persistence dominates.** CouchDB accounts for 73 % of processor
time while the ordering service is close to negligible. CouchDB is required by
the six-category ABAC design, which needs rich queries that the embedded
state database cannot serve — so the cost of granular data sovereignty is
measurable and is paid here.

> Sampled with `docker stats` over 4 intervals during a sustained saturating write round (initiateSampleCustody at 60 TPS offered). Used for CPU proportions only: the sampling itself adds load, so that round's own throughput (13.0 TPS) is lower than the headline figure and is not reported as a measurement.

## 8. Dependency security

| Scope | Critical | High | Moderate | Low |
| --- | ---: | ---: | ---: | ---: |
| Production dependencies | 0 | 0 | 0 | 0 |
| Including development tooling | 0 | 4 | 10 | 0 |

**No known critical or high-severity vulnerabilities reach deployed chaincode.**
The advisories that are reported affect development-only test tooling and are
not present in any production dependency tree.

## 9. Implementation size

| Component | Source files | Source LOC | Comment lines | Test files | Test LOC |
| --- | ---: | ---: | ---: | ---: | ---: |
| `chaincode/custody` | 8 | 1964 | 482 | 8 | 1636 |
| `chaincode/consent` | 6 | 1284 | 282 | 6 | 1446 |
| `offchain` | 8 | 712 | 238 | 2 | 404 |
| `fhir-adapter` | 2 | 572 | 86 | 2 | 272 |
| `gateway` | 4 | 892 | 138 | 0 | 0 |
| `scenarios` | 1 | 613 | 46 | 0 | 0 |
| **Total** | **29** | **6037** | **1272** | **18** | **3758** |

Test-to-source ratio **0.62:1**; comments are 17 % of
non-blank source lines, which is high by design — the code carries the regulatory
reasoning a reviewer needs to check it against the WADA Code and GDPR.

## 10. Deployed topology

| Role | Containers |
| --- | ---: |
| peer | 10 |
| statedb | 10 |
| ca | 6 |
| ipfs | 3 |
| chaincode | 2 |
| gateway | 1 |
| web | 1 |
| orderer | 1 |
| **Total running** | **34** |

Committed chaincode definitions:

| Name | Version | Sequence |
| --- | --- | ---: |
| `consent` | 1.0 | 4 |
| `custody` | 1.0 | 4 |

The sequence number counts committed upgrades — each redeploy of an amended
contract advances it, which is how the lifecycle records that the deployed
artefact changed.

## 11. What is not measured

Stated so no reader infers coverage that does not exist:

- 15-, 30- and 100-organization configurations — **not run, and not extrapolated**;
- multi-host or multi-region deployment;
- an embedded-state-database counterfactual to size the CouchDB penalty;
- Byzantine fault-tolerant ordering (the baseline is Raft, crash-fault-tolerant only);
- soak testing, failure injection or recovery behaviour;
- adversarial penetration testing of the REST gateway;
- comparison against ADAMS-based manual workflows.

