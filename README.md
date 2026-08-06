# Sentinel — Anti-doping Governance Framework

**A working reference implementation of a permissioned-blockchain governance
framework for elite sport: WADA Code chain of custody and GDPR athlete data
sovereignty, executing as smart contracts on Hyperledger Fabric.**

Technical architecture and development by **Sabri Barbaria**.

Accompanies the manuscript *Blockchain Governance Framework for Elite Sport:
Automating Anti-doping Chain of Custody and Athlete Biological Data Sovereignty
via Smart Contracts*. The manuscript specified the framework; this repository
implements, deploys, verifies and measures it.

---

## 1. What this is

Two problems in elite sport, addressed in one system.

**Chain of custody.** Anti-doping records live in mutable centralised databases.
The 2016 McLaren Investigation documented what that permits. Here every custody
event is a cryptographically signed, multi-organisation-endorsed transaction, and
the results-management logic of the WADA Code runs as an executing decision
engine rather than as a procedure someone follows.

**Data sovereignty.** Athletes surrender biological data under contracts they
cannot realistically refuse, with consent that is institutional rather than
granular. Here consent is a ledger record the athlete alone controls, evaluated
per data category, per purpose, per requesting organisation, at the moment of
access — and GDPR Article 17 erasure is a cryptographic operation, not a promise.

### What runs

| Component | Description |
| --- | --- |
| **Fabric network** | 5 organisational classes, one certification authority each, 10 peers, CouchDB state, Raft ordering |
| **`custody` chaincode** | 16 transactions — every WADA Code function of the manuscript's Table 1, plus the Table 2 decision engine |
| **`consent` chaincode** | 15 transactions — every GDPR function of Table 3, plus six-category attribute-based access control |
| **Off-chain layer** | AES-256-GCM payloads on a private 3-node IPFS cluster; Shamir 2-of-3 key recovery; Article 17 erasure |
| **FHIR adapter** | HL7 FHIR R4 mapping to `Patient`, `Observation`, `DiagnosticReport` |
| **REST gateway** | 32 routes over the Fabric Gateway API, authenticated against the organisational CAs |
| **Web platform** | Athlete-facing dashboard: custody chain, consent controls, access requests, erasure, network status |

**17 of 17** regulated functions implemented — 9 WADA Code articles, 8 GDPR
articles — each verified present in the chaincode source, not asserted.

### What the editor asked for

The manuscript was rejected on four grounds. Each maps to something runnable.

| Objection | Answer |
| --- | --- |
| "Purely theoretical." | 36-service deployment: `./scripts/network-up.sh` |
| "No functional prototype was built." | Both chaincodes committed to the channel; `./scripts/e2e-demo.sh` |
| "No such automation was implemented." | [`resultsDecision.ts`](chaincode/custody/src/resultsDecision.ts) — Table 2 as executing code |
| "No verification of the operation." | 112 tests, the complete 192-vector condition space, [13 executed scenarios](docs/SCENARIOS.md), 11 on-chain properties |

---

## 2. Requirements

The host needs **Docker with Compose v2** and **Python 3.10+**. Everything else —
Fabric binaries, the CA client, Hyperledger Caliper — runs inside containers.
Node 20+ is needed only to run the test suites outside a container.

Built and measured on Docker 29.6 / Compose v5.3, with 8 vCPU and 11.6 GB
allocated to the container runtime. The full network is roughly 4 GB of images
and about 2 GB of resident memory.

```bash
./scripts/preflight.sh      # verifies Docker, reports every pinned version
```

Pinned: Fabric 2.5.13 · Fabric CA 1.5.15 · CouchDB 3.3.3 · IPFS Kubo v0.29.0 ·
Node 20 · Caliper 0.6.0.

---

## 3. Deployment

```bash
./scripts/network-up.sh          # CAs, enrolment, peers, orderer, IPFS, channel
./scripts/deploy-chaincode.sh    # package, install, approve, commit both chaincodes
docker compose up -d gateway web # REST API and platform UI
```

Then open **http://localhost:8088** and sign in as `athleteuser` / `athleteuserpw`.

`network-up.sh` starts the six certification authorities, enrols every identity
against its own CA, brings up the peers and ordering service, then creates
`antidopingchannel` and joins all ten peers. `deploy-chaincode.sh` is idempotent:
it reads the committed sequence number and advances it, so redeploying an amended
contract is one command.

### Ports

| Service | Port |
| --- | --- |
| Web platform | 8088 |
| REST gateway | 3000 |
| Orderer (+ admin) | 7050, 7053 |
| Peers | 7051/7061 athlete · 8051/8061 federation · 9051/9061 NADO · 10051/10061 lab · 11051/11061 research |
| Certification authorities | 7054 athlete · 8054 federation · 9054 NADO · 10054 lab · 11054 research · 12054 orderer |
| CouchDB | 15984–15993 |
| IPFS API / gateway | 5011–5013 / 8091–8093 |

### Sign-in

Credentials are verified by **the organisation's own Fabric CA**: the gateway
builds a certificate signing request and enrols the user, so the CA's signature
*is* the authentication result. Nothing is checked against a list held by the
gateway.

| Organisation | User | Administrator |
| --- | --- | --- |
| Athlete | `athleteuser` / `athleteuserpw` | `athleteadmin` / `athleteadminpw` |
| Federation | `federationuser` / `federationuserpw` | `federationadmin` / `federationadminpw` |
| NADO | `nadouser` / `nadouserpw` | `nadoadmin` / `nadoadminpw` |
| Laboratory | `labuser` / `labuserpw` | `labadmin` / `labadminpw` |
| Research | `researchuser` / `researchuserpw` | `researchadmin` / `researchadminpw` |

A session fixes the acting organisation for its lifetime. An athlete session
cannot act as a laboratory, and the gateway refuses the attempt with `403`. This
layer only selects *which enrolled identity signs*; the authorisation decision
stays in the chaincode.

### Teardown

```bash
./scripts/network-down.sh            # stop, keep crypto material
./scripts/network-down.sh --purge    # also delete identities, channel artefacts, ledgers
```

`--purge` is required before a clean re-run: leaving old material in place mixes
identities from two different CA generations.

---

## 4. Using it

### The platform

The dashboard reads everything from the ledger — the custody chain with its real
transaction hashes, the six consent categories, the audit trail. Toggling a
category submits `recordConsentTransaction` or `withdrawConsent`. The access
request panel runs the §3.5 scenario live: a researcher asks for all six
categories and receives two, each refusal carrying its recorded reason and GDPR
article. The erase control performs a genuine Article 17 operation — key
destroyed, content unpinned across all three IPFS nodes, certificate recorded
on-chain.

The side menu filters between areas; **Network status** queries every peer and
reports reachability and latency.

### The command line

```bash
./scripts/e2e-demo.sh                        # full workflow, 11 asserted properties
(cd scenarios && npm install && npm start)   # 13 regulatory scenarios
./scripts/run-benchmark.sh                   # Hyperledger Caliper, 14 rounds
```

### The API

32 routes. Authenticate first, then send `Authorization: Bearer <token>`.

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"org":"nado","username":"nadouser","password":"nadouserpw"}' \
  | python -c "import json,sys;print(json.load(sys.stdin)['token'])")

curl -s -X POST localhost:3000/api/samples \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"sampleCode":"SMP-2026-1","athleteHash":"'"$(printf 'a%.0s' {1..64})"'",
       "sealedContainerHash":"seal-1","collectionLocation":"Tunis"}'
```

| Area | Routes |
| --- | --- |
| Auth | `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/session` |
| Custody | `POST /api/samples` · `.../transfers` · `.../analysis` · `.../results-management` · `.../notify` · `.../oversight` · `.../provisional-suspension` |
| Queries | `GET /api/samples/:code` · `.../custody-chain` · `.../history` · `.../results` |
| Consent | `POST` / `DELETE /api/consent` · `GET /api/consent/:athleteHash` · `POST /api/access-request[/preview]` |
| Off-chain | `POST /api/offchain/erase` · `GET /api/offchain/:athleteHash` · `POST /api/erasure` |
| Platform | `GET /api/network` · `GET /api/categories` · `POST /api/demo/seed` |

Chaincode rejections surface with meaning: `403` for an authorisation refusal,
`409` for an endorsement policy failure, `404` for a missing record — each
carrying the contract's own message rather than an opaque 500.

---

## 5. Verification

```bash
(cd chaincode/custody && npm install && npm test)   # 49
(cd chaincode/consent && npm install && npm test)   # 28
(cd offchain          && npm install && npm test)   # 20  (needs the IPFS cluster)
(cd fhir-adapter      && npm install && npm test)   # 15
```

**112 tests, 0 failing.** Line coverage 84–93 % across the four packages.

The custody suite enumerates the **complete** Q001–Q007 condition space — all 192
vectors — checking totality, determinism, rule reachability and seven regulatory
invariants. That is exhaustive verification of the regulatory logic, not sampling.

Beyond unit tests: **13 regulatory scenarios** executed against the running
network ([docs/SCENARIOS.md](docs/SCENARIOS.md)), **11 on-chain properties**
asserted by `e2e-demo.sh`, and **12 property-based invariants** over randomly
generated inputs.

Two properties the manuscript asserted are enforced and tested here:

- a single organisation attempting to alter committed results-management state is
  rejected with `ENDORSEMENT_POLICY_FAILURE`;
- a researcher authorised for a cardiovascular study receives 2 of 6 data
  categories and is refused the other 4.

Dependency audit: **no known vulnerabilities in production dependency trees.**

---

## 6. Measured performance

Archived release: [10.5281/zenodo.21817176](https://doi.org/10.5281/zenodo.21817176)

Six full passes of the 14-round suite, twelve identical rounds for between-round
variation, a paired endorsement experiment, and three control arms. Full account
in [docs/MEASUREMENT.md](docs/MEASUREMENT.md); raw output in
[docs/measurements/](docs/measurements/).

| | |
| --- | ---: |
| Custody-write throughput, 12 identical rounds | **15.7 – 36.3 TPS** (median 26.2) |
| Read-only regulatory evaluation | **166 TPS** (147 – 183, n = 3) |
| Cost of two-organisation endorsement, paired | **11 %** (1.8 – 17.8, n = 4 pairs) |
| CouchDB share of processor time | **59 %** (orderer: 1.2 %, n = 38 samples) |
| Centralised single-writer control arm | **≥ 157 TPS** at 0.15 s |

Three findings worth stating plainly.

**A single benchmark round is not a measurement.** Twelve rounds that differ in
nothing but when they ran span a factor of 2.31 (CV 32 %). The previous version of
this work reported one round, at 17.7 TPS, as the network's saturated throughput;
it was one draw from that distribution. We first suspected accumulated ledger
state and tested it — throughput is uncorrelated with round index (r = 0.047), so
that explanation is wrong.

**The bottleneck is state persistence, not consensus.** CouchDB takes 59 % of
processor time against 1.2 % for ordering. CouchDB is required by the six-category
access-control model, so the cost of granular data sovereignty is real and
measurable, and it is paid in storage.

**Throughput here is a lower bound, not a ceiling.** Running the load driver with
six workers instead of two lowered both the offered and the committed rate: the
driver consumes 11 % of the deployment's processor load and competes with the
network it measures. A driver on separate hardware is a precondition for any claim
of a saturation point.

All 34 running containers, including the load driver, share one host (8 vCPU /
11.6 GB). These figures characterise that deployment, not a provisioned cluster.

---

## 7. Two findings from implementing Table 2

Executing the decision table as originally specified surfaced gaps that prose left implicit.
Both are documented in
[`resultsDecision.ts`](chaincode/custody/src/resultsDecision.ts) and reported in
the manuscript rather than silently absorbed.

1. **Rule precedence was undefined.** Several rows can match one fact vector. The
   implementation makes "Process Invalidated" a precondition guard — no
   regulatory consequence may follow from an unverified chain of custody — and
   orders the rest by statutory urgency, retaining lower-precedence matches
   rather than discarding them.
2. **An unhandled condition.** Table 2 covers laboratory accreditation `YES` and
   `PENDING` but not `NO`. A result from a non-accredited laboratory cannot
   support an adverse analytical finding under Article 6.1, so it is rejected and
   audited rather than queued for review.

---

## 8. Repository layout

```
chaincode/custody/   WADA Table 1 functions + Table 2 decision engine
chaincode/consent/   GDPR Table 3 functions + six-category ABAC
offchain/            AES-256-GCM, IPFS, Shamir 2-of-3, Article 17 erasure
fhir-adapter/        HL7 FHIR R4 mapping
gateway/             REST API, CA-backed authentication
web/                 athlete platform (design + live client)
scenarios/           13 regulatory scenarios executed against the network
benchmark/           Caliper configuration and workload modules
network/             configtx, CA material, IPFS initialisation
scripts/             lifecycle, deployment, demonstration, benchmark, generation
docs/                architecture, scenarios, metrics, evaluation, threat model
```

6,037 lines of implementation, 3,758 lines of tests.

### Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the specification maps onto running software |
| [SCENARIOS.md](docs/SCENARIOS.md) | 13 scenarios as UML sequence diagrams, each executed |
| [diagrams/](docs/diagrams/) | all 14 sequence diagrams exported to PNG at 3× |
| [METRICS.md](docs/METRICS.md) | every quantitative claim, with its source |
| [EVALUATION.md](docs/EVALUATION.md) | measured throughput, latency, resource use |
| [THREAT-MODEL.md](docs/THREAT-MODEL.md) | threats split into enforced, mitigated, unaddressed |
| [RESPONSE-TO-EDITOR.md](docs/RESPONSE-TO-EDITOR.md) | response to the grounds for rejection |

Every one is **generated from measured data**. Re-run the pipeline and the
numbers move together:

```bash
./scripts/run-benchmark.sh                     # -> EVALUATION.md, Figure 10
(cd scenarios && npm start)                    # execute the 13 scenarios
python scripts/gen-scenarios-doc.py            # -> SCENARIOS.md
python scripts/export-diagrams.py              # -> docs/diagrams/*.png
python scripts/collect-metrics.py              # measure code, tests, network, security
python scripts/gen-metrics-doc.py              # -> METRICS.md
python scripts/update-manuscript.py \
  --docx "<original>.docx" --results docs/benchmark-results.json \
  --figure docs/figure6-measured-performance.png --diagrams docs/diagrams \
  --abstract short --out "<final>.docx"        # -> publication-ready manuscript
```

---

## 9. Design decisions worth knowing

**Endorsement is enforced per key, not per chaincode.** A blanket
`AND(NADOMSP, LabMSP)` policy would force laboratory endorsement on sample
*collection*, which the laboratory has no knowledge of. Instead the chaincode
binds critical keys to a two-organisation policy through state-based endorsement,
so the §4.1 insider-collusion mitigation is a property the test suite fails on if
it stops holding.

**The IPFS cluster is private.** No bootstrap peers, local-only routing. Athlete
ciphertext must never be announced to a public distributed hash table — the
content identifier alone would disclose that a record exists and its size.

**Chaincode runs as a service.** The peer connects to a container over gRPC
rather than building and launching the contract itself, so the deployed artefact
is byte-identical to the one the tests exercised.

**Determinism is a platform requirement.** Every endorsing peer simulates
independently and must produce an identical read-write set, which is why the
contracts read time from the transaction timestamp and never from a local clock.

---

## 10. Limitations

Stated plainly, and carried into the manuscript:

- **Key custody is in-process, not an HSM.** The prototype demonstrates the
  erasure *mechanism*, not production key management.
- **Cryptographic inaccessibility is not confirmed by supervisory authorities**
  to constitute erasure under GDPR Article 17. The legal question is open.
- **Demonstration credentials are fixed and public** in
  `scripts/registerEnroll.sh`, and session tokens are held in gateway memory.
  Appropriate for a demonstration deployment; not for anything carrying real
  athlete data.
- **Ordering is Raft** — crash-fault-tolerant, not Byzantine.
- **Measured at 5-organisation scale on one host.** 15-, 30- and
  100-organisation configurations were **not run**, and no figure is extrapolated
  for them.

---

## Author

**Sabri Barbaria** — technical architecture and development.

Laboratory of Biophysics and Medical Technologies, LR13ES07 (BTM), ISTMT,
University of Tunis El Manar, Tunis 1080, Tunisia.
<sabri.barbaria@istmt.utm.tn>

Designed, implemented, deployed and evaluated the reference implementation: the
Fabric network topology and multi-CA identity model, both chaincodes and the
Table 2 decision engine, the off-chain cryptography and Article 17 erasure path,
the FHIR adapter, the REST gateway and its CA-backed authentication, the athlete
platform, the verification suite, and the Caliper benchmark harness.

The framework specification originates in the accompanying manuscript, authored
with the wider research team.
