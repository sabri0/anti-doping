#!/usr/bin/env python3
"""Generate docs/SCENARIOS.md — UML sequence diagrams plus executed outcomes.

The diagrams are authored here; the outcome recorded beneath each one is read
from docs/scenario-results.json, which is produced by executing that scenario
against the running network. A diagram whose scenario did not pass is marked as
such rather than presented as demonstrated behaviour.

Usage:  python scripts/gen-scenarios-doc.py
"""

import argparse
import importlib.util
import json
import pathlib
import sys

# Mermaid sequence diagrams. Participants are the five organizational classes of
# §3.2 plus the ledger and the off-chain store, so every diagram reads against
# the same cast.
DIAGRAMS: dict[str, str] = {}

DIAGRAMS["S1"] = """
sequenceDiagram
    autonumber
    actor AT as Athlete
    participant NA as NADO
    participant LB as WADA-accredited Laboratory
    participant CC as custody chaincode
    participant LG as Ledger (5 orgs, Raft)

    Note over NA,LG: WADA Code Art. 5.3 — doping control initiation
    NA->>CC: initiateSampleCustody(code, athleteHash, sealHash, location)
    CC->>CC: requireMSP(NADOMSP) — reject non-pseudonymised identifier
    CC->>LG: put SAMPLE + CUSTODY:0 (COLLECTION)
    CC-->>AT: event SampleCustodyInitiated

    Note over NA,LB: Art. 5.4 — custody transfers, both parties endorse
    NA->>CC: recordCustodyTransfer(TRANSPORT_HANDOFF, NADO→Lab)
    CC->>LG: put CUSTODY:1 + setStateValidationParameter(AND(NADO, Lab))
    LB->>CC: recordCustodyTransfer(LABORATORY_RECEIPT, NADO→Lab)
    CC->>LG: put CUSTODY:2 + setStateValidationParameter(AND(NADO, Lab))

    Note over LB,LG: Art. 2.1 — analysis by an accredited laboratory
    LB->>CC: recordSampleAnalysisResult(adverse, listVersion, listHash, VERIFIED)
    CC->>LG: read PROHIBITEDLIST:version
    CC->>CC: verify listHash matches the on-ledger copy
    CC->>LG: put ANALYSIS

    Note over NA,LG: Art. 7.1 — results management
    NA->>CC: triggerResultsManagement(code)
    CC->>LG: range-query CUSTODY, EXCEPTION, WHEREABOUTS, ABP
    CC->>CC: assemble Q001..Q007 → decideResultsAction()
    CC->>CC: Q001=YES ∧ Q002=YES ∧ Q007=YES → R1 AAF_CONFIRMED
    CC->>LG: put RESULTS + key-level policy AND(NADO, Lab) — statutoryDeadline = now + 14d

    Note over NA,AT: Art. 7.3 — statutory notification
    NA->>CC: notifyAthleteOfAAF(code)
    CC-->>AT: event AthleteNotifiedOfAAF (within statutory period)
"""

DIAGRAMS["S2"] = """
sequenceDiagram
    autonumber
    participant NA as NADO
    participant LB as WADA-accredited Laboratory
    participant CC as custody chaincode
    participant LG as Ledger
    participant WA as WADA / audit

    NA->>CC: initiateSampleCustody(...)
    CC->>LG: put SAMPLE + CUSTODY:0 (COLLECTION)
    NA->>CC: recordCustodyTransfer(TRANSPORT_HANDOFF)
    CC->>LG: put CUSTODY:1

    rect rgba(220,70,60,0.10)
        Note over NA,LB: LABORATORY_RECEIPT is never recorded —<br/>a mandatory custody step is missing
    end

    LB->>CC: recordSampleAnalysisResult(adverse=true, VERIFIED)
    CC->>LG: put ANALYSIS

    NA->>CC: triggerResultsManagement(code)
    CC->>LG: range-query CUSTODY
    CC->>CC: MANDATORY_CUSTODY_STEPS ⊄ recorded → Q007 = NO
    CC->>CC: R5 guard fires before any finding rule is considered
    Note right of CC: R1 would also have matched —<br/>retained in concurrentMatches, not acted on
    CC->>LG: put RESULTS (PROCESS_INVALIDATED) — SAMPLE.status = INVALIDATED
    CC-->>WA: event CustodyException → audit alert (NADOMSP, WADA)
"""

DIAGRAMS["S3"] = """
sequenceDiagram
    autonumber
    actor AT as Athlete
    participant NA as NADO
    participant LB as Laboratory (accreditation PENDING)
    participant CC as custody chaincode
    participant HR as Human reviewer

    NA->>CC: custody chain completed (Art. 5.3, 5.4)
    LB->>CC: recordSampleAnalysisResult(adverse=true, PENDING)
    NA->>CC: triggerResultsManagement(code)
    CC->>CC: Q001=YES ∧ Q002=PENDING → R2 AAF_PENDING_REVIEW
    CC->>CC: humanOversightRequired = true (GDPR Art. 22)
    CC-->>HR: suspendAutomatedProcessing + flagForHumanReview

    rect rgba(230,160,30,0.12)
        Note over NA,AT: Automation stops here.<br/>No Article 7.3 notification may issue.
    end

    NA->>CC: notifyAthleteOfAAF(code)
    CC--xNA: rejected — requires a confirmed AAF, state is AAF_PENDING_REVIEW
"""

DIAGRAMS["S4"] = """
sequenceDiagram
    autonumber
    participant NA as NADO
    participant LB as Laboratory (NOT accredited)
    participant CC as custody chaincode
    participant WA as WADA / audit

    NA->>CC: custody chain completed
    LB->>CC: recordSampleAnalysisResult(adverse=true, UNVERIFIED)
    NA->>CC: triggerResultsManagement(code)

    rect rgba(220,70,60,0.10)
        Note over CC: Table 2 as published covers Q002 ∈ {YES, PENDING}.<br/>Q002 = NO is undefined — gap found by implementation.
    end

    CC->>CC: Q002 = NO → R2b ANALYSIS_REJECTED (WADA Art. 6.1)
    CC->>CC: the result cannot ground an adverse analytical finding
    CC-->>WA: rejectAnalysisResult + raiseAuditAlert (NADOMSP, WADA)
"""

DIAGRAMS["S5"] = """
sequenceDiagram
    autonumber
    actor AT as Athlete
    participant NA as NADO
    participant CC as custody chaincode
    participant LG as Ledger

    loop three filing failures inside 12 months
        NA->>CC: recordWhereaboutsStatus(athleteHash, failure=true, ledgerVerified=true)
        CC->>LG: put WHEREABOUTS:athlete:filing
        CC->>CC: count failures where recordedAt ≥ now − 365d
        CC-->>NA: failuresInWindow
    end

    NA->>CC: triggerResultsManagement(code)
    CC->>CC: Q005 = (failuresInWindow ≥ 3) = YES
    CC->>CC: Q006 = every failure ledger-verified = YES
    CC->>CC: analysis negative → R1/R2 do not match — R4 fires
    CC->>LG: put RESULTS (WHEREABOUTS_ADRV, Art. 2.4) — Art. 7 timeline starts

    Note over NA,AT: The violation is procedural, not analytical:<br/>no prohibited substance was ever detected.
"""

DIAGRAMS["S6"] = """
sequenceDiagram
    autonumber
    participant LB as Laboratory
    participant NA as NADO
    participant CC as custody chaincode
    participant EP as Athlete Passport Expert Panel

    LB->>CC: recordPassportEvaluation(anomaly=true, expertPanelRequired=true)
    CC->>CC: store ABP:athleteHash

    NA->>CC: triggerResultsManagement(code)
    CC->>CC: analysis negative → Q001 = NO
    CC->>CC: Q003 ∧ Q004 = YES → R3 ABP_ALERT_INITIATED
    CC-->>EP: notifyExpertPanel
    CC->>CC: enforceOversightRequirement — GDPR Art. 22 record required

    Note over CC,EP: A longitudinal profile alone never produces<br/>an automated sanction — a panel must review it.
"""

DIAGRAMS["S7"] = """
sequenceDiagram
    autonumber
    participant IN as NADO insider
    participant NP as NADO peer
    participant LP as Laboratory peer
    participant OR as Ordering service
    participant VS as Validation (VSCC)
    participant LG as Ledger

    Note over NP,LG: RESULTS:sample carries a key-level policy<br/>AND(NADOMSP.peer, LabMSP.peer)

    IN->>NP: triggerResultsManagement, endorsement pinned to NADOMSP
    NP-->>IN: endorsement signature (NADO only)
    IN->>OR: submit transaction with one endorsement
    OR->>VS: order and deliver in a block
    VS->>VS: evaluate state-based endorsement policy for RESULTS:sample
    VS--xLG: ENDORSEMENT_POLICY_FAILURE — transaction marked invalid

    rect rgba(60,150,110,0.12)
        Note over VS,LG: The block still contains the transaction,<br/>flagged invalid: the attempt is itself auditable.
    end

    LP-->>OR: (a second organization's endorsement was never obtained)
"""

DIAGRAMS["S8"] = """
sequenceDiagram
    autonumber
    actor AT as Athlete
    participant NA as NADO
    participant CC as custody chaincode
    participant HR as Named human reviewer

    NA->>CC: recordProvisionalSuspension(code, Art. 7.9)
    CC->>CC: read OVERSIGHT:code → absent
    CC--xNA: refused — GDPR Art. 22: no human oversight record

    HR->>CC: enforceOversightRequirement(reviewer-014, REQUEST_FURTHER_ANALYSIS, rationale)
    CC->>CC: oversight recorded, decision ≠ UPHOLD
    NA->>CC: recordProvisionalSuspension retried
    CC--xNA: refused — requires an UPHOLD decision

    HR->>CC: enforceOversightRequirement(reviewer-014, UPHOLD, rationale)
    NA->>CC: recordProvisionalSuspension(code, Art. 7.9)
    CC->>CC: oversight present ∧ UPHOLD → permitted
    CC->>CC: put SUSPENSION + key-level policy AND(NADO, Lab) — reviewer identity recorded
    CC-->>AT: event ProvisionalSuspensionRecorded

    Note over NA,HR: A career-affecting decision is never reached<br/>by automated processing alone.
"""

DIAGRAMS["S9"] = """
sequenceDiagram
    autonumber
    actor AT as Athlete
    participant CN as consent chaincode
    participant RE as Research institution
    participant LG as Ledger

    AT->>CN: recordConsentTransaction(ResearchMSP, cardiovascular_research,<br/>all six categories, validity, Art. 9 authorisation)
    CN->>CN: requireAthlete() — only the athlete may grant consent
    CN->>LG: put CONSENT:athlete:org:purpose

    RE->>CN: validateConsent(athleteHash, cardiovascular_research, all six categories)
    CN->>LG: read CONSENT:athlete:ResearchMSP:cardiovascular_research

    loop for each requested category
        CN->>CN: 1. consent record exists?  (Art. 25, deny by default)
        CN->>CN: 2. purpose recognised and matching?  (Art. 5(1)(b))
        CN->>CN: 3. consent live and in date?  (Art. 7)
        CN->>CN: 4. within the purpose ceiling?  (Art. 5(1)(c) minimisation)
        CN->>CN: 5. category consented to?  (Art. 7)
        CN->>CN: 6. Art. 9 authorisation if special category?
    end

    CN->>LG: put ACCESSAUDIT (recorded whether or not data is released)
    CN-->>RE: GRANTED  abp_haematological, gps_accelerometry
    CN-->>RE: DENIED   biochemical_markers, abp_steroidal, psychological, genetic<br/>each with a recorded reason and article

    Note over CN,RE: Asking for more than the purpose requires<br/>does not widen the release.
"""

DIAGRAMS["S10"] = """
sequenceDiagram
    autonumber
    actor AT as Athlete
    participant CN as consent chaincode
    participant RE as Research institution

    AT->>CN: recordConsentTransaction(haematological, accelerometry)
    RE->>CN: previewConsentDecision(...)
    CN-->>RE: GRANTED 2 categories

    AT->>CN: withdrawConsent(ResearchMSP, cardiovascular_research)
    CN->>CN: requireAthlete() — mark record revoked (Art. 7(3))
    CN-->>AT: event ConsentWithdrawn

    RE->>CN: previewConsentDecision(...) — same request as before
    CN->>CN: grant.revoked = true → deny every category
    CN-->>RE: GRANTED 0 — reason "consent has been withdrawn by the athlete"

    Note over AT,RE: Withdrawal is as easy as granting,<br/>and takes effect on the next evaluation.
"""

DIAGRAMS["S11"] = """
sequenceDiagram
    autonumber
    actor AT as Athlete
    participant LB as Laboratory
    participant KV as Key vault
    participant IP as IPFS cluster (3 nodes, private)
    participant CN as consent chaincode
    participant LG as Ledger

    Note over LB,LG: Store — the payload never reaches the ledger
    LB->>KV: create() → keyRef (vault keeps the only copy)
    LB->>LB: AES-256-GCM encrypt(payload, key)
    LB->>IP: add ciphertext to every node
    IP-->>LB: CID (identical on all three — asserted, not assumed)
    LB->>CN: registerOffchainPayload(cid, keyRef, plaintextDigest)
    CN->>LG: put PAYLOAD {cid, keyRef} only

    Note over AT,IP: Path A — revoke the key, retain the ciphertext
    AT->>KV: splitForRecovery(key) → 3 shares, threshold 2
    AT->>KV: revokeDataAccessKey(keyRef)
    KV->>KV: overwrite key material, mark destroyed
    AT->>IP: retrieve attempted
    KV--xAT: denied — key destroyed under GDPR Art. 17
    AT->>KV: recoverDataAccessKey([1 share])
    KV--xAT: refused — threshold is two
    AT->>KV: recoverDataAccessKey([athlete share, federation share])
    KV-->>AT: key restored → payload readable again

    Note over AT,LG: Path B — full erasure, irreversible
    AT->>KV: destroyIPFSAccessToken(record)
    KV->>KV: destroy key
    KV->>IP: pin rm + repo gc on every node
    IP-->>KV: unpin results per node
    KV-->>AT: erasure certificate (with the standing legal caveat)
    AT->>CN: destroyIPFSAccessToken(certificate)
    CN->>CN: certificate CID must match — must attest key destruction
    CN->>LG: append ERASURE certificate — the ledger is never rewritten

    AT->>IP: even with a restored key, request the content
    IP--xAT: no node holds the block — the ciphertext itself is gone
"""

DIAGRAMS["S12"] = """
sequenceDiagram
    autonumber
    participant NA as NADO
    participant LB as Laboratory
    actor AT as Athlete
    participant FE as Federation
    participant RE as Research
    participant CC as custody chaincode

    Note over CC: SAMPLE.status = RESULTS_MANAGEMENT

    NA->>CC: enforceResultsConfidentiality(code)
    CC-->>NA: GRANTED
    LB->>CC: enforceResultsConfidentiality(code)
    CC-->>LB: GRANTED
    AT->>CC: enforceResultsConfidentiality(code)
    CC-->>AT: GRANTED

    rect rgba(220,70,60,0.10)
        FE->>CC: enforceResultsConfidentiality(code)
        CC--xFE: DENIED — confidential during results management
        RE->>CC: enforceResultsConfidentiality(code)
        CC--xRE: DENIED — no lawful basis to read results
    end

    Note over CC,FE: The federation gains access only once<br/>the case leaves results management.
"""

DIAGRAMS["S13"] = """
sequenceDiagram
    autonumber
    participant NA as NADO
    participant LB as Laboratory
    participant CC as custody chaincode
    participant LG as Ledger

    NA->>CC: initiateSampleCustody(...)
    CC->>LG: put SAMPLE + CUSTODY:0

    Note over NA,LB: Handover arrives after its contractual window
    NA->>CC: recordCustodyTransfer(TRANSPORT_HANDOFF, window = 0h)
    CC->>CC: deadline = previous event + window
    CC->>CC: txTimestamp > deadline
    CC->>LG: put CUSTODY:1 anyway — suppressing it would destroy the audit trail
    CC->>LG: put EXCEPTION (TRANSFER_WINDOW_EXCEEDED)
    CC-->>NA: event CustodyException — NADO alerted

    LB->>CC: recordCustodyTransfer(LABORATORY_RECEIPT)
    LB->>CC: recordSampleAnalysisResult(adverse=true, VERIFIED)

    NA->>CC: triggerResultsManagement(code)
    CC->>LG: range-query EXCEPTION
    CC->>CC: blocking exception present → Q007 = NO
    CC->>LG: put RESULTS (PROCESS_INVALIDATED)

    Note over CC,LG: All three mandatory phases exist, yet the chain<br/>is still rejected: an unexplained gap in the timeline<br/>is exactly the Sochi failure mode.
"""

FABRIC_FLOW = """
sequenceDiagram
    autonumber
    participant CL as Client (gateway)
    participant EP as Endorsing peers<br/>(NADO + Laboratory)
    participant CC as Chaincode container<br/>(chaincode-as-a-service)
    participant SD as CouchDB state DB
    participant OS as Ordering service (Raft)
    participant CP as Committing peers (all 10)
    participant LG as Ledger

    CL->>EP: 1. transaction proposal (signed by the org's identity)
    EP->>CC: 2. simulate over gRPC
    CC->>SD: read current state
    CC->>CC: evaluate regulatory logic (deterministic — no clock, no randomness)
    CC-->>EP: read-write set
    EP-->>CL: 3. endorsement signatures
    Note over CL,EP: Each peer simulates independently and must<br/>produce an identical read-write set.

    CL->>OS: 4. submit endorsed transaction
    OS->>OS: order into a block (batch timeout 2s, max 500)
    OS->>CP: 5. deliver block
    CP->>CP: VSCC — endorsement policy, including key-level (SBE) policies
    CP->>CP: MVCC read-set validation
    CP->>LG: 6. commit — invalid transactions retained and flagged
    CP->>SD: update world state
    CP-->>CL: commit status event
"""


def png_name(sid: str) -> str:
    """Filename the exporter writes for this scenario, so links stay in step."""
    spec = importlib.util.spec_from_file_location(
        "export_diagrams", pathlib.Path(__file__).resolve().parent / "export-diagrams.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.NAMES.get(sid, sid)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-r", "--results", type=pathlib.Path,
                    default=pathlib.Path("docs/scenario-results.json"))
    ap.add_argument("-o", "--out", type=pathlib.Path, default=pathlib.Path("docs/SCENARIOS.md"))
    args = ap.parse_args()

    if not args.results.exists():
        sys.exit(f"no scenario results at {args.results} — run scenarios/run.ts first")

    data = json.loads(args.results.read_text(encoding="utf8"))
    by_id = {s["id"]: s for s in data["scenarios"]}

    L: list[str] = []
    w = L.append

    w("# Regulatory Scenarios")
    w("")
    w("Thirteen scenarios covering the WADA Code and GDPR paths the framework automates.")
    w("")
    w("**Each diagram is a transcription of transactions that actually committed.** The")
    w("scenarios are executed against the running network by")
    w("[scenarios/run.ts](../scenarios/run.ts), which asserts the expected outcome of each")
    w("and fails the run if any assertion does not hold. The observed outcome is quoted")
    w("beneath every diagram, and the whole document is regenerated by")
    w("[scripts/gen-scenarios-doc.py](../scripts/gen-scenarios-doc.py).")
    w("")
    w(f"Last executed: `{data['generatedAt']}` — "
      f"**{data['total'] - data['failures']}/{data['total']} scenarios passed**.")
    w("")
    w("Rendered copies of every diagram are exported to [diagrams/](diagrams/) as PNG")
    w("at 3x scale, suitable for dropping into the manuscript.")
    w("")
    w("```bash")
    w("./scripts/network-up.sh && ./scripts/deploy-chaincode.sh")
    w("docker compose up -d gateway web")
    w("(cd scenarios && npm install && npm start)")
    w("python scripts/gen-scenarios-doc.py")
    w("python scripts/export-diagrams.py          # -> diagrams/*.png")
    w("```")
    w("")

    # ------------------------------------------------------------- index
    w("## Index")
    w("")
    w("| # | Scenario | Regulation | Table 2 rule | Result |")
    w("| --- | --- | --- | --- | --- |")
    for sid in DIAGRAMS:
        s = by_id.get(sid)
        if not s:
            continue
        rule = f"`{s['rule']}`" if s.get("rule") else "—"
        status = "pass" if s["passed"] else "**FAILED**"
        w(f"| {sid} | [{s['title']}](#{sid.lower()}) | {s['regulation']} | {rule} | {status} |")
    w("")

    w("### Coverage of the Table 2 decision space")
    w("")
    w("The five published rows of Table 2, the rule added to close the gap found during")
    w("implementation, and the precedence guard are each exercised by a scenario:")
    w("")
    w("| Rule | Meaning | Scenario |")
    w("| --- | --- | --- |")
    w("| `R5_PROCESS_INVALIDATED` | guard — unverified custody chain | S2, S13 |")
    w("| `R1_AAF_CONFIRMED` | adverse finding at an accredited laboratory | S1 |")
    w("| `R2_AAF_PENDING_REVIEW` | accreditation pending | S3 |")
    w("| `R2B_ANALYSIS_REJECTED` | accreditation unverified (gap closed) | S4 |")
    w("| `R3_ABP_ALERT_INITIATED` | passport anomaly + expert panel | S6 |")
    w("| `R4_WHEREABOUTS_ADRV` | third verified failure in 12 months | S5 |")
    w("")

    # --------------------------------------------------------- scenarios
    for sid, diagram in DIAGRAMS.items():
        s = by_id.get(sid)
        if not s:
            continue

        w("---")
        w("")
        w(f"## {sid} — {s['title']}")
        w("")
        w(f"**Regulation:** {s['regulation']}  ")
        if s.get("rule"):
            w(f"**Decision-table rule:** `{s['rule']}`  ")
        w(f"**Status:** {'executed and asserted' if s['passed'] else 'FAILED — see below'}")
        w("")
        w("```mermaid")
        w(diagram.strip())
        w("```")
        w("")
        w(f"[PNG]({'diagrams/' + png_name(sid)}.png) &middot; "
          f"rendered at 3x for print use")
        w("")
        w("**Observed on the network**")
        w("")
        w("> " + s["outcome"])
        w("")
        if not s["passed"]:
            w(f"> **Expected:** {s['expected']}")
            w("")
        if s.get("steps"):
            w("<details><summary>Executed steps</summary>")
            w("")
            w("| Actor | Action | Outcome |")
            w("| --- | --- | --- |")
            for st in s["steps"]:
                w(f"| {st['actor']} | {st['action']} | {st['outcome']} |")
            w("")
            w("</details>")
            w("")

    # ------------------------------------------------------ platform flow
    w("---")
    w("")
    w("## Platform transaction flow")
    w("")
    w("The six-phase Hyperledger Fabric flow every scenario above runs through. This")
    w("replaces the schematic version of the manuscript's Figure 5 with the deployed")
    w("configuration, including the key-level endorsement check that the §4.1 mitigation")
    w("depends on.")
    w("")
    w("```mermaid")
    w(FABRIC_FLOW.strip())
    w("```")
    w("")
    w("[PNG](diagrams/F1-fabric-transaction-flow.png)")
    w("")
    w("Two properties of this flow are load-bearing for the framework:")
    w("")
    w("- **Determinism.** Every endorsing peer simulates independently and the read-write")
    w("  sets must match, which is why the chaincode reads time from the transaction")
    w("  timestamp rather than a local clock.")
    w("- **Invalid transactions are retained.** A rejected transaction stays in the block,")
    w("  flagged invalid, so an attempt to write results-management state with insufficient")
    w("  endorsement (S7) is itself part of the audit trail.")
    w("")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(L) + "\n", encoding="utf8", newline="\n")
    print(f"wrote {args.out} ({len(L)} lines, {len(DIAGRAMS)} diagrams)")
    missing = [k for k in DIAGRAMS if k not in by_id]
    if missing:
        print("WARNING: diagrams without executed results:", ", ".join(missing))
    failed = [s["id"] for s in data["scenarios"] if not s["passed"]]
    if failed:
        print("WARNING: scenarios that did not pass:", ", ".join(failed))


if __name__ == "__main__":
    main()
