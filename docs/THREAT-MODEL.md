# Threat Model and Verification

Mirrors §4.1 of the manuscript, but distinguishes throughout between threats the
implementation **enforces and tests**, threats it **mitigates partially**, and
threats it **does not address**. The manuscript's original text asserted
mitigations; this document records which of them are executable properties.

## 1. Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Chain-of-custody records | on-ledger | integrity of the anti-doping process |
| Analysis results | on-ledger | career-affecting; confidential under Article 14.1 |
| Biological payloads | IPFS, AES-256-GCM ciphertext | special-category data under GDPR Article 9 |
| Data-encryption keys | key vault, in process | sole barrier after erasure |
| Consent records | on-ledger | the legal basis for every access |
| Organizational identities | Fabric CAs | authority to act as a class |

## 2. Threat T1 — insider collusion across CA boundaries

*An actor holding credentials from more than one organization endorses a
fraudulent results-management transaction.*

**Status: enforced and tested.**

Critical keys carry a state-based endorsement policy naming two distinct
organizational classes. A write endorsed by one organization alone fails
validation at commit with `ENDORSEMENT_POLICY_FAILURE`.

Tested by [scripts/e2e-demo.sh](../scripts/e2e-demo.sh) step 7 against the live
network, and at unit level by decoding the stored policy envelope and asserting
`listOrgs()` returns both MSP identifiers.

**Residual risk.** An actor controlling peers in *both* NADO and Laboratory
organizations defeats this. Raising the threshold raises the bar but does not
change the shape of the problem; a Byzantine-fault-tolerant ordering service
would address the ordering path but not endorsement collusion. Not implemented.

## 3. Threat T2 — retroactive record modification

*An actor rewrites a committed custody record — the Sochi failure mode.*

**Status: enforced by the platform, demonstrated.**

Modification requires re-endorsement and recomputation of every subsequent block
hash. `getSampleHistory()` exposes the full version history with transaction
identifiers; the end-to-end demonstration asserts a multi-version history.

**Residual risk.** Immutability of the *ledger* does not make the recorded
*facts* true. A doping control officer who enters false data at collection
produces an immutable false record. Blockchain relocates trust from the database
to the point of entry; it does not eliminate it. The manuscript should not claim
otherwise.

## 4. Threat T3 — unauthorized access to biological data

*A federation or research organization reads data it has no basis to read.*

**Status: enforced and tested.**

Two independent gates, both deny-by-default:

- **Article 14.1** — results are readable only by the NADO, the analysing
  laboratory and the athlete while a case is in results management.
- **Six-category ABAC** — every access is evaluated against the purpose ceiling
  *and* the athlete's consent record, with a reason recorded for each refusal.

The §3.5 scenario executes as a test: a researcher authorized for a
cardiovascular study receives haematological and accelerometry data only, with
the other four categories auto-denied. Four property-based invariants assert
that nothing is ever released beyond the purpose ceiling, beyond what the
athlete consented to, without Article 9 authorization, or after withdrawal.

**Residual risk.** The framework controls *release*, not what a recipient does
afterwards. Onward disclosure by an authorized recipient is outside its reach.

## 5. Threat T4 — compromise of off-chain storage

*An attacker obtains the IPFS content, or the on-chain record.*

**Status: mitigated.**

Payloads are AES-256-GCM ciphertext; the ledger holds only `{cid, keyRef}`.
Tests assert that the on-chain record contains no payload fragment, that IPFS
returns ciphertext, and that a full on-chain record without vault access yields
nothing. The cluster runs with no public bootstrap peers, so a CID is never
announced publicly — the CID alone would leak that a record exists and its size.

**Residual risk — stated as a limitation, not solved.** Keys live in process
memory. A production deployment needs an HSM. The prototype demonstrates the
erasure mechanism, not production key custody.

## 6. Threat T5 — automated career-affecting decisions

*An athlete is provisionally suspended by automated processing alone
(GDPR Article 22).*

**Status: enforced and tested.**

`recordProvisionalSuspension()` refuses unless a human oversight record naming a
reviewer exists **and** returned `UPHOLD`. Tested at unit level and on-chain
(demonstration step 8). Invariant INV-4 asserts that every uncertain Table 2
outcome demands human oversight.

## 7. Verification

### 7.1 Correcting the manuscript

§5.2 of the manuscript proposed **KEVM or Mythril** for formal verification.
Both target Solidity and EVM bytecode. Fabric chaincode is Go or TypeScript, and
neither tool can analyse it. The claim as published is not executable, and a
reviewer familiar with the stack would notice. It is replaced by the following.

### 7.2 Exhaustive condition-space enumeration

The Table 2 decision engine is pure and total, so its input space is finite and
small: 192 vectors. The suite enumerates **all** of them and asserts totality,
determinism, well-formedness, and that every rule is reachable. This is complete
coverage of the regulatory logic, not sampling.

Resolution across the space:

| Outcome | Vectors |
| --- | --- |
| `PROCESS_INVALIDATED` | 96 |
| `NO_ACTION_REQUIRED` | 27 |
| `AAF_CONFIRMED` | 16 |
| `AAF_PENDING_REVIEW` | 16 |
| `ANALYSIS_REJECTED` | 16 |
| `ABP_ALERT_INITIATED` | 12 |
| `WHEREABOUTS_ADRV` | 9 |

Half the space resolving to `PROCESS_INVALIDATED` is expected and correct: Q007
is a precondition guard, so every vector with an unverified custody chain
invalidates regardless of the other six conditions.

### 7.3 Property-based invariants

Twelve invariants over randomly generated inputs (2000 runs each):

| | Invariant |
| --- | --- |
| INV-1 | an unverified custody chain always invalidates the process |
| INV-2 | an AAF is confirmed only on a verified chain at an accredited laboratory |
| INV-3 | no adverse outcome without a positive analysis or a whereabouts failure |
| INV-4 | every uncertain outcome demands human oversight (Article 22) |
| INV-5 | every decision is confidential (Article 14.1) |
| INV-6 | a whereabouts ADRV requires all failures ledger-verified |
| INV-7 | evaluation never mutates its input |
| INV-A | nothing released beyond the purpose ceiling |
| INV-B | nothing released the athlete did not consent to |
| INV-C | special-category data never escapes without Article 9 authorization |
| INV-D | a withdrawn consent releases nothing |
| INV-E | every requested category receives exactly one reasoned outcome |

Plus, in the FHIR adapter, a pseudonymity invariant: no export ever contains a
direct identifier, whatever the input.

### 7.4 Live network properties

Eleven properties asserted against the running network by
[scripts/e2e-demo.sh](../scripts/e2e-demo.sh), including the two that the
manuscript could previously only assert: single-organization writes rejected
with `ENDORSEMENT_POLICY_FAILURE`, and purpose-limited ABAC releasing two of six
categories.

## 8. What this implementation does not address

Named explicitly so that no reader infers coverage that does not exist:

- production key management (HSM)
- Byzantine-fault-tolerant ordering — the baseline is Raft, which is
  crash-fault-tolerant only
- penetration testing of the REST gateway under adversarial conditions
- denial of service against peers or the ordering service
- migration from, or coexistence with, ADAMS
- multi-jurisdiction legal integration
- whether cryptographic inaccessibility constitutes erasure under Article 17 —
  an open legal question, not a technical one
