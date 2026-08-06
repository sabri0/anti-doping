# TITLE
An implemented and measured blockchain framework enforcing anti-doping chain of custody and athlete data rights in elite sport

# AUTHORS
Ismail Dergaa^1,2,3^, Sabri Barbaria^4^, Chamseddine Barki^4^, Mortadha Razzak^3^, Nizar Souissi^2^, Hesham R. El-Seedi^5^, Halil İbrahim Ceylan^6^, Valentina Stefanica^7^, Raul Ioan Muntean^8^, Nicola Luigi Bragazzi^9^ and Hanene Boussi Rahmouni^4,10^

# AFFILIATIONS
1 High Institute of Sport and Physical Education of Ksar Said, University of Manouba, Manouba 2010, Tunisia.
2 Physical Activity Research Unit, Sport and Health (UR18JS01), National Observatory of Sports, Tunis 1003, Tunisia.
3 High Institute of Sport and Physical Education of Kef, University of Jendouba, Jendouba 7100, Tunisia.
4 Laboratory of Biophysics and Medical Technologies, LR13ES07 (BTM), ISTMT, University of Tunis El Manar, Tunis 1080, Tunisia.
5 Department of Chemistry, Faculty of Science, Islamic University of Madinah, Madinah 42351, Saudi Arabia.
6 Physical Education and Sports Teaching Department, Faculty of Sports Sciences, Atatürk University, 25240 Erzurum, Türkiye.
7 Department of Physical Education and Sport, National University of Science and Technology Politehnica Bucharest, Pitești 060042, Romania.
8 Faculty of Sciences, Department of Physical Education and Sport, "1 Decembrie 1918" University of Alba Iulia, Alba Iulia, Romania.
9 Department of Clinical Pharmacy, Saarland University, 66123 Saarbrücken, Germany.
10 The Computer Science Research Center, University of the West of England, Bristol BS16 1QY, UK.

Correspondence and requests for materials should be addressed to H.İ.C. (halil.ibrahimceylan60@gmail.com), V.S. (valentina.stefanica@upb.ro) or R.I.M. (muntean.raul@uab.ro).

# ABSTRACT
{{ABSTRACT}}

# INTRODUCTION

Elite athletes generate biological data as a by-product of their profession, and those data are then processed, stored, shared and commercialised by clubs, federations, international governing bodies, national anti-doping organisations, accredited laboratories and analytics providers under bilateral institutional arrangements. Performance metrics inform contract valuations, injury histories affect transfer negotiations and hormonal profiles influence selection; the individual whose biology produces every data point holds the weakest governance position in the arrangement^1,2^. Governance of these data currently rests on institutional data-sharing agreements, collective bargaining provisions and general data protection law, none of which was designed for the multi-institutional structure of elite sport^2,15^.

The most sensitive of these records are longitudinal. The Athlete Biological Passport builds haematological and steroidal profiles across an athlete's entire career, and the statistical validity of any adverse passport finding depends entirely on the authenticity of the underlying series rather than on any single measurement^16–18^. Ethical frameworks developed for sports medicine identify data ownership, granular consent and institutional accountability as the normative foundation for handling such records, and identify the absence of technical enforcement, rather than the absence of normative commitment, as the operative weakness in current practice^19^.

The anti-doping system concentrates the problem. Athletes in a registered testing pool must declare their location every day of the year under Article 2.4 of the World Anti-Doping Agency (WADA) Code, producing continuous geolocation records^3^. Their samples pass through a documented chain of custody from doping control officers through transport couriers to accredited laboratories, and results are managed in the Anti-Doping Administration and Management System (ADAMS) before adjudication under Article 7^3^. Every step depends on centralised, mutable records that are verified periodically rather than protected continuously. The 2016 McLaren Investigation documented what that architecture permits: at the Sochi laboratory and in the Moscow laboratory information management system, sample records were altered after the fact, adverse analytical findings were deleted and custody documentation was backdated across more than 1,000 samples, none of which triggered a system-level alert^4^.

A parallel obligation arises in data protection law. Article 9 of the General Data Protection Regulation (GDPR) classifies biometric and health data as special-category personal data requiring explicit consent, a documented lawful basis and technical means of honouring data subject rights including erasure and purpose limitation^5^. Sports organisations processing the biometric data of European athletes fall within these requirements irrespective of where they are domiciled^6,7^, and non-compliance carries penalties of up to 4% of global annual turnover^5^. No systematic technical architecture exists for meeting these obligations across a multi-institutional data-sharing network.

Permissioned distributed ledgers have been proposed as the remedy. Each block carries a cryptographic hash of its predecessor, so a retroactive change to a historical record creates an inconsistency detectable across the whole network rather than at the next audit^21,22^. Systematic reviews establish that such ledgers offer auditability, data integrity and granular access control that centralised systems cannot provide, and identify Hyperledger Fabric as the platform of choice for multi-organisational healthcare deployments^8–10,24^. Smart contract enforcement of protocol compliance has been demonstrated in clinical trials^11^ and of consent and access logging across heterogeneous device networks^26,27^; attribute-based access control has been identified as the most effective mechanism for granular privacy enforcement in multi-party ledger systems^29^; permissioned ledgers have been reviewed as a route to automated GDPR compliance where cross-jurisdictional obligations cannot be monitored manually with any consistency^30^; and a decision-table methodology for translating HIPAA and GDPR provisions into executable authorisation logic has been established for multi-institutional clinical research^12^. In sport specifically, Pinto et al. proposed the first dedicated blockchain architecture for anti-doping, addressing the therapeutic use exemption process^13^, and Pastor Osuna et al. extended the idea to Athlete Biological Passport data^23^. McLean et al. argued that anti-doping must move from reactive detection to structural reform of its infrastructure^14^, and Guo et al. showed that athlete data protection requires combinations of regulatory, contractual and technical controls, no one of which suffices alone^15^.

These proposals share a limitation: none was built. The architectures were specified and their performance was projected, not measured, and the regulatory logic they describe was never required to execute. That distinction matters more than it appears. A decision table written in prose can be incomplete without anyone noticing, because a human reader resolves the gaps silently; the same table compiled into a contract that must return exactly one outcome for every possible input cannot.

Here we implement, deploy, verify and measure such a framework. A five-organisation Hyperledger Fabric network with one certification authority per organisational class, encrypted off-chain storage and attribute-based access control executes WADA Code Articles 2, 5, 6, 7 and 14 and GDPR Articles 7, 9, 17, 22 and 25 as smart contract logic. We report what executing the regulation revealed about the regulation, what the deployed network enforces as a matter of measured behaviour rather than design intent, and what the guarantees cost in throughput on commodity hardware. The measurements also correct two claims made in an earlier version of this work, one of them a performance projection and the other a single-run figure that we can now show was not a property of the network at all.

# RESULTS

## A deployed network that executes the regulatory workflow

The framework runs as a containerised five-organisation Hyperledger Fabric 2.5 deployment: six certification authorities, ten peers each backed by its own CouchDB state database, Raft ordering, and a private three-node InterPlanetary File System (IPFS) cluster for encrypted off-chain payloads (Methods). Two chaincodes implement every regulated function: 16 chain-of-custody transactions covering the WADA Code articles of Supplementary Table S1 and 15 consent transactions covering the GDPR articles of Supplementary Table S2, listed in full in Supplementary Table S4.

Thirteen regulatory workflows were executed end to end against the deployed network, each asserting its expected regulatory outcome, and all thirteen passed (Supplementary Table S3, Supplementary Figs S1–S5). Together they exercise every rule of the results-management decision engine, both organisational-authorisation boundaries, the GDPR Article 22 oversight precondition, the six-category access-control model and both Article 17 erasure paths.

## Executing the decision table exposed two gaps in it

Results management is implemented as a pure, total and deterministic function of seven conditions, Q001–Q007, assembled from committed ledger state (Table 1). Purity is a platform requirement as much as a design preference: each endorsing peer simulates a transaction independently and must produce an identical read–write set — the record of the ledger keys a transaction read and the values it would write — so the contract derives time from the transaction timestamp rather than from a local clock.

Because the function is pure and total, its input space is finite and small: two values for each of six Boolean conditions and three for the tri-state laboratory-accreditation condition give 192 distinct condition vectors. The verification suite enumerates every one of them, establishing that the engine is total, that it is deterministic, that each decision carries a traceable rule identifier and rationale, and that every rule is reachable. This is exhaustive verification of the regulatory logic rather than sampling of it.

Compiling the decision table as we had originally specified it surfaced two under-specifications that prose tolerates and executable code cannot. First, rule precedence was undefined. Several rows can match the same fact vector — a confirmed adverse analytical finding concurrent with a whereabouts violation, for example — and a function returning one outcome must choose. The implementation promotes the process-invalidation row to a precondition guard, on the principle that no regulatory consequence may be derived from an unverified chain of custody, which is precisely the failure mode the framework exists to prevent, and orders the remaining rules by statutory urgency. Lower-precedence matches are retained in the record rather than discarded. Second, the table covered laboratory accreditation states verified and pending but not an affirmative unverified. A result reported by a laboratory that is not accredited cannot support an adverse analytical finding under Article 6.1, so the implementation rejects and audits it rather than queueing it for human review. Both refinements are reported here as findings of the implementation process; Table 1 is the corrected table, with the two rows added during implementation marked.

## Architectural claims that the network enforces

Two properties previously asserted by design are enforced behaviour of the deployed network. A transaction that attempts to alter committed results-management state with endorsement from a single organisational class is rejected at validation with an endorsement-policy failure, because the chaincode binds such state to a key-level policy naming peers from two distinct organisational classes. The mitigation against insider collusion across certification-authority boundaries is therefore a property the test suite fails on if it ceases to hold, rather than a design claim. Likewise, purpose-limited access control releases two of six biological data categories to a researcher authorised for a cardiovascular study and refuses the biochemical, steroidal, psychological and genetic categories, each refusal carrying its own recorded reason and article.

## What a single benchmark round can support

{{RESULTS_STATE_PARA_1}}

{{RESULTS_STATE_PARA_2}}

## Throughput and latency by regulatory operation

{{RESULTS_THROUGHPUT_PARA}}

{{RESULTS_LATENCY_PARA}}

## The cost of cross-organisational endorsement

{{RESULTS_ENDORSEMENT_PARA}}

## Where the processor time goes, and what the guarantees cost

{{RESULTS_RESOURCE_PARA}}

{{RESULTS_BASELINE_PARA}}

## Whether the driver or the network bounded the measurement

{{RESULTS_DRIVER_PARA}}

## Comparison with operational demand

{{RESULTS_DEMAND_PARA}}

# DISCUSSION

Two structural failures in the governance of elite-sport biological data motivated this work, and the implementation speaks to both. Anti-doping custody records currently reside in mutable centralised databases without cryptographic integrity protection, a vulnerability exploited at institutional scale in the manipulation documented by McLaren^4^; in the deployed network every custody event is a multi-organisation-endorsed transaction whose retroactive alteration produces a hash inconsistency visible to every participant holding a ledger copy. Athlete biological data cross institutional boundaries without granular consent, purpose-limitation enforcement or technical instruments for exercising data subject rights^5,15^; in the deployed network the default state of a newly registered athlete is that nothing is shared with anyone, every access evaluation writes an audit record whether or not data is released, and only the athlete organisation may create, amend or withdraw consent over an athlete's own data. Baekken et al. reported gaps in documentation completeness across ten years of Athlete Biological Passport collection at a national anti-doping organisation^48^, and Krumm et al. identified the integrity of the longitudinal data chain as the determinant of whether proposed new passport modules will be statistically and legally robust^49^ — both are properties that multi-party-endorsed custody recording addresses directly rather than procedurally.

The finding we consider most transferable is not about blockchain at all. Formalising a regulatory instrument as a pure, total function forced the resolution of two questions the prose specification had left open, and exhaustive enumeration of the resulting 192-vector condition space is what made the resolution checkable. Any regulatory decision procedure intended for automated execution is subject to the same discipline, and any that has not been through it should be assumed to contain the same class of gap. Prior work on encoding clinical and regulatory logic as computable structures^12,31^ established that the translation is feasible; what the present work adds is that the translation is also diagnostic of the source instrument. We note that both gaps were found in our own formalisation of the WADA Code, not in a WADA instrument; the Code itself specifies the substantive rules, and it is the reduction of those rules to a table that must be made complete before it can execute.

That argument has an immediate test. The framework formalises the 2021 Code^3^, which was in force throughout this work, but the 2027 Code and its International Standards were approved in December 2025 and take effect on 1 January 2027^56^. Among the revisions is a change to how fault is assessed for whereabouts failures — the provision behind rule R4 of Table 1 — so the decision table this paper reports will require amendment rather than merely re-dating. We regard that as a demonstration of the approach rather than an embarrassment to it. A prose table absorbs a revision silently, revealing nothing about which downstream conclusions have changed; an executable one cannot. Re-running the 192-vector enumeration against the amended rules returns a diff over the complete condition space, identifying every fact vector whose outcome the revision changes and every rule it leaves unreachable or newly undefined. Contract modules encoding a regulatory instrument are living artefacts on the Code's revision cycle, and the verification apparatus reported here is what makes each revision auditable rather than merely applied^31^.

{{DISC_MEASUREMENT_PARA}}

Several limitations bound what these figures support. {{DISC_LIMITS_OPENING}} {{DISC_DRIVER_CAVEAT}} Resource attribution rests on sampling with a monitoring tool that itself consumes host capacity, so the sampled round's own throughput is lower than the unsampled figure and is reported for proportions only. The centralised control arm quantifies the cost of the governance guarantees against a single unreplicated writer on the same host and the same storage engine, but it is not a production database deployment and the comparison should be read as an order-of-magnitude bound rather than a benchmark of either system. No embedded-state-database counterfactual was run, so the attribution of cost to CouchDB is supported by resource sampling and not by a controlled substitution. Key material is held in process memory rather than in a hardware security module, so the implementation demonstrates the erasure mechanism rather than production key custody. Penetration testing of the application tier, and a comparative evaluation against ADAMS-based manual workflows, were not performed and are not claimed.

The legal position of the erasure mechanism is unresolved and we do not claim otherwise. Destroying the data-encryption key and unpinning the ciphertext renders athlete data permanently inaccessible without rewriting the ledger, which is the only construction compatible with an append-only log, but European supervisory authorities have not confirmed that cryptographic inaccessibility satisfies Article 17 as a literal matter. The framework is accordingly designed to satisfy the Article rather than certified as compliant with it, and zero-knowledge proof integration is the immediate technical direction for eliminating the residual on-chain pseudonymous metadata on which the remaining tension turns.

The barriers to adoption are organisational at least as much as technical. WADA, national anti-doping organisations, federations and laboratories have built a decade of workflow around ADAMS, and a distributed model requires trust-building among organisations with competitive tensions that no technical design resolves. Infrastructure and personnel costs will fall unevenly on national organisations, which a shared-infrastructure model could mitigate; the modular contract design lowers the threshold further, since components can be adopted singly^33^. Experience with electronic health record adoption confirms that technical quality does not produce uptake without parallel investment in user education^50^. The athlete-facing interface, specified here only at the architectural level, must be usable across languages and levels of technical literacy.

The next steps follow from the measurements rather than from the architecture: provisioned multi-host measurement before any claim of headroom for continental deployment; controlled substitution rather than attribution for the state database; a Byzantine fault-tolerant ordering configuration for the part of the insider threat model Raft does not address; hardware security module integration for production key custody; and a pilot with a willing national anti-doping organisation, which is the only way to surface operational failure modes a laboratory deployment cannot. Automated anomaly detection over the audit trail is a natural extension, and the retrieval-augmented clinical entity recognition pipelines demonstrated by Abdaoui et al. offer a directly transferable method, since an audit trail of custody events is a sequence-labelling problem of the same shape as the clinical report pipelines that work addressed^53^.

# METHODS

{{METHODS}}

# DATA AVAILABILITY
No human-subject data were generated or analysed in this study; all athlete records used in testing, verification and benchmarking are synthetic. The datasets generated during the current study — the raw Hyperledger Caliper output of every benchmark replicate, the aggregated summary from which Table 2 and Fig. 5 are drawn, the resource-attribution samples, the centralised control-arm output, the driver-saturation control output, and the recorded outcome of each of the thirteen executed scenarios in Supplementary Table S3 — are archived at Zenodo under {{ZENODO_DOI}} and are also available in the repository given under Code availability.

# CODE AVAILABILITY
The reference implementation is openly available: the containerised network definition, both chaincodes, the off-chain storage and erasure layer, the FHIR adapter, the REST gateway, the verification suite, the executable scenarios and the complete Hyperledger Caliper benchmark configuration and workload modules, together with the scripts that regenerate every table and figure reported here from the measured output. The archived version of record is deposited at Zenodo under {{ZENODO_DOI}}; development continues at {{REPO_URL}}. All results reported in this article are reproducible from the archived release with the documented command sequence.

# AUTHOR CONTRIBUTIONS
I.D. and H.B.R. conceived the study. I.D., S.B., C.B. and H.B.R. designed the methodology. S.B. implemented the reference system, the verification suite and the measurement pipeline. I.D., S.B., N.L.B. and H.B.R. performed the formal analysis. H.İ.C., V.S., R.I.M., N.L.B. and H.B.R. conducted the investigation. I.D., S.B. and C.B. wrote the original draft. All authors reviewed and edited the manuscript. H.B.R. and H.İ.C. supervised the work. All authors read and approved the final manuscript.

# ACKNOWLEDGEMENTS
This research received no external funding.

# ADDITIONAL INFORMATION
**Competing interests** The authors declare no competing interests.

