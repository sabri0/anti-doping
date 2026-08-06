# Response to the Editorial Decision

Draft response addressing Dr. Górski's four grounds for rejection. Exact figures
are in [EVALUATION.md](EVALUATION.md); this document states what was done and
where the evidence sits.

> The decision was an editorial rejection rather than a request to revise, so
> this is a new submission rather than a revision. The response is written for
> whichever editor handles it.

---

## Summary

The editor's assessment was correct on every point. The submitted work was a
conceptual architecture study that named smart contract functions without
implementing them, and its Table 5 contained projections presented alongside an
admission that no prototype existed. Rather than argue the point, we built the
system.

The framework is now implemented, deployed, verified and measured. The paper is
consequently a different one: it specifies, implements and empirically evaluates
the framework, and reports results that in one respect **contradict** the
original submission's own projections.

---

## 1. "The article is purely theoretical in nature."

A complete reference implementation now accompanies the manuscript: a
containerized Hyperledger Fabric 2.5 network realizing the five organizational
classes of §3.2, each with its own certification authority, with ten peers,
CouchDB state databases, Raft ordering and a three-node private IPFS cluster.
The whole deployment is reproducible from a documented command sequence and
requires only Docker on the host.

New **Section 5, Reference Implementation**, describes what was built.

## 2. "No functional prototype was built."

Both chaincodes are deployed and committed to the channel, and the complete
regulatory workflow executes as committed blockchain transactions: custody
initiation, dual-endorsed transfers, laboratory analysis against a hash-verified
Prohibited List revision, results management, athlete notification, human
oversight, provisional suspension, consent grant, purpose-limited access
evaluation and withdrawal.

The repository contains an end-to-end script that drives this workflow against
the running network and asserts eleven properties.

## 3. "In the title, the authors emphasize automation using smart contracts. No such automation was implemented."

This was the most substantive objection and it has been addressed directly. The
Table 2 results-management decision logic is implemented as a pure, total and
deterministic decision engine over the conditions Q001–Q007, invoked by
`triggerResultsManagement()` after that function assembles the condition vector
from committed ledger state. Every function named in Tables 1 and 3 is
implemented with its published signature and enforces its regulatory
precondition rather than merely recording an event.

Implementing the decision table as originally specified produced a finding we consider the
most interesting result of this exercise: **Table 2 as published is not
executable.** It leaves rule precedence undefined where several rows can match
the same fact vector, and it omits the case in which laboratory accreditation is
affirmatively unverified. Prose decision tables tolerate such gaps; executing
code cannot. Both are resolved and reported in §5.3 rather than silently
absorbed, and we would argue that surfacing them is itself an argument for the
editor's position that the work required implementation to be complete.

## 4. "There is also no verification of the operation of such a framework."

Verification is now reported in **Section 6.2** and takes three forms.

**Exhaustive enumeration.** Because the decision engine is pure and total, its
input space is finite: 192 condition vectors. The suite enumerates every one and
establishes totality, determinism, traceability and rule reachability. This is
complete coverage of the regulatory logic, not sampling.

**Property-based verification.** Twelve regulatory invariants are asserted over
randomly generated inputs, including that an unverified chain of custody always
invalidates the process, that every uncertain outcome demands human oversight
under GDPR Article 22, and that no data category is released beyond the declared
purpose, beyond consent, without Article 9 authorization, or after withdrawal.

**Enforced ledger properties.** Two claims the original manuscript asserted are
now demonstrated against the deployed network. A single organization attempting
to alter committed results-management state is rejected with an endorsement
policy failure, because such state is bound to a policy naming peers from two
distinct organizational classes — the §4.1 insider-collusion mitigation is a
property the test suite fails on if it stops holding. Separately, the §3.5
worked scenario executes: a researcher authorized for a cardiovascular study
receives two of six biological data categories and is refused the remaining
four, each refusal carrying a recorded justification.

We also correct an error in the original §5.2, which proposed KEVM or Mythril
for formal verification. Both tools analyse Solidity and EVM bytecode; neither
can analyse Hyperledger Fabric chaincode. The proposal was not realizable as
written, and we say so explicitly in the revised text.

## 5. "I recommend realizing this research topic in clearly defined stages."

The work was carried out in nine staged increments, each with an acceptance
gate that had to pass before the next began: toolchain, network, custody
chaincode, off-chain cryptography, consent and access control, interoperability,
application tier, empirical validation, and verification. The repository
documents the stages and their gates.

---

## What changed in the results, and a caution

The evaluation does not flatter the original submission, and we think that is
the point of having performed it.

Table 5 previously projected 300–500 transactions per second for a
five-organization network. Measured sustained write throughput on our deployment
is roughly an order of magnitude lower. Resource monitoring attributes the
constraint to the CouchDB state databases — which the six-category
attribute-based access control design requires for rich queries — rather than to
consensus; the ordering service accounts for a small fraction of processor time.

Two qualifications are stated plainly in the revised manuscript. First, all
containers including the load driver share a single commodity host, so the
figures characterise that deployment and not a provisioned cluster. Second, we
did **not** run 15-, 30- or 100-organization configurations, and the revised
manuscript therefore reports no figure for them; the original Table 5 rows for
those scales are removed rather than retained as projections beside measured
values. We would rather present a narrower claim that is supported than a
broader one that is not.

## Changes to the manuscript

| Location | Change |
| --- | --- |
| Abstract | Methods, Results and Conclusions rewritten around the implementation and measurements |
| §5 (new) | Reference Implementation — network, contracts, decision engine, consent and erasure, interoperability |
| §6 (was §5) | Empirical Evaluation — measured throughput and latency; verification of the regulatory logic |
| §6.1 | Table 5 replaced with measured per-operation results; Figure 6 regenerated from real data |
| §6.2 | KEVM/Mythril proposal corrected and replaced with the verification actually performed |
| Table 4 | "Empirical validation" row updated from *proposed* to *implemented and measured* |
| §7.5 | "No functional prototype was built" removed; limitations narrowed to scale, host and key custody |
| §7.5 | Future research redirected toward provisioned multi-host measurement and state-persistence cost |
| Data availability | Repository, benchmark configuration and raw measurement output cited |
| §8 | Conclusions revised; the correction to our own projection stated explicitly |

The honest caveat on GDPR Article 17 is carried over unchanged: rendering data
cryptographically inaccessible has not been confirmed by supervisory authorities
to constitute erasure. The implementation demonstrates the mechanism; it does
not resolve the legal question.
