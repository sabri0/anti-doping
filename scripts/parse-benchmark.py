#!/usr/bin/env python3
"""Parse a Caliper run log into machine-readable results.

The manuscript's evaluation tables are generated from this JSON rather than
transcribed by hand, so a re-run regenerates the paper's numbers and no figure
can drift from the measurement that produced it.

Usage:  python scripts/parse-benchmark.py <caliper.log> [-o docs/benchmark-results.json]
"""

import argparse
import json
import pathlib
import re
import sys

# | label | succ | fail | send rate | max lat | min lat | avg lat | throughput |
ROW = re.compile(
    r"^\|\s*([A-Za-z][\w.-]*)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|"
    r"\s*([\d.]+|-)\s*\|\s*([\d.]+|-)\s*\|\s*([\d.]+|-)\s*\|\s*([\d.]+)\s*\|$"
)

RESOURCE = re.compile(r"^\|\s*(\S+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|", re.M)


def num(value: str):
    return None if value == "-" else float(value)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("log", type=pathlib.Path)
    ap.add_argument("-o", "--out", type=pathlib.Path, default=pathlib.Path("docs/benchmark-results.json"))
    args = ap.parse_args()

    if not args.log.exists():
        sys.exit(f"no such log: {args.log}")

    rounds: dict[str, dict] = {}
    for line in args.log.read_text(encoding="utf8", errors="replace").splitlines():
        m = ROW.match(line.strip())
        if not m:
            continue
        label, succ, fail, send, mx, mn, avg, tput = m.groups()
        if label.lower() == "name":
            continue
        # Caliper prints a per-round table and then a final summary; the values
        # are identical, so last-write-wins is safe and keeps the summary form.
        rounds[label] = {
            "label": label,
            "successful": int(succ),
            "failed": int(fail),
            "sendRateTps": float(send),
            "maxLatencyS": num(mx),
            "minLatencyS": num(mn),
            "avgLatencyS": num(avg),
            "throughputTps": float(tput),
        }

    if not rounds:
        sys.exit("no result rows found - did the benchmark complete?")

    failed = {k: v for k, v in rounds.items() if v["failed"] > 0}
    total_ok = sum(r["successful"] for r in rounds.values())
    total_bad = sum(r["failed"] for r in rounds.values())

    out = {
        "rounds": rounds,
        "totals": {
            "rounds": len(rounds),
            "successfulTransactions": total_ok,
            "failedTransactions": total_bad,
            "roundsWithFailures": sorted(failed),
        },
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2), encoding="utf8")

    print(f"{len(rounds)} rounds -> {args.out}")
    print(f"{total_ok} successful, {total_bad} failed transactions")
    if failed:
        # A round with failures cannot be reported as a throughput measurement.
        print("WARNING: rounds with failed transactions:", ", ".join(sorted(failed)))
    print()
    print(f"{'round':38s} {'succ':>6s} {'fail':>5s} {'send':>7s} {'tput':>7s} {'avg lat':>8s} {'max lat':>8s}")
    for label, r in rounds.items():
        avg = f"{r['avgLatencyS']:.2f}" if r["avgLatencyS"] is not None else "-"
        mx = f"{r['maxLatencyS']:.2f}" if r["maxLatencyS"] is not None else "-"
        print(
            f"{label:38s} {r['successful']:6d} {r['failed']:5d} "
            f"{r['sendRateTps']:7.1f} {r['throughputTps']:7.1f} {avg:>8s} {mx:>8s}"
        )


if __name__ == "__main__":
    main()
