#!/usr/bin/env python3
"""Turn the measurement outputs into the scalar values the manuscript quotes.

Reads the aggregated benchmark summary and the control-arm outputs and writes
numbers_auto.json, which the builder merges with the hand-written prose in
prose.json. Nothing in the manuscript's quantitative claims is typed by hand:
re-run the measurements, re-run this, and every figure in the text moves with
them.

Usage:
    python fill_numbers.py --repo D:/blockchainIsmail/antidoping-chain
"""

import argparse
import json
import pathlib

OPERATION_LABELS = [
    ("endorse-1org-initiateSampleCustody",
     "initiateSampleCustody (WADA Art. 5.3), single-organisation endorsement", "Write"),
    ("endorse-2org-initiateSampleCustody",
     "initiateSampleCustody (WADA Art. 5.3), two-organisation endorsement", "Write"),
    ("recordCustodyTransfer", "recordCustodyTransfer (WADA Art. 5.4)", "Write"),
    ("recordSampleAnalysisResult", "recordSampleAnalysisResult (WADA Art. 2.1)", "Write"),
    ("triggerResultsManagement", "triggerResultsManagement (WADA Art. 7.1)", "Write"),
    ("validateConsent", "validateConsent (GDPR Art. 7), six categories", "Write"),
    ("evaluateDecisionTable", "evaluateDecisionTable (Table 1 logic only)", "Read"),
    ("previewConsentDecision", "previewConsentDecision (GDPR Art. 7)", "Read"),
    ("getCustodyChain", "getCustodyChain (provenance query)", "Read"),
]

WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}


def rng(s, unit=""):
    """mean (min–max) with the unit attached once."""
    if s["min"] == s["max"]:
        return f"{s['mean']:.1f}{unit}"
    return f"{s['mean']:.1f}{unit} ({s['min']:.1f}–{s['max']:.1f})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=pathlib.Path, required=True)
    ap.add_argument("--phase1", type=pathlib.Path, nargs="*", default=[],
                    help="the sequential-pass results, for the ratio quoted in Methods")
    ap.add_argument("-o", "--out", type=pathlib.Path,
                    default=pathlib.Path(__file__).with_name("numbers_auto.json"))
    args = ap.parse_args()

    docs = args.repo / "docs"
    summary = json.loads((docs / "benchmark-summary.json").read_text(encoding="utf8"))
    R = summary["rounds"]
    n = summary["replicates"]

    def load(name):
        path = docs / name
        return json.loads(path.read_text(encoding="utf8")) if path.exists() else None

    resources = load("resource-metrics.json")
    baseline = load("baseline-results.json")
    driver = load("driver-control.json")
    controls = load("controls-analysis.json") or {}

    out = {}

    # ---- the sequential passes that prompted the state hypothesis -----------
    if args.phase1:
        passes = [json.loads(p.read_text(encoding="utf8"))["rounds"] for p in args.phase1]
        key = "sweep-100tps"
        if all(key in p for p in passes):
            values = [p[key]["throughputTps"] for p in passes]
            out["PHASE1_FACTOR"] = f"{max(values) / min(values):.1f}"
            out["PHASE1_VALUES"] = ", ".join(f"{v:.1f}" for v in values)

    # ---- between-round variation, and the rejected state hypothesis ---------
    state = controls.get("stateScaling")
    if state:
        out["STATE_N"] = str(state["rounds"])
        out["STATE_MIN"] = f"{state['minTps']:.1f}"
        out["STATE_MAX"] = f"{state['maxTps']:.1f}"
        out["STATE_MEDIAN"] = f"{state['medianTps']:.1f}"
        out["STATE_CV"] = f"{state['cvPercent']:.0f}"
        out["STATE_RATIO"] = f"{state['maxOverMin']:.1f}"
        out["STATE_TOTAL"] = f"{state['totalSamplesWritten']:,}"
        out["STATE_R"] = f"{state['correlationWithRoundIndex']:.2f}"
        out["STATE_FIRST3"] = f"{state['firstThreeMeanTps']:.1f}"
        out["STATE_LAST3"] = f"{state['lastThreeMeanTps']:.1f}"

    # ---- endorsement cost, measured within pairs ----------------------------
    paired = controls.get("endorsementPaired")
    if paired and paired.get("pairs"):
        out["PAIRED_N"] = WORDS.get(paired["pairs"], str(paired["pairs"]))
        out["PAIRED_1ORG"] = f"{paired['oneOrgTpsMean']:.1f}"
        out["PAIRED_2ORG"] = f"{paired['twoOrgTpsMean']:.1f}"
        out["PAIRED_PCT"] = f"{paired['pairedReductionPercentMean']:.0f}"
        lo, hi = paired["pairedReductionPercentRange"]
        out["PAIRED_PCT_RANGE"] = f"{lo:.0f}–{hi:.0f}"
        out["PAIRED_DRIFT"] = f"{abs(paired['driftAcrossPairsPercent']):.1f}"
        out["PAIRED_EXCLUDED"] = str(len(paired.get("excludedPairs", [])))

    # ---- headline throughput -------------------------------------------------
    writes = [lbl for lbl, _, kind in OPERATION_LABELS if kind == "Write" and lbl in R]
    reads = [lbl for lbl, _, kind in OPERATION_LABELS if kind == "Read" and lbl in R]
    sweep_peak = max((R[l]["throughputTps"] for l in R if l.startswith("sweep-")),
                     key=lambda s: s["mean"])
    out["SAT_TPS"] = f"{sweep_peak['mean']:.1f}"
    out["SAT_TPS_RANGE"] = rng(sweep_peak)
    out["WRITE_MIN"] = f"{min(R[l]['throughputTps']['mean'] for l in writes):.1f}"
    out["WRITE_MAX"] = f"{max(R[l]['throughputTps']['mean'] for l in writes):.1f}"
    out["READ_MAX"] = f"{max(R[l]['throughputTps']['mean'] for l in reads):.0f}"
    out["N_REPLICATES"] = WORDS.get(n, str(n))
    out["N_REPLICATES_NUM"] = str(n)
    out["TOTAL_TX"] = f"{summary['totals']['successfulTransactions']:,}"
    out["TOTAL_FAILED"] = ("no" if summary["totals"]["failedTransactions"] == 0
                           else str(summary["totals"]["failedTransactions"]))

    # ---- endorsement cost ----------------------------------------------------
    e = summary.get("endorsementCost")
    if e:
        out["ENDORSE_1"] = rng(e["oneOrgTps"])
        out["ENDORSE_2"] = rng(e["twoOrgTps"])
        out["ENDORSE_PCT"] = f"{e['meanReductionPercent']:.0f}"
        out["ENDORSE_PAIRED"] = rng(e["pairedReductionPercent"], "%")
        out["ENDORSE_OVERLAP"] = "yes" if e["overlap"] else "no"

    # ---- latency -------------------------------------------------------------
    if "sweep-10tps" in R:
        out["SUBSAT_LAT"] = rng(R["sweep-10tps"]["avgLatencyS"], " s")
        out["SUBSAT_TPS"] = rng(R["sweep-10tps"]["throughputTps"])
    if "sweep-100tps" in R:
        out["SAT_LAT"] = rng(R["sweep-100tps"]["avgLatencyS"], " s")
        out["SAT_ACHIEVED"] = rng(R["sweep-100tps"]["sendRateTps"])
    out["BATCH_TIMEOUT"] = "two"

    # ---- resource attribution ------------------------------------------------
    if resources:
        by = resources["byComponent"]
        out["RES_N"] = str(resources["samples"])
        out["RES_INTERVAL"] = str(int(resources["intervalSeconds"]))
        for key, token in (("couchdb", "COUCH"), ("peers", "PEER"),
                           ("orderer", "ORDER"), ("ipfs", "IPFS")):
            if key in by:
                out[f"{token}_PCT"] = f"{by[key]['shareOfLoadPercent']:.0f}"
                out[f"{token}_CPU"] = f"{by[key]['cpuPercentMean']:.0f}"
        out["HOST_UTIL"] = f"{resources['hostUtilisationPercentMean']:.0f}"
        if "driver" in by:
            out["DRIVER_PCT"] = f"{by['driver']['shareOfLoadPercent']:.0f}"
        if "couchdb" in by and "peers" in by and by["peers"]["shareOfLoadPercent"]:
            ratio = by["couchdb"]["shareOfLoadPercent"] / by["peers"]["shareOfLoadPercent"]
            out["COUCH_PEER_RATIO"] = f"{ratio:.1f}"

    # ---- centralised control arm --------------------------------------------
    if baseline:
        tps = [r["throughputTps"] for r in baseline]
        lat = [r["avgLatencyS"] for r in baseline]
        mean_tps = sum(tps) / len(tps)
        out["BASE_TPS"] = f"{mean_tps:.1f} ({min(tps):.1f}–{max(tps):.1f})"
        out["BASE_TPS_MEAN"] = f"{mean_tps:.1f}"
        out["BASE_LAT"] = f"{sum(lat) / len(lat):.2f}"
        out["BASE_N"] = WORDS.get(len(tps), str(len(tps)))
        one_org = R.get("endorse-1org-initiateSampleCustody", {}).get("throughputTps")
        if one_org:
            out["BASE_FACTOR"] = f"{mean_tps / one_org['mean']:.1f}"

    # ---- driver-saturation control ------------------------------------------
    if driver:
        d = driver["rounds"]
        parts = []
        for label in ("sweep-50tps-w6", "sweep-100tps-w6", "sweep-200tps-w6"):
            if label in d:
                cfg = label.split("-")[1].replace("tps", "")
                parts.append(
                    f"{cfg} configured: {d[label]['sendRateTps']:.1f} offered, "
                    f"{d[label]['throughputTps']:.1f} committed")
        out["DRIVER_POINTS"] = "; ".join(parts)
        best = max(d.values(), key=lambda r: r["sendRateTps"])
        out["DRIVER_MAX_OFFERED"] = f"{best['sendRateTps']:.1f}"
        out["DRIVER_MAX_TPUT"] = f"{max(r['throughputTps'] for r in d.values()):.1f}"

    # ---- operational demand reference ---------------------------------------
    samples, hours = 330_000, 8_760
    for t, token in ((30, "HIGH"), (6, "LOW")):
        out[f"DEMAND_{token}"] = f"{samples * t * 0.01 / 3600:.1f}"
    out["DEMAND_MEAN"] = f"{samples * 30 / (365 * 24 * 3600):.2f}"
    out["PEAK_FACTOR"] = f"{0.01 * hours:.0f}"

    # ---- Table 2 rows --------------------------------------------------------
    rows = []
    for label, name, kind in OPERATION_LABELS:
        if label not in R:
            continue
        r = R[label]
        rows.append([
            name, kind,
            rng(r["throughputTps"]),
            rng(r["avgLatencyS"]),
            str(r["successful"][0]),
        ])
    out["T2_ROWS"] = rows

    args.out.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf8")
    print(f"wrote {args.out} with {len(out)} values\n")
    for k, v in out.items():
        if k != "T2_ROWS":
            print(f"  {k:22s} {v}")


if __name__ == "__main__":
    main()
