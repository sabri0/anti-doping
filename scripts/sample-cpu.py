#!/usr/bin/env python3
"""Sample per-container processor use while a saturating round runs.

Polls `docker stats --no-stream` for `--duration` seconds and attributes each
container to a component. Every sample is kept, so the attribution carries an
n. Percentages are of one processor; utilisation of the network's own
processor set is the component sum divided by the number of processors the
network is pinned to.

Usage:
    python scripts/sample-cpu.py --duration 60 --interval 3 --net-cpus 6 --out docs/measurements/K1-cpu.json
"""

import argparse
import json
import re
import statistics
import subprocess
import time

COMPONENTS = [
    (re.compile(r"^couchdb"), "state database (CouchDB)"),
    (re.compile(r"^peer\d"), "peers"),
    (re.compile(r"^orderer"), "ordering nodes"),
    (re.compile(r"-cc$"), "chaincode"),
    (re.compile(r"^ipfs"), "IPFS"),
    (re.compile(r"^ca-|^cli$"), "CAs and tools"),
    (re.compile(r"^antidoping-driver"), "load driver"),
    (re.compile(r"^gateway|^web"), "application tier"),
]

ap = argparse.ArgumentParser()
ap.add_argument("--duration", type=float, default=60)
ap.add_argument("--interval", type=float, default=3)
ap.add_argument("--delay", type=float, default=0, help="seconds to wait before sampling (skip warm-up)")
ap.add_argument("--net-cpus", type=int, default=6)
ap.add_argument("--out", required=True)
a = ap.parse_args()

time.sleep(a.delay)
samples = []
end = time.time() + a.duration
while time.time() < end:
    t0 = time.time()
    out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}"],
                         capture_output=True, text=True).stdout
    per = {}
    for line in out.strip().splitlines():
        name, cpu = line.split("\t")
        comp = next((c for rx, c in COMPONENTS if rx.search(name)), "other")
        per[comp] = per.get(comp, 0.0) + float(cpu.rstrip("%") or 0)
    samples.append({"t": round(t0, 1), "components": per})
    time.sleep(max(0, a.interval - (time.time() - t0)))

comps = sorted({c for s in samples for c in s["components"]})
summary = {}
for c in comps:
    xs = [s["components"].get(c, 0.0) for s in samples]
    summary[c] = {"meanPctOfOneCpu": statistics.mean(xs), "sd": statistics.stdev(xs) if len(xs) > 1 else 0.0}
network = [c for c in comps if c not in ("load driver", "other")]
net_total = sum(summary[c]["meanPctOfOneCpu"] for c in network)
for c in network:
    summary[c]["shareOfNetworkPct"] = 100 * summary[c]["meanPctOfOneCpu"] / net_total if net_total else 0
result = {
    "n": len(samples),
    "intervalS": a.interval,
    "networkProcessors": a.net_cpus,
    "networkUtilisationPct": net_total / a.net_cpus,
    "components": summary,
    "samples": samples,
}
with open(a.out, "w", encoding="utf-8") as fh:
    json.dump(result, fh, indent=1)
print(f"{a.out}: n={len(samples)}, network utilisation {result['networkUtilisationPct']:.0f}% of {a.net_cpus} processors")
for c in network:
    print(f"  {c:28s} {summary[c]['shareOfNetworkPct']:5.1f}%")
