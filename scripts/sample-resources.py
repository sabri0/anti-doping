#!/usr/bin/env python3
"""Attribute processor time across network components during a saturating write round.

Runs one write round at an offered load above the measured saturation point and
polls `docker stats` throughout it, so the CPU split between state databases,
peers, ordering service and the rest is derived from many samples rather than a
handful. Every sample is retained in the output, so n is visible and the spread
can be inspected rather than taken on trust.

`docker stats` reports per-container CPU as a percentage of one core, computed
from the cgroup CPU accounting counters the daemon reads; percentages are summed
across containers and then divided by the host's visible vCPU count to give host
utilisation.

Sampling is not free. The round executed under sampling reports lower throughput
than the same round unsampled, so this run is used for proportions only and its
throughput is not reported as a measurement.

Usage:
    python scripts/sample-resources.py --interval 5 --out docs/resource-metrics.json
"""

import argparse
import json
import pathlib
import re
import shutil
import statistics
import os
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Container name -> component. Order matters: first match wins.
COMPONENTS = [
    (re.compile(r"^couchdb"), "couchdb"),
    (re.compile(r"^peer\d"), "peers"),
    (re.compile(r"^orderer"), "orderer"),
    (re.compile(r"^ca-"), "CAs"),
    (re.compile(r"^ipfs"), "ipfs"),
    (re.compile(r"^dev-peer|chaincode"), "chaincode"),
    (re.compile(r"caliper"), "driver"),
]


def find_bash() -> str:
    """Locate a POSIX bash.

    On Windows the first `bash` on PATH is usually System32\bash.exe, the WSL
    launcher, which cannot see the Windows working directory and fails with
    execvpe(/bin/bash). Git for Windows ships the shell this project's scripts
    are written for, so prefer it explicitly.
    """
    candidates = [
        os.environ.get("BASH"),
        r"C:\Program Files\Gitinash.exe",
        r"C:\Program Files (x86)\Gitinash.exe",
    ]
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).exists():
            return candidate
    found = shutil.which("bash")
    if found and "System32" not in found:
        return found
    sys.exit("no POSIX bash found; set BASH to the Git Bash executable")


def classify(name: str) -> str:
    for pattern, component in COMPONENTS:
        if pattern.search(name):
            return component
    return "other"


def poll_once():
    """One `docker stats` sweep: {container: (cpu_percent, mem_MiB)}."""
    p = subprocess.run(
        ["docker", "stats", "--no-stream", "--format",
         "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
        capture_output=True, text=True, timeout=120,
    )
    sample = {}
    for line in p.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        name, cpu, mem = parts[0], parts[1], parts[2]
        try:
            cpu_v = float(cpu.strip().rstrip("%"))
        except ValueError:
            continue
        mem_v = 0.0
        m = re.match(r"([\d.]+)\s*([KMG]i?B)", mem.strip())
        if m:
            value, unit = float(m.group(1)), m.group(2)
            mem_v = value * {"KiB": 1 / 1024, "MiB": 1, "GiB": 1024,
                             "KB": 1 / 1024, "MB": 1, "GB": 1024}.get(unit, 1)
        sample[name] = (cpu_v, mem_v)
    return sample


def host_vcpu() -> int:
    p = subprocess.run(["docker", "info", "--format", "{{.NCPU}}"],
                       capture_output=True, text=True)
    try:
        return int(p.stdout.strip())
    except ValueError:
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--config", default="benchmark/resource-sample.yaml")
    ap.add_argument("--out", type=pathlib.Path, default=ROOT / "docs/resource-metrics.json")
    ap.add_argument("--no-load", action="store_true",
                    help="sample without driving load (idle baseline)")
    args = ap.parse_args()

    samples = []
    stop = threading.Event()

    def sampler():
        while not stop.is_set():
            try:
                s = poll_once()
                if s:
                    samples.append(s)
            except Exception:  # noqa: BLE001 - a failed sweep must not end sampling
                pass
            stop.wait(args.interval)

    thread = threading.Thread(target=sampler, daemon=True)
    thread.start()

    if args.no_load:
        time.sleep(60)
    else:
        env = {"CONFIG": args.config,
               "REPORT": "benchmark/resource-sample.html",
               "LOG": "benchmark/resource-sample.log"}
        cmd = "CONFIG=$CONFIG REPORT=$REPORT LOG=$LOG bash scripts/run-benchmark.sh"
        proc = subprocess.run([find_bash(), "-c", cmd], cwd=ROOT,
                              env={**dict(os.environ), **env},
                              capture_output=True, text=True)
        # A silently failed round leaves the sampler reporting an idle host as
        # if it were a saturating one, which is worse than reporting nothing.
        if proc.returncode != 0:
            stop.set()
            sys.stderr.write(proc.stdout[-4000:] + proc.stderr[-4000:])
            sys.exit(f"benchmark round failed (exit {proc.returncode}); no attribution written")

    stop.set()
    thread.join(timeout=args.interval * 2)

    # Per-sample component totals, then summarised across samples.
    per_component = {}
    host_totals = []
    for sample in samples:
        totals = {}
        for name, (cpu, mem) in sample.items():
            component = classify(name)
            cpu_sum, mem_sum = totals.get(component, (0.0, 0.0))
            totals[component] = (cpu_sum + cpu, mem_sum + mem)
        host_totals.append(sum(c for c, _ in totals.values()))
        for component, (cpu, mem) in totals.items():
            per_component.setdefault(component, {"cpu": [], "mem": []})
            per_component[component]["cpu"].append(cpu)
            per_component[component]["mem"].append(mem)

    vcpu = host_vcpu()
    total_mean = statistics.mean(host_totals) if host_totals else 0.0

    by_component = {}
    for component, series in sorted(
            per_component.items(), key=lambda kv: -statistics.mean(kv[1]["cpu"])):
        cpu = series["cpu"]
        by_component[component] = {
            "cpuPercentMean": round(statistics.mean(cpu), 1),
            "cpuPercentSd": round(statistics.stdev(cpu), 1) if len(cpu) > 1 else None,
            "cpuPercentMin": round(min(cpu), 1),
            "cpuPercentMax": round(max(cpu), 1),
            "shareOfLoadPercent": round(statistics.mean(cpu) / total_mean * 100, 1)
            if total_mean else None,
            "avgMemMiB": round(statistics.mean(series["mem"]), 1),
        }

    out = {
        "samples": len(samples),
        "intervalSeconds": args.interval,
        "hostVcpu": vcpu,
        "totalCpuPercentMean": round(total_mean, 1),
        "totalCpuPercentSd": round(statistics.stdev(host_totals), 1)
        if len(host_totals) > 1 else None,
        "hostUtilisationPercentMean": round(total_mean / vcpu, 1) if vcpu else None,
        "byComponent": by_component,
        "note": (
            "Sampled with `docker stats` at a fixed interval throughout a sustained "
            "saturating write round (initiateSampleCustody, 60 TPS offered). Reported "
            "for CPU proportions only: sampling itself consumes host capacity, so the "
            "sampled round's own throughput is lower than the unsampled figure and is "
            "not reported as a measurement."
        ),
    }
    args.out.write_text(json.dumps(out, indent=2), encoding="utf8")
    print(f"[resources] n={len(samples)} samples -> {args.out}")
    for component, stats in by_component.items():
        print(f"  {component:10s} {stats['cpuPercentMean']:7.1f}% "
              f"(sd {stats['cpuPercentSd']}) share {stats['shareOfLoadPercent']}%")


if __name__ == "__main__":
    main()
