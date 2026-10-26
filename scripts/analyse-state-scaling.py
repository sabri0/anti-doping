#!/usr/bin/env python3
"""Serial-dependence diagnostics for the twelve identical rounds of the first
evaluation (docs/state-scaling.json), in response to review.

Computes the lag-1 autocorrelation of the round throughputs with a
permutation test, and the share of variance explained by linear and quadratic
trends in round index. If the rounds were independent draws, neither would
differ from what shuffling produces.
"""
import json, random, statistics, pathlib
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
d = json.loads((ROOT / "docs/archive-cycle1/state-scaling.json").read_text())
xs = [d["rounds"][k]["throughputTps"] for k in sorted(d["rounds"])]
n = len(xs)

def lag1(v):
    m = statistics.mean(v)
    num = sum((v[i] - m) * (v[i + 1] - m) for i in range(len(v) - 1))
    den = sum((x - m) ** 2 for x in v)
    return num / den

r1 = lag1(xs)
rng = random.Random(2026)
perm = [lag1(rng.sample(xs, n)) for _ in range(100000)]
p = sum(1 for v in perm if v >= r1) / len(perm)
t = np.arange(1, n + 1)
def r2(deg):
    coef = np.polyfit(t, xs, deg)
    fit = np.polyval(coef, t)
    ss_res = float(np.sum((np.array(xs) - fit) ** 2))
    ss_tot = float(np.sum((np.array(xs) - np.mean(xs)) ** 2))
    return 1 - ss_res / ss_tot
out = {
    "throughputs": xs, "n": n,
    "mean": statistics.mean(xs), "median": statistics.median(xs),
    "cvPct": 100 * statistics.stdev(xs) / statistics.mean(xs),
    "lag1Autocorrelation": r1, "permutationP": p, "permutations": len(perm),
    "linearTrendR2": r2(1), "quadraticTrendR2": r2(2),
}
(ROOT / "docs/state-scaling-diagnostics.json").write_text(json.dumps(out, indent=1))
print(json.dumps(out, indent=1))
