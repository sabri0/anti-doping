# Threat model

## Adversary

An insider: one organisation, or a coalition of organisations, acting with
its own legitimate identities and peers, and possibly running modified
contract code on its own peers. Out of scope: denial of service, network
attacks between organisations, compromise of a certification authority's
signing key (mitigated by hardware security modules, specified but not
implemented), and attacks on the platform's cryptography.

## What each mechanism defends against

| Mechanism | Defends against | Does not defend against |
| --- | --- | --- |
| Contract-level policy: peers of any two organisations | One organisation running modified code to write a public record | Two organisations both running modified code |
| Key-level policy: custody records and the sample record bound to NADO and laboratory from creation | Any write to a custody record lacking either organisation's peer | The two organisations together |
| Collection-level policy: NADO and laboratory for every results and notice write | A forged result, decision or notice by one of them, including at creation | The two together |
| Attestation: dispatch only by the NADO, receipt only by the named laboratory, acknowledgement only by the athlete; write-once results with two-party amendment | One organisation recording another's commitment, whatever endorsements it collects | Two organisations whose identities both sign |
| Private data collections; transient inputs; reference-only responses and events | Reading results, notices or consent on a non-member peer, or from blocks | Metadata: function names, sample codes, timing |
| Timestamp bound (±300 s at each endorser); monotonic custody | Backdating a custody event beyond the tolerance | Delaying submission of an already endorsed transaction |
| Ordering by four organisations; SmartBFT (K3) | Censorship by one ordering node | Two of four ordering organisations |
| Keyed pseudonyms (HMAC-SHA-256) | Reversal of athlete identifiers by enumeration | The athlete organisation, which holds the key |
| Athlete-mandatory recovery (3 of 4 shares, athlete holds 2) | Recovery of a key by custodians without the athlete | A custodian who kept a share copy before attesting destruction |
| Erasure: key, every share, unpinning; Article 17(2) notice | Further decryption of network-held ciphertext | Plaintext held by the laboratory; copies recipients decrypted |

## Coalition analysis

See Table 3 of the manuscript. The NADO and the laboratory together can record
anything they jointly attest. Against that pair the network offers attribution
(both identities sign), tamper-evidence (every other organisation holds the
hashes needed to detect later rewriting) and one cross-check by a third party:
the seal the laboratory reports at receipt must match the seal the athlete
acknowledged at collection. Substitution of a sample's contents behind an
intact seal is not detectable by any ledger design.

## Evidence

* `driver/scenarios.js`, scenario S7 — every NADO insider attempt in both
  endorsement forms, and single-class endorsement of protected writes.
* `driver/insider-comparison.js` and `docs/insider-comparison.json` — the same
  attempts against the custody contract of the first build cycle, redeployed
  as `custodyv1` by `scripts/deploy-v1-reference.sh`.
* `docs/measurements/K*-storage.json` — which peers' state databases hold
  private-collection content.
* Scenario S12 — the block holding an analysis, as stored by a research peer,
  contains none of its content.
