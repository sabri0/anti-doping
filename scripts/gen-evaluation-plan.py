#!/usr/bin/env python3
"""Generate the measurement plan for one network configuration.

The plan answers three questions with three kinds of round, every round a
fixed 15-second warm-up followed by a fixed 30-second measured window:

  capacity    closed-loop rounds (a fixed number of outstanding transactions);
              committed throughput at a concurrency that saturates the network
              is what it sustains without building a backlog. Custody
              initiation is swept over concurrency 4..64 to show where the
              plateau begins.
  latency     open-loop rounds at an offered rate well below saturation in
              every configuration (OPEN_TPS), reporting end-to-end latency
              percentiles that are not queueing delay.
  endorsement paired one- versus two-organisation endorsement of the same
              transaction, adjacent in time, in counterbalanced order
              (ABBA BAAB ABBA), so a linear drift cancels within each block.

Capacity and latency rounds are repeated in three blocks. Within a block the
order is randomised (seeded, so the plan is reproducible), and every block
opens and closes with the same sentinel round, so drift across the run is
measured rather than assumed away.

Usage:
    python scripts/gen-evaluation-plan.py --config K1 --expect 6 --seed 1 \
        --out driver/plans/K1.json
"""

import argparse
import json
import random

WARMUP, DURATION = 15, 30
OPEN_TPS = 2
SWEEP = [4, 8, 16, 32, 64]
WRITE_CAPACITY = [
    "acknowledgeSampleCollection",
    "proposeCustodyTransfer",
    "acceptCustodyTransfer",
    "recordSampleAnalysisResult",
    "triggerResultsManagement",
    "recordWhereaboutsStatus",
    "validateConsent",
]
READ_CAPACITY = ["evaluateDecisionTable", "getCustodyChain", "previewConsentDecision"]
LATENCY = ["initiateSampleCustody"] + WRITE_CAPACITY + READ_CAPACITY

ap = argparse.ArgumentParser()
ap.add_argument("--config", required=True)
ap.add_argument("--description", default="")
ap.add_argument("--expect", type=float, required=True,
                help="expected saturated write throughput, used only to size provisioned pools")
ap.add_argument("--seed", type=int, default=1)
ap.add_argument("--blocks", type=int, default=3)
ap.add_argument("--pairs", type=int, default=3)
ap.add_argument("--sweep", default="4,8,16,32,64",
                help="concurrency levels of the initiation sweep; must reach the plateau")
ap.add_argument("--capacity-concurrency", type=int, default=32,
                help="concurrency of capacity, sentinel and endorsement rounds: at or past the plateau")
ap.add_argument("--out", required=True)
a = ap.parse_args()

rng = random.Random(a.seed)
SWEEP = [int(x) for x in a.sweep.split(",")]
CAP = a.capacity_concurrency


def rnd(rid, workload, block, **load):
    r = {"id": rid, "workload": workload, "block": block, "warmup": WARMUP, "duration": DURATION}
    r.update(load)
    if "concurrency" in load:
        r["expectTps"] = a.expect * (6 if workload in READ_CAPACITY else 1.3)
    return r


rounds = []
for b in range(1, a.blocks + 1):
    body = []
    for c in SWEEP:
        body.append(rnd(f"b{b}-sweep-c{c}", "initiateSampleCustody", b, concurrency=c, kind="sweep"))
    for w in WRITE_CAPACITY:
        body.append(rnd(f"b{b}-cap-{w}", w, b, concurrency=CAP, kind="capacity"))
    for w in READ_CAPACITY:
        body.append(rnd(f"b{b}-cap-{w}", w, b, concurrency=max(64, CAP), kind="capacity"))
    for w in LATENCY:
        body.append(rnd(f"b{b}-lat-{w}", w, b, tps=OPEN_TPS, kind="latency"))
    rng.shuffle(body)
    rounds.append(rnd(f"b{b}-sentinel-open", "initiateSampleCustody", b, concurrency=CAP, kind="sentinel"))
    rounds.extend(body)
    rounds.append(rnd(f"b{b}-sentinel-close", "initiateSampleCustody", b, concurrency=CAP, kind="sentinel"))

orders = ["ABBA", "BAAB", "ABBA", "BAAB"]
for p in range(a.pairs):
    for k, arm in enumerate(orders[p]):
        w = "initiateOr1" if arm == "A" else "initiateOr2"
        rounds.append(rnd(f"pair{p + 1}-{k + 1}-{arm}", w, f"pair{p + 1}", concurrency=CAP, kind="endorsement"))

plan = {
    "name": a.config,
    "configuration": {"id": a.config, "description": a.description, "seed": a.seed,
                      "warmupS": WARMUP, "durationS": DURATION, "openLoopTps": OPEN_TPS,
                      "sweep": SWEEP, "capacityConcurrency": CAP},
    "rounds": rounds,
}
with open(a.out, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(plan, fh, indent=1)
print(f"{a.out}: {len(rounds)} rounds, about {len(rounds) * (WARMUP + DURATION + 10) / 60:.0f} min plus provisioning")
