# Anti-doping governance on a permissioned ledger — release 2.0

**WADA Code chain of custody, results management and notice, and GDPR athlete
data rights, executing as smart contracts on a five-organisation Hyperledger
Fabric 3.1 network — with the formalisation log, insider tests and
measurement campaign that evaluate them.**

Technical architecture and development by **Sabri Barbaria**.

Accompanies the manuscript *Formalising anti-doping chain of custody and
athlete data rights as executable multi-party rules: a design science study on
a permissioned ledger*. Every measured number, and every performance table and
figure, in the manuscript is regenerated from the output archived here by
`scripts/analyse-evaluation.py`. The manuscript sources are not part of this
repository.

Archived version of record: [10.5281/zenodo.21817176](https://doi.org/10.5281/zenodo.21817176).
Development continues at <https://github.com/sabri0/anti-doping>.

---

## What changed in release 2.0

Release 2.0 is the second build–evaluate cycle. Its evaluation found that the
first release's design could not stop the insider it was meant to stop, and
the design was changed accordingly.

| | Release 1 | Release 2.0 |
| --- | --- | --- |
| Custody handover | one transaction, either party could submit | dispatch by the NADO, receipt only by the named laboratory, athlete acknowledgement of the seal |
| Results management | overwritable; key-level policy applied only after creation | write-once; amendment needs the other organisation; NADO and laboratory endorse every write, including creation |
| Confidentiality | every peer held every record | private data collections; transient inputs; reference-only responses and events |
| Article 14.1 | federation entitled at case closure | athlete and federation entitled from notice (Art. 14.1.2) |
| Time | client timestamp, unbounded | bounded at ±300 s by every endorser; monotonic custody |
| Ordering | one node, one organisation, Raft | four nodes, four organisations, Raft or SmartBFT |
| Pseudonyms, payload digests | unkeyed SHA-256 | HMAC-SHA-256 |
| Key recovery | 2-of-3; custodians could recover without the athlete | 3-of-4, athlete holds 2 |
| Revocation vs erasure | conflated | separate; erasure destroys every share; Article 17(2) notice |
| Platform | Fabric 2.5 | Fabric 3.1.5 |
| Measurement | Caliper, driver co-resident, unpinned | own driver on reserved processors, closed/open loop, randomised blocks, sentinels, baselines |

The first release is commit `6f6601d`. Its custody contract is kept in
`network/v1-reference/` and redeployed as `custodyv1` only for the insider
comparison; the first protocol's state-scaling rounds are kept in
`docs/archive-cycle1/state-scaling.json` for `scripts/analyse-state-scaling.py`.

## Requirements

Docker with Compose v2, Python 3.10+, and Node 20+ to run the test suites
outside containers. The Fabric 3.1.5 command-line binaries are fetched on first
run (`scripts/fetch-fabric-binaries.sh`).

## Run it

```bash
CONSENSUS=raft STATE_DB=goleveldb ./scripts/network-up.sh   # or bft / couchdb
./scripts/deploy-chaincode.sh
docker build -t antidoping/driver:2.0 -f driver/Dockerfile .
docker run --rm --network antidoping_v2 \
  -v "$PWD/network/organizations":/work/network/organizations:ro \
  antidoping/driver:2.0 scenarios.js                         # 14 regulatory workflows
docker compose up -d gateway web                             # REST API :3000, platform :8088
./scripts/network-down.sh --purge
```

## Evaluate it

```bash
./scripts/run-tests.sh                                       # unit, enumeration, property tests
CONFIG=K1 CONSENSUS=raft STATE_DB=couchdb   ./scripts/evaluate-configuration.sh
CONFIG=K2 CONSENSUS=raft STATE_DB=goleveldb ./scripts/evaluate-configuration.sh
CONFIG=K3 CONSENSUS=bft  STATE_DB=goleveldb ./scripts/evaluate-configuration.sh
./scripts/run-baselines.sh                                   # tamper-evident log, single CouchDB
./scripts/host-info.sh
./scripts/deploy-v1-reference.sh && node driver/insider-comparison.js
python scripts/analyse-evaluation.py                         # numbers, tables, figures
```

The protocol is in [docs/MEASUREMENT.md](docs/MEASUREMENT.md), the
formalisation log in [docs/FORMALISATION-LOG.md](docs/FORMALISATION-LOG.md), the
threat model in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) and the
architecture in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Raw output of
every measured round, with per-transaction timings, is in `docs/measurements/`.

## Layout

| Path | Contents |
| --- | --- |
| `chaincode/custody` | custody, results management, notice; decision function; tests |
| `chaincode/consent` | consent, six-category access control, Article 17; tests |
| `offchain` | AES-256-GCM, private IPFS, weighted Shamir recovery, erasure, keyed pseudonyms |
| `network` | channel profiles (Raft, SmartBFT), collection definitions, tools image; first-release custody contract (`v1-reference`) |
| `driver` | load driver, scenarios, insider comparison, tamper-evident-log baseline |
| `gateway`, `web`, `fhir-adapter` | application tier |
| `scripts` | network lifecycle, deployment, evaluation, analysis, figures |
| `docs` | documentation and measurement output |

## Limitations

Measured on one host (four cores, eight hardware threads, WSL 2), with the
driver separated from the network by processor pinning inside the virtual
machine, not by a second host. Keys are held in process memory, not a hardware
security module. The athlete organisation acts for individual athletes. WADA
is not a member of the network. Cryptographic erasure is a mechanism; whether
it satisfies GDPR Article 17 is not settled, and no claim is made that it does.

## Licence and author

See `LICENSE` if present; otherwise all rights reserved by the authors pending
publication. Technical architecture and development: Sabri Barbaria.
