# Formalisation log

Every point at which executing the provisions required a decision the
provisions did not make. Table 2 of the manuscript is a summary of this file.

The log was produced by a fixed procedure (manuscript, Methods, *Regulatory
formalisation*):

1. restate each provision as typed functions over ledger state;
2. encode the decision table as a function whose type requires exactly one
   outcome for every input, and enumerate all 192 condition vectors against
   both the implementation and the rows as first specified, counting matches
   (`chaincode/custody/test/resultsDecision.spec.ts`, which writes
   `docs/formalisation-statistics.json`);
3. give each condition the computation that assembles it from ledger state
   (`assembleFacts` in `chaincode/custody/src/custodyContract.ts`);
4. execute each workflow as a scenario (`driver/scenarios.js`);
5. trace every function back to the article text of the 2021 Code, the ISTI,
   the ISRM and the GDPR.

A vector matching no row, or rows prescribing different outcomes, is a defect
of the table. Any other choice the provisions did not determine is an
interpretive decision. Both kinds are logged with the alternatives.

| ID | Kind | Provision | Left open | Surfaced at step | Adopted | Alternatives | Effect |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | table defect (hit policy) | Decision table R1–R5 | Which outcome applies when several rows match | 2: 78 of 192 vectors matched rows with different actions | Priority: R5 guard; R1/R2/R2b; R3; R4; lower matches retained | Collect all outcomes for human decision; redesign the conditions to be mutually exclusive | 93 vectors carry retained concurrent matches |
| F2 | table defect (completeness) | Decision table; Code Art. 6.1 | No-match outcome; positive result from an unaccredited laboratory | 2: 36 vectors matched nothing; of 32 positive-unverified vectors, 9 matched nothing and 23 fell to unrelated rows | R2b reject and audit; R0 no action, recorded | Route all unmatched vectors to human review | No positive result passes without an explicit outcome |
| F3 | interpretation | Q007; ISTI chain of custody | What "verified" consists of | 4: late receipt, broken seal, seal mismatch each needed an outcome | All mandatory phases; dispatch accepted by recipient; athlete acknowledgement with matching seal; no blocking exception | Late-but-documented handover accepted after review | Strict invalidation |
| F4 | interpretation | Q006; Code Art. 2.4 | Universal claim over an empty set | 3 | False | Vacuously true | Recorded fact only (R4 also needs Q005) |
| F5 | interpretation | Q002 with no analysis | Accreditation of an absent result | 3 | Unverified | Pending | Recorded fact only (Q001 is false) |
| F6 | interpretation | Code Art. 2.4 "twelve-month period" | Days or calendar months; anchor | 3 | Rolling 365 days ending at the transaction timestamp | Calendar months | ±1 day around leap years |
| F7 | interpretation | Code Art. 7.2; ISRM | A notification deadline the contract can record | 1 | Deployment parameter, 14 days default | None recorded | Late notice auditable |
| F8 | correction | Code Art. 14.1.1–14.1.2, 14.1.5 | From when the federation may read; 14.1 as access rule | 5: traceability audit | Athlete and federation entitled from notice; notice written to a second collection | First implementation: federation entitled at case closure | Corrected; enforced on the data |
| F9 | platform constraint | Fabric private data | How decision inputs are read from a collection | 4: Fabric refuses writes after a private range query | Per-athlete whereabouts summary; per-category recipient list | Keep whereabouts public | Every input reachable by one key |

## Traceability audit (step 5)

The audit found four references that followed the 2015 Code numbering rather
than the 2021 Code the work formalises:

| As first written | Correct (2021 Code) | Note |
| --- | --- | --- |
| Art. 7.9, provisional suspension | Art. 7.4 | Art. 7.9 does not exist in the 2021 Code |
| Art. 7.3, notification after an AAF | Art. 7.2 (review and notification, per the ISRM); Art. 14.1.1–14.1.2 | Art. 7.3 is identification of prior violations |
| Art. 5.3, initiation of the custody chain | Art. 5.4.1 (testing per the ISTI); ISTI sample collection | Art. 5.3 is event testing |
| Art. 5.4, custody transfer | Art. 5.4.1; ISTI transport and chain of custody | |

The contract comments, rule rationales and Supplementary Table S1 were
corrected accordingly.
