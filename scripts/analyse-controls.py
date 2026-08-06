#!/usr/bin/env python3
"""Analyse the state-scaling rounds and the paired endorsement experiment.

Two questions the main suite cannot answer.

1. Does committed write throughput fall as the state database grows? Twelve
   identical rounds differ only in how much has already been written, so the
   correlation of throughput with round index tests the hypothesis directly. A
   real dependence must appear as a strong negative correlation. The same twelve
   rounds also measure the between-round variation of the deployment, which is
   the distribution any single-round figure is one draw from.

2. What does cross-organisational endorsement cost, once that variation is
   accounted for? The paired rounds alternate the two endorsement policies, so
   the members of a pair are adjacent in time and the difference is taken within
   pairs rather than between two means measured at different moments.

Usage:
    python scripts/analyse-controls.py -o docs/controls-analysis.json
"""

import argparse
import json
import pathlib
import statistics

ROUND_TX = 600  # transactions per state-scaling round


def load(path):
    p = pathlib.Path(path)
    return json.loads(p.read_text(encoding="utf8")) if p.exists() else None


def pearson(a, b):
    ma, mb = statistics.mean(a), statistics.mean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    den = (sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b)) ** 0.5
    return num / den if den else None


def analyse_state(scaling):
    """Throughput across identical rounds: is it explained by accumulated state?

    Two quantities decide it. The correlation of throughput with round index is
    the test of the state hypothesis — a real dependence on how much the ledger
    holds must show as a strong negative correlation. The spread across the same
    rounds is the between-round variation of the deployment, which is what any
    single-round figure is a single draw from.
    """
    rounds = [(label, r) for label, r in scaling["rounds"].items()
              if label.startswith("state-")]
    rounds.sort(key=lambda kv: kv[0])
    if not rounds:
        return None

    series = []
    cumulative = 0
    for label, r in rounds:
        series.append({
            "round": label,
            "samplesBefore": cumulative,
            "throughputTps": r["throughputTps"],
            "sendRateTps": r["sendRateTps"],
            "avgLatencyS": r["avgLatencyS"],
        })
        cumulative += r["successful"]

    tps = [s["throughputTps"] for s in series]
    index = list(range(1, len(tps) + 1))
    first3, last3 = statistics.mean(tps[:3]), statistics.mean(tps[-3:])

    return {
        "rounds": len(series),
        "txPerRound": ROUND_TX,
        "totalSamplesWritten": cumulative,
        "medianTps": round(statistics.median(tps), 1),
        "meanTps": round(statistics.mean(tps), 1),
        "sdTps": round(statistics.stdev(tps), 1),
        "cvPercent": round(100 * statistics.stdev(tps) / statistics.mean(tps), 1),
        "minTps": round(min(tps), 1),
        "maxTps": round(max(tps), 1),
        "maxOverMin": round(max(tps) / min(tps), 2),
        "firstThreeMeanTps": round(first3, 1),
        "lastThreeMeanTps": round(last3, 1),
        # The test: a genuine state dependence is a strong negative correlation.
        "correlationWithRoundIndex": round(pearson(tps, index), 3),
        "correlationWithLatency": round(pearson(tps, [s["avgLatencyS"] for s in series]), 3),
        "stateHypothesisSupported": pearson(tps, index) < -0.6,
        "series": series,
    }


def analyse_paired(paired):
    """Within-pair cost of two-organisation endorsement.

    A pair is excluded when either arm's mean latency exceeds five times the
    median across all rounds. That happens when a round runs while the state
    databases are still absorbing a preceding write phase — one such round
    returned 0.3 transactions per second at a mean latency of nineteen minutes —
    and it measures recovery rather than endorsement. The exclusion rule is
    stated in advance and applied to whole pairs, never to one arm of one.
    """
    rounds = paired["rounds"]
    measured = {k: v for k, v in rounds.items() if k.startswith("paired-")
                and not k.startswith("paired-warmup")}
    if not measured:
        return None
    median_latency = statistics.median(r["avgLatencyS"] for r in measured.values())
    ceiling = median_latency * 5

    pairs, excluded = [], []
    for suffix in "abcdefgh":
        one, two = f"paired-1org-{suffix}", f"paired-2org-{suffix}"
        if one not in rounds or two not in rounds:
            continue
        la, lb = rounds[one]["avgLatencyS"], rounds[two]["avgLatencyS"]
        a, b = rounds[one]["throughputTps"], rounds[two]["throughputTps"]
        if la > ceiling or lb > ceiling:
            excluded.append({"pair": suffix, "oneOrgLatencyS": la, "twoOrgLatencyS": lb,
                             "reason": f"latency above {ceiling:.1f} s, five times the median"})
            continue
        pairs.append({
            "pair": suffix,
            "oneOrgTps": a,
            "twoOrgTps": b,
            "reductionPercent": round((a - b) / a * 100, 1) if a else None,
            "oneOrgLatencyS": la,
            "twoOrgLatencyS": lb,
        })
    if not pairs:
        return {"pairs": 0, "excludedPairs": excluded}

    deltas = [p["reductionPercent"] for p in pairs]
    ones = [p["oneOrgTps"] for p in pairs]
    twos = [p["twoOrgTps"] for p in pairs]
    return {
        "pairs": len(pairs),
        "excludedPairs": excluded,
        "oneOrgTpsMean": round(statistics.mean(ones), 1),
        "oneOrgTpsRange": [round(min(ones), 1), round(max(ones), 1)],
        "twoOrgTpsMean": round(statistics.mean(twos), 1),
        "twoOrgTpsRange": [round(min(twos), 1), round(max(twos), 1)],
        "pairedReductionPercentMean": round(statistics.mean(deltas), 1),
        "pairedReductionPercentRange": [min(deltas), max(deltas)],
        "sameSign": all(d > 0 for d in deltas) or all(d < 0 for d in deltas),
        # Drift across the experiment: if the one-organisation arm itself moves
        # between the first and last pair, the pairing was doing real work.
        "driftAcrossPairsPercent": round((ones[0] - ones[-1]) / ones[0] * 100, 1),
        "detail": pairs,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", type=pathlib.Path, default=pathlib.Path("docs"))
    ap.add_argument("-o", "--out", type=pathlib.Path,
                    default=pathlib.Path("docs/controls-analysis.json"))
    args = ap.parse_args()

    scaling = load(args.docs / "state-scaling.json")
    paired = load(args.docs / "endorsement-paired.json")

    out = {
        "stateScaling": analyse_state(scaling) if scaling else None,
        "endorsementPaired": analyse_paired(paired) if paired else None,
    }
    args.out.write_text(json.dumps(out, indent=2), encoding="utf8")
    print(f"[controls] -> {args.out}")
    if out["stateScaling"]:
        s = out["stateScaling"]
        print(f"  state scaling: n={s['rounds']} identical rounds, median {s['medianTps']} TPS, "
              f"range {s['minTps']}-{s['maxTps']} ({s['maxOverMin']}x), CV {s['cvPercent']}%")
        print(f"    first three {s['firstThreeMeanTps']} vs last three {s['lastThreeMeanTps']} TPS; "
              f"correlation with round index {s['correlationWithRoundIndex']} -> "
              f"state hypothesis supported: {s['stateHypothesisSupported']}")
    if out["endorsementPaired"]:
        e = out["endorsementPaired"]
        if not e.get("pairs"):
            print(f"  endorsement: no usable pairs; excluded {e.get('excludedPairs')}")
        else:
            print(f"  endorsement: n={e['pairs']} pairs, {e['oneOrgTpsMean']} vs "
                  f"{e['twoOrgTpsMean']} TPS, paired reduction "
                  f"{e['pairedReductionPercentMean']}% "
                  f"(range {e['pairedReductionPercentRange']}, "
                  f"consistent sign: {e['sameSign']}, "
                  f"drift across pairs {e['driftAcrossPairsPercent']}%)")
            if e["excludedPairs"]:
                print(f"    excluded: {[x['pair'] for x in e['excludedPairs']]}")


if __name__ == "__main__":
    main()
