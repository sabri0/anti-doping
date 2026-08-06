#!/usr/bin/env python3
"""Aggregate several independent benchmark runs into one summary with variability.

A single Caliper round reports one number per metric. One number cannot be
distinguished from noise, so every round is executed n times against the same
deployed network and summarised here as mean, standard deviation and range.

Reads N files produced by parse-benchmark.py and writes a single JSON in which
each round carries n, mean, sd, min and max for throughput, mean latency and
the *achieved* send rate. The achieved send rate is carried because it is the
evidence for whether the load driver, rather than the network, was the binding
constraint: if achieved send rate tracks the configured rate, the network
saturated; if it plateaus below it, the driver may have.

Usage:
    python scripts/aggregate-replicates.py runs/results-r1.json runs/results-r2.json \
        runs/results-r3.json -o docs/benchmark-summary.json
"""

import argparse
import json
import pathlib
import statistics

METRICS = ("throughputTps", "avgLatencyS", "sendRateTps", "maxLatencyS", "minLatencyS")


def summarise(values):
    """Summary of one metric across replicates: n, mean, sd, min, max."""
    n = len(values)
    return {
        "n": n,
        "mean": round(statistics.mean(values), 2),
        "sd": round(statistics.stdev(values), 2) if n > 1 else None,
        "min": round(min(values), 2),
        "max": round(max(values), 2),
        "values": [round(v, 2) for v in values],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results", nargs="+", type=pathlib.Path)
    ap.add_argument("-o", "--out", type=pathlib.Path,
                    default=pathlib.Path("docs/benchmark-summary.json"))
    args = ap.parse_args()

    runs = [json.loads(p.read_text(encoding="utf8")) for p in args.results]

    labels = [lbl for lbl in runs[0]["rounds"]
              if all(lbl in r["rounds"] for r in runs)]
    dropped = sorted({lbl for r in runs for lbl in r["rounds"]} - set(labels))

    rounds = {}
    for lbl in labels:
        entry = {"label": lbl}
        for metric in METRICS:
            entry[metric] = summarise([r["rounds"][lbl][metric] for r in runs])
        entry["successful"] = [r["rounds"][lbl]["successful"] for r in runs]
        entry["failed"] = [r["rounds"][lbl]["failed"] for r in runs]
        rounds[lbl] = entry

    # Endorsement cost: the difference the manuscript's integrity claim rests on.
    endorsement = None
    one, two = "endorse-1org-initiateSampleCustody", "endorse-2org-initiateSampleCustody"
    if one in rounds and two in rounds:
        a = rounds[one]["throughputTps"]["values"]
        b = rounds[two]["throughputTps"]["values"]
        mean_a, mean_b = statistics.mean(a), statistics.mean(b)
        # Paired by replicate: run i of both arms shares a host state.
        deltas = [(x - y) / x * 100 for x, y in zip(a, b)]
        endorsement = {
            "n": len(a),
            "oneOrgTps": summarise(a),
            "twoOrgTps": summarise(b),
            "meanReductionPercent": round((mean_a - mean_b) / mean_a * 100, 1),
            "pairedReductionPercent": summarise(deltas),
            "overlap": max(b) >= min(a),
        }

    total_tx = sum(sum(rounds[lbl]["successful"]) for lbl in labels)
    total_fail = sum(sum(rounds[lbl]["failed"]) for lbl in labels)

    out = {
        "replicates": len(runs),
        "sources": [str(p) for p in args.results],
        "roundsCompared": len(labels),
        "roundsDropped": dropped,
        "totals": {"successfulTransactions": total_tx, "failedTransactions": total_fail},
        "endorsementCost": endorsement,
        "rounds": rounds,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2), encoding="utf8")
    print(f"[aggregate] {len(runs)} replicates, {len(labels)} rounds -> {args.out}")
    if dropped:
        print(f"[aggregate] rounds missing from at least one replicate: {dropped}")
    if endorsement:
        print(f"[aggregate] endorsement cost: {endorsement['meanReductionPercent']}% "
              f"(arms overlap: {endorsement['overlap']})")


if __name__ == "__main__":
    main()
