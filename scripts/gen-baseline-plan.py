#!/usr/bin/env python3
"""Measurement plan for the two baselines, on the ledger's round protocol:
the same 15 s warm-up and 30 s window, the same concurrency sweep for the
custody-initiation write, the same 2 transactions-per-second open-loop latency
round, three blocks in a seeded random order with sentinel rounds."""

import argparse
import json
import random

WARMUP, DURATION = 15, 30
SWEEP = [4, 8, 16, 32, 64, 128, 256]
TARGETS = {"baseline-telog": "http://baseline-telog:8080", "baseline-couchdb": "http://baseline-couchdb:5984/custody"}

ap = argparse.ArgumentParser()
ap.add_argument("--seed", type=int, default=31)
ap.add_argument("--blocks", type=int, default=3)
ap.add_argument("--out", required=True)
a = ap.parse_args()
rng = random.Random(a.seed)

rounds = []
for b in range(1, a.blocks + 1):
    body = []
    for w, target in TARGETS.items():
        for c in SWEEP:
            body.append({"id": f"b{b}-{w}-c{c}", "workload": w, "target": target, "block": b, "kind": "sweep",
                         "concurrency": c, "warmup": WARMUP, "duration": DURATION})
        body.append({"id": f"b{b}-{w}-lat", "workload": w, "target": target, "block": b, "kind": "latency",
                     "tps": 2, "warmup": WARMUP, "duration": DURATION})
    rng.shuffle(body)
    rounds.extend(body)

json.dump({"name": "baselines", "configuration": {"id": "baselines", "seed": a.seed}, "rounds": rounds},
          open(a.out, "w", encoding="utf-8", newline="\n"), indent=1)
print(f"{a.out}: {len(rounds)} rounds")
