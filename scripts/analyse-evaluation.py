#!/usr/bin/env python3
"""Turn the measurement output into every number, table row and figure the
manuscript reports.

Inputs (docs/measurements): K1.json, K2.json, K3.json (measurement plans),
K*-cpu.json (processor attribution), K*-scenarios.json, baselines.json,
host.json; docs/formalisation-statistics.json; docs/insider-comparison.json;
docs/test-summary.json; the contract sources (for the interface counts).

Outputs: manuscript-build/numbers_auto.json; docs/evaluation-summary.json;
docs/figures/Fig-performance.{png,pdf,svg}, FigS-cpu.*, FigS-drift.*.

Nothing in the manuscript's results is typed by hand: re-run the
measurements, re-run this script, rebuild, and the text follows.
"""

import json
import math
import pathlib
import re
import statistics

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
M = ROOT / "docs" / "measurements"
FIG = ROOT / "docs" / "figures"

CONFIGS = [
    ("K1", "K1: Raft, CouchDB"),
    ("K2", "K2: Raft, LevelDB"),
    ("K3", "K3: SmartBFT, LevelDB"),
]
# Categorical slots 1-3 of the validated palette (all-pairs pass, light mode);
# baselines are recessive gray reference marks.
COLOR = {"K1": "#2a78d6", "K2": "#eb6834", "K3": "#1baf7a"}
MARKER = {"K1": "o", "K2": "s", "K3": "^"}
GRAY = "#8a8985"
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
GRID = "#e4e3df"

WRITE_OPS = [
    ("initiateSampleCustody", "initiateSampleCustody (custody opened)"),
    ("acknowledgeSampleCollection", "acknowledgeSampleCollection (athlete)"),
    ("proposeCustodyTransfer", "proposeCustodyTransfer (dispatch)"),
    ("acceptCustodyTransfer", "acceptCustodyTransfer (receipt)"),
    ("recordSampleAnalysisResult", "recordSampleAnalysisResult (private)"),
    ("triggerResultsManagement", "triggerResultsManagement (private)"),
    ("recordWhereaboutsStatus", "recordWhereaboutsStatus (private)"),
    ("validateConsent", "validateConsent (private, athlete peer)"),
]
READ_OPS = [
    ("evaluateDecisionTable", "evaluateDecisionTable"),
    ("getCustodyChain", "getCustodyChain"),
    ("previewConsentDecision", "previewConsentDecision (athlete peer)"),
]
SWEEP = [4, 8, 16, 32, 64, 128, 256]


def load(path):
    return json.loads(path.read_text(encoding="utf8")) if path.exists() else None


def kind(rid):
    for k in ("sweep", "cap", "lat", "sentinel", "pair"):
        if f"-{k}-" in rid or rid.startswith(k):
            return k
    return "other"


def stats(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    return {"mean": statistics.mean(xs), "min": min(xs), "max": max(xs), "n": len(xs)}


def fmt(s, digits=1, unit=""):
    if not s:
        return "—"
    if s["n"] == 1 or abs(s["max"] - s["min"]) < 0.5 * 10 ** -digits:
        return f"{s['mean']:.{digits}f}{unit}".replace("-", "−")
    sep = " to " if s["min"] < 0 else "–"
    return (f"{s['mean']:.{digits}f}{unit} ({s['min']:.{digits}f}{sep}{s['max']:.{digits}f})").replace("-", "−")


def lag1(xs):
    if len(xs) < 3:
        return None
    m = statistics.mean(xs)
    den = sum((x - m) ** 2 for x in xs)
    return sum((xs[i] - m) * (xs[i + 1] - m) for i in range(len(xs) - 1)) / den if den else None


def analyse_config(data):
    rounds = data["rounds"]
    cap_c = (data.get("configuration") or {}).get("capacityConcurrency", 32)
    out = {"capacity": {}, "latency": {}, "sweep": {}, "sentinels": [], "pairs": [], "failures": 0,
           "measured": 0, "poolExhausted": [], "provisionErrors": 0}
    for r in rounds:
        k = kind(r["id"])
        out["failures"] += sum(r["failures"].values())
        out["measured"] += r["offered"]
        out["provisionErrors"] += r.get("provisionErrors", 0) or 0
        if r.get("poolExhausted"):
            out["poolExhausted"].append(r["id"])
        if k == "cap":
            out["capacity"].setdefault(r["workload"], []).append(r["committedTps"])
        elif k == "sweep":
            out["sweep"].setdefault(r["concurrency"], {"tps": [], "p50": [], "p95": []})
            out["sweep"][r["concurrency"]]["tps"].append(r["committedTps"])
            out["sweep"][r["concurrency"]]["p50"].append((r["latencyMs"]["p50"] or 0) / 1000)
            out["sweep"][r["concurrency"]]["p95"].append((r["latencyMs"]["p95"] or 0) / 1000)
            if r["concurrency"] == cap_c and r["workload"] == "initiateSampleCustody":
                out["capacity"].setdefault("initiateSampleCustody", []).append(r["committedTps"])
        elif k == "lat":
            d = out["latency"].setdefault(r["workload"], {"p50": [], "p95": [], "p99": [], "tps": []})
            d["p50"].append((r["latencyMs"]["p50"] or 0) / 1000)
            d["p95"].append((r["latencyMs"]["p95"] or 0) / 1000)
            d["p99"].append((r["latencyMs"]["p99"] or 0) / 1000)
            d["tps"].append(r["committedTps"])
        elif k == "sentinel":
            out["sentinels"].append({"id": r["id"], "tps": r["committedTps"], "perSecond": r["perSecondCommitted"]})
        elif k == "pair":
            out["pairs"].append({"id": r["id"], "workload": r["workload"], "tps": r["committedTps"],
                                 "block": r["block"]})
    # endorsement cost within each counterbalanced block of four
    blocks = {}
    for p in out["pairs"]:
        blocks.setdefault(p["block"], []).append(p)
    costs = []
    for b, ps in sorted(blocks.items()):
        one = [p["tps"] for p in ps if p["workload"] == "initiateOr1"]
        two = [p["tps"] for p in ps if p["workload"] == "initiateOr2"]
        if one and two:
            costs.append(100 * (1 - statistics.mean(two) / statistics.mean(one)))
    out["endorsementCostPct"] = stats(costs)
    out["endorsementOne"] = stats([p["tps"] for p in out["pairs"] if p["workload"] == "initiateOr1"])
    out["endorsementTwo"] = stats([p["tps"] for p in out["pairs"] if p["workload"] == "initiateOr2"])
    sent = [s["tps"] for s in out["sentinels"]]
    out["sentinelStats"] = stats(sent)
    out["sentinelLag1"] = lag1(sent)
    out["sentinelDriftPct"] = (100 * (sent[-1] - sent[0]) / sent[0]) if len(sent) >= 2 and sent[0] else None
    out["sentinelSpreadPct"] = (100 * (max(sent) - min(sent)) / statistics.mean(sent)) if sent else None
    out["saturation"] = max((statistics.mean(v["tps"]) for v in out["sweep"].values()), default=None)
    out["capacityConcurrency"] = cap_c
    return out


def analyse_baselines(data):
    out = {}
    for w in ("baseline-telog", "baseline-couchdb"):
        rs = [r for r in data["rounds"] if r["workload"] == w]
        sweep = {}
        for r in rs:
            if r.get("concurrency"):
                d = sweep.setdefault(r["concurrency"], {"tps": [], "p50": [], "p95": []})
                d["tps"].append(r["committedTps"])
                d["p50"].append((r["latencyMs"]["p50"] or 0) / 1000)
                d["p95"].append((r["latencyMs"]["p95"] or 0) / 1000)
        lat = [r for r in rs if r.get("configuredTps")]
        out[w] = {
            "sweep": sweep,
            "saturation": max((statistics.mean(v["tps"]) for v in sweep.values()), default=None),
            "latencyP50": stats([(r["latencyMs"]["p50"] or 0) / 1000 for r in lat]),
            "latencyP95": stats([(r["latencyMs"]["p95"] or 0) / 1000 for r in lat]),
            "failures": sum(sum(r["failures"].values()) for r in rs),
        }
    return out


def count_transactions(path):
    return len(re.findall(r"@Transaction\(", path.read_text(encoding="utf8")))


# ---------------------------------------------------------------- figures

def style(ax):
    ax.set_facecolor(SURFACE)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(INK_2)
        ax.spines[side].set_linewidth(0.6)
    ax.tick_params(colors=INK_2, labelsize=6.5, width=0.6, length=2.5)
    ax.grid(True, color=GRID, linewidth=0.5, zorder=0)
    ax.set_axisbelow(True)


def label(ax, letter):
    ax.annotate(letter, xy=(0, 1), xytext=(-24, 8), xycoords="axes fraction", textcoords="offset points",
                fontsize=9.5, fontweight="bold", color=INK)


def figure_performance(res, base, path):
    fig, axes = plt.subplots(2, 2, figsize=(7.1, 6.3), facecolor=SURFACE)
    fig.subplots_adjust(left=0.085, right=0.985, top=0.89, bottom=0.1, hspace=0.5, wspace=0.34)
    (a, b), (c, d) = axes

    # a: throughput vs concurrency
    style(a)
    for k, name in CONFIGS:
        if k not in res:
            continue
        sw = res[k]["sweep"]
        xs = [cc for cc in SWEEP if cc in sw]
        ys = [statistics.mean(sw[cc]["tps"]) for cc in xs]
        lo = [statistics.mean(sw[cc]["tps"]) - min(sw[cc]["tps"]) for cc in xs]
        hi = [max(sw[cc]["tps"]) - statistics.mean(sw[cc]["tps"]) for cc in xs]
        a.errorbar(xs, ys, yerr=[lo, hi], color=COLOR[k], marker=MARKER[k], markersize=4, linewidth=1.6,
                   capsize=2, elinewidth=0.8, label=name, zorder=3)
        a.annotate(k, (xs[-1], ys[-1]), xytext=(4, 0), textcoords="offset points", fontsize=6.3,
                   color=INK_2, va="center")
    a.set_xscale("log", base=2)
    a.set_xticks(SWEEP)
    a.set_xticklabels([str(x) for x in SWEEP])
    a.set_xlabel("Outstanding transactions (closed loop)", fontsize=6.8, color=INK_2)
    a.set_ylabel("Committed transactions s$^{-1}$", fontsize=6.8, color=INK_2)
    a.set_ylim(bottom=0)
    a.set_title("Custody initiation: throughput", fontsize=7.2, color=INK, loc="left")
    label(a, "a")

    # b: latency vs throughput, ledger configurations and baselines
    style(b)
    for k, name in CONFIGS:
        if k not in res:
            continue
        sw = res[k]["sweep"]
        xs = [statistics.mean(sw[cc]["tps"]) for cc in SWEEP if cc in sw]
        ys = [statistics.mean(sw[cc]["p50"]) for cc in SWEEP if cc in sw]
        b.plot(xs, ys, color=COLOR[k], marker=MARKER[k], markersize=4, linewidth=1.6, label=name, zorder=3)
    for w, ls, lab in (("baseline-telog", "--", "tamper-evident log"), ("baseline-couchdb", ":", "single CouchDB")):
        if base and w in base:
            sw = base[w]["sweep"]
            xs = [statistics.mean(sw[cc]["tps"]) for cc in SWEEP if cc in sw]
            ys = [statistics.mean(sw[cc]["p50"]) for cc in SWEEP if cc in sw]
            b.plot(xs, ys, color=GRAY, linestyle=ls, marker="x", markersize=3.5, linewidth=1.2, label=lab, zorder=2)
            b.annotate(lab, (xs[0], ys[0]), xytext=(-6, 5),
                       textcoords="offset points", fontsize=6.0, color=INK_2, ha="right")
    b.set_xscale("log")
    b.set_yscale("log")
    b.set_xlabel("Committed transactions s$^{-1}$ (log)", fontsize=6.8, color=INK_2)
    b.set_ylabel("Median latency, s (log)", fontsize=6.8, color=INK_2)
    b.set_title("Latency against throughput, with baselines", fontsize=7.2, color=INK, loc="left")
    label(b, "b")

    # c: capacity by operation
    style(c)
    ops = [o for o, _ in WRITE_OPS]
    width = 0.26
    for j, (k, name) in enumerate(CONFIGS):
        if k not in res:
            continue
        xs, ys, lo, hi = [], [], [], []
        for i, o in enumerate(ops):
            s = stats(res[k]["capacity"].get(o, []))
            if not s:
                continue
            xs.append(i + (j - 1) * width)
            ys.append(s["mean"])
            lo.append(s["mean"] - s["min"])
            hi.append(s["max"] - s["mean"])
        c.bar(xs, ys, width=width - 0.03, color=COLOR[k], label=name, zorder=3)
        c.errorbar(xs, ys, yerr=[lo, hi], fmt="none", ecolor=INK_2, elinewidth=0.6, capsize=1.5, zorder=4)
    c.set_xticks(range(len(ops)))
    c.set_xticklabels(["initiate", "acknowledge", "dispatch", "receipt", "analysis", "results mgmt",
                       "whereabouts", "consent check"], fontsize=5.6, rotation=35, ha="right")
    c.set_ylabel("Committed transactions s$^{-1}$", fontsize=6.8, color=INK_2)
    c.set_title("Write capacity by operation", fontsize=7.2, color=INK, loc="left")
    label(c, "c")

    # d: latency at 2 tx/s, median and 95th percentile
    style(d)
    allops = [o for o, _ in WRITE_OPS] + [o for o, _ in READ_OPS]
    for j, (k, name) in enumerate(CONFIGS):
        if k not in res:
            continue
        for i, o in enumerate(allops):
            lat = res[k]["latency"].get(o)
            if not lat:
                continue
            y = i + (j - 1) * 0.25
            p50 = statistics.mean(lat["p50"])
            p95 = statistics.mean(lat["p95"])
            d.plot([p50, p95], [y, y], color=COLOR[k], linewidth=1.2, zorder=3)
            d.plot([p50], [y], marker=MARKER[k], color=COLOR[k], markersize=3.8, zorder=4)
            d.plot([p95], [y], marker="|", color=COLOR[k], markersize=5, zorder=4)
    d.set_yticks(range(len(allops)))
    d.set_yticklabels(["initiate", "acknowledge", "dispatch", "receipt", "analysis", "results mgmt",
                       "whereabouts", "consent check", "decision table (read)", "custody chain (read)",
                       "consent preview (read)"], fontsize=5.6)
    d.invert_yaxis()
    d.set_xscale("log")
    d.set_xlabel("Latency at 2 transactions s$^{-1}$, s (log)", fontsize=6.8, color=INK_2)
    d.set_title("Response time below saturation", fontsize=7.2, color=INK, loc="left")
    label(d, "d")

    handles = [Line2D([0], [0], color=COLOR[k], marker=MARKER[k], linewidth=1.6, markersize=4, label=n)
               for k, n in CONFIGS if k in res]
    handles += [Line2D([0], [0], color=GRAY, linestyle="--", marker="x", linewidth=1.2, label="tamper-evident log"),
                Line2D([0], [0], color=GRAY, linestyle=":", marker="x", linewidth=1.2, label="single CouchDB")]
    fig.legend(handles=handles, loc="upper center", ncol=5, fontsize=6.2, frameon=False,
               bbox_to_anchor=(0.5, 0.995), labelcolor=INK_2)
    for ext in ("png", "pdf", "svg"):
        fig.savefig(path.with_suffix(f".{ext}"), dpi=400, facecolor=SURFACE)
    plt.close(fig)


def figure_cpu(cpu, path):
    comps = ["state database (CouchDB)", "peers", "chaincode", "ordering nodes", "IPFS", "CAs and tools"]
    shades = ["#1f4e8c", "#2a78d6", "#6aa4e8", "#a9cbf2", "#d3e4f8", "#ecf3fc"]  # one hue, light to dark reversed
    fig, ax = plt.subplots(figsize=(7.1, 2.4), facecolor=SURFACE)
    fig.subplots_adjust(left=0.2, right=0.84, top=0.8, bottom=0.2)
    style(ax)
    ax.grid(False)
    names = [n for k, n in CONFIGS if k in cpu]
    for row, (k, n) in enumerate([(k, n) for k, n in CONFIGS if k in cpu]):
        left = 0
        for comp, colr in zip(comps, shades):
            share = cpu[k]["components"].get(comp, {}).get("shareOfNetworkPct", 0)
            if share <= 0:
                continue
            ax.barh(row, share, left=left, color=colr, edgecolor=SURFACE, linewidth=1.5, height=0.62)
            if share >= 6:
                ax.text(left + share / 2, row, f"{share:.0f}%", ha="center", va="center", fontsize=6,
                        color="white" if colr in shades[:2] else INK)
            left += share
        ax.text(101.5, row, f"{cpu[k]['networkUtilisationPct']:.0f}% of 6\nprocessors used", va="center",
                fontsize=6, color=INK_2, clip_on=False)
    ax.set_yticks(range(len(names)))
    ax.set_yticklabels(names, fontsize=6.5)
    ax.invert_yaxis()
    ax.set_xlim(0, 100)
    ax.set_xlabel("Share of the network's processor time, % (saturating custody-initiation round)",
                  fontsize=6.5, color=INK_2)
    handles = [plt.Rectangle((0, 0), 1, 1, color=colr) for colr in shades]
    ax.legend(handles, comps, loc="upper center", bbox_to_anchor=(0.45, 1.3), ncol=6, fontsize=5.6,
              frameon=False, labelcolor=INK_2)
    for ext in ("png", "pdf", "svg"):
        fig.savefig(path.with_suffix(f".{ext}"), dpi=400, facecolor=SURFACE)
    plt.close(fig)


def figure_drift(res, path):
    fig, axes = plt.subplots(1, 2, figsize=(7.1, 2.5), facecolor=SURFACE)
    fig.subplots_adjust(left=0.08, right=0.98, top=0.86, bottom=0.2, wspace=0.28)
    a, b = axes
    style(a)
    style(b)
    for k, name in CONFIGS:
        if k not in res:
            continue
        sent = res[k]["sentinels"]
        a.plot(range(1, len(sent) + 1), [s["tps"] for s in sent], color=COLOR[k], marker=MARKER[k],
               markersize=4, linewidth=1.4, label=name)
        if sent:
            series = sent[0]["perSecond"]
            # Blocks commit in bursts at the one-second batch timeout, so a
            # 5-second moving average shows the level rather than the bursts.
            ma = [sum(series[max(0, i - 4):i + 1]) / len(series[max(0, i - 4):i + 1]) for i in range(len(series))]
            b.plot(range(1, len(ma) + 1), ma, color=COLOR[k], marker=MARKER[k], markersize=2.5, linewidth=1.2, label=name)
    a.set_xlabel("Sentinel round (opening and closing each block)", fontsize=6.5, color=INK_2)
    a.set_ylabel("Committed transactions s$^{-1}$", fontsize=6.5, color=INK_2)
    a.set_ylim(bottom=0)
    a.set_title("Identical sentinel rounds across the run", fontsize=7, color=INK, loc="left")
    b.set_xlabel("Second of the measured window (first sentinel)", fontsize=6.5, color=INK_2)
    b.set_ylabel("Committed s$^{-1}$, 5-s moving average", fontsize=6.5, color=INK_2)
    b.set_ylim(bottom=0)
    b.set_title("Within-round stationarity", fontsize=7, color=INK, loc="left")
    a.legend(fontsize=5.8, frameon=False, labelcolor=INK_2)
    label(a, "a")
    label(b, "b")
    for ext in ("png", "pdf", "svg"):
        fig.savefig(path.with_suffix(f".{ext}"), dpi=400, facecolor=SURFACE)
    plt.close(fig)


# ---------------------------------------------------------------- main

def main():
    import sys
    no_figures = "--no-figures" in sys.argv
    res = {}
    for k, _ in CONFIGS:
        d = load(M / f"{k}.json")
        if d:
            res[k] = analyse_config(d)
    cpu = {k: load(M / f"{k}-cpu.json") for k, _ in CONFIGS if (M / f"{k}-cpu.json").exists()}
    base_raw = load(M / "baselines.json")
    base = analyse_baselines(base_raw) if base_raw else None
    host = load(M / "host.json") or {}
    fstats = load(ROOT / "docs" / "formalisation-statistics.json")
    insider = load(ROOT / "docs" / "insider-comparison.json")
    tests = load(ROOT / "docs" / "test-summary.json") or {}
    scen = {k: load(M / f"{k}-scenarios.json") for k, _ in CONFIGS}

    n = {}
    # formalisation
    if fstats:
        fs = fstats["firstSpecification"]
        n.update({
            "F_UNMATCHED": fs["unmatched"], "F_MULTI": fs["multiplyMatched"], "F_POS_UNV": fs["positiveUnverified"],
            "F_POS_UNV_UNMATCHED": fs["positiveUnverifiedUnmatched"],
            "F_POS_UNV_ABSORBED": fs["positiveUnverified"] - fs["positiveUnverifiedUnmatched"],
            "F_CONCURRENT": fstats["implemented"]["vectorsWithRetainedConcurrentMatches"],
        })
    n["N_CUSTODY_TX"] = count_transactions(ROOT / "chaincode/custody/src/custodyContract.ts")
    n["N_CONSENT_TX"] = count_transactions(ROOT / "chaincode/consent/src/consentContract.ts")
    for key, label_ in (("custody", "N_UNIT_CUSTODY"), ("consent", "N_UNIT_CONSENT"), ("offchain", "N_UNIT_OFFCHAIN")):
        n[label_] = tests.get(key, "{{" + label_ + "}}")
    if all(isinstance(tests.get(x), int) for x in ("custody", "consent", "offchain")):
        n["N_UNIT_TESTS"] = tests["custody"] + tests["consent"] + tests["offchain"]

    # host
    if host:
        n["FSYNC_MS"] = f"{host['storage']['meanSyncWriteMs']:.1f}"
        p = host["processor"]
        n["HOST_CPU"] = f"{p['Name'].strip()}; {p['NumberOfCores']} cores, {p['NumberOfLogicalProcessors']} hardware threads"
        n["HOST_OS"] = (f"{host['os']['Caption']} {host['os']['Version']}; Docker Desktop virtual machine on WSL 2, "
                        f"Linux {host['docker']['kernel'].split('-')[0]}, {host['docker']['cpus']} virtual processors, "
                        f"{host['docker']['memBytes'] / 2**30:.1f} GiB")
        n["HOST_DOCKER"] = f"Docker Engine {host['docker']['serverVersion']}; Compose {host['composeVersion']}"
        n["HOST_STORAGE"] = (f"NVMe solid-state drive; Docker volumes on the virtual machine's ext4 disk; "
                             f"synchronous 4 KiB write {host['storage']['meanSyncWriteMs']:.1f} ms mean")

    # demand reference
    tx_per_sample = 7  # initiate, acknowledge, dispatch, receipt, analysis, results management, notice
    n["TX_PER_SAMPLE"] = "seven"
    n["PEAK_FACTOR"] = f"{0.01 * 8760:.0f}"
    n["DEMAND_HIGH"] = f"{330000 * 30 * 0.01 / 3600:.1f}"
    n["DEMAND_LOW"] = f"{330000 * tx_per_sample * 0.01 / 3600:.1f}"
    n["DEMAND_MEAN"] = f"{330000 * 30 / 8760 / 3600:.2f}"

    # scenarios
    passed = {k: (s["passed"], s["passed"] + s["failed"]) for k, s in scen.items() if s}
    n["SCENARIOS_PASSED"] = passed

    # performance tokens
    for k, r in res.items():
        for o, _ in WRITE_OPS + READ_OPS:
            n[f"CAP_{k}_{o}"] = fmt(stats(r["capacity"].get(o, [])), 1)
            lat = r["latency"].get(o)
            n[f"LAT50_{k}_{o}"] = fmt(stats(lat["p50"]), 2) if lat else "—"
            n[f"LAT95_{k}_{o}"] = fmt(stats(lat["p95"]), 2) if lat else "—"
        n[f"SAT_{k}"] = f"{r['saturation']:.1f}" if r["saturation"] else "—"
        for o, _ in WRITE_OPS + READ_OPS:
            s_ = stats(r["capacity"].get(o, []))
            n[f"CAPM_{k}_{o}"] = f"{s_['mean']:.1f}" if s_ else "—"
        n[f"ENDORSE_COST_{k}"] = fmt(r["endorsementCostPct"], 1, "%")
        n[f"ENDORSE_COSTM_{k}"] = f"{r['endorsementCostPct']['mean']:.0f}%" if r["endorsementCostPct"] else "—"
        n[f"SENTINEL_{k}"] = fmt(r["sentinelStats"], 1)
        n[f"SENTINEL_SPREAD_{k}"] = f"{r['sentinelSpreadPct']:.0f}" if r["sentinelSpreadPct"] is not None else "—"
        n[f"SENTINEL_LAG1_{k}"] = f"{r['sentinelLag1']:.2f}" if r["sentinelLag1"] is not None else "—"
        n[f"FAIL_{k}"] = r["failures"]
        n[f"MEASURED_{k}"] = r["measured"]
    if base:
        for w, key in (("baseline-telog", "TELOG"), ("baseline-couchdb", "COUCH")):
            b = base[w]
            n[f"{key}_SAT"] = f"{b['saturation']:.0f}" if b["saturation"] else "—"
            n[f"{key}_LAT50"] = fmt(b["latencyP50"], 3)
            n[f"{key}_LAT95"] = fmt(b["latencyP95"], 3)
            n[f"{key}_LAT50_MS"] = f"{b['latencyP50']['mean'] * 1000:.0f}" if b["latencyP50"] else "—"
    for k, c in cpu.items():
        comps = c["components"]
        n[f"CPU_COUCH_{k}"] = f"{comps.get('state database (CouchDB)', {}).get('shareOfNetworkPct', 0):.0f}"
        n[f"CPU_PEERS_{k}"] = f"{comps.get('peers', {}).get('shareOfNetworkPct', 0):.0f}"
        n[f"CPU_ORDER_{k}"] = f"{comps.get('ordering nodes', {}).get('shareOfNetworkPct', 0):.0f}"
        n[f"CPU_CC_{k}"] = f"{comps.get('chaincode', {}).get('shareOfNetworkPct', 0):.0f}"
        n[f"CPU_UTIL_{k}"] = f"{c['networkUtilisationPct']:.0f}"
        n[f"CPU_N_{k}"] = c["n"]

    # Derived comparisons quoted in the text
    def cap_mean(k, o):
        s_ = stats(res[k]["capacity"].get(o, [])) if k in res else None
        return s_["mean"] if s_ else None

    labels = dict(WRITE_OPS + READ_OPS)
    short = {"initiateSampleCustody": "custody initiation", "acknowledgeSampleCollection": "the athlete's acknowledgement",
             "proposeCustodyTransfer": "dispatch", "acceptCustodyTransfer": "receipt",
             "recordSampleAnalysisResult": "the analysis result", "triggerResultsManagement": "results management",
             "recordWhereaboutsStatus": "the whereabouts record", "validateConsent": "the consent decision",
             "evaluateDecisionTable": "decision-table evaluation", "getCustodyChain": "the custody-chain query",
             "previewConsentDecision": "the consent preview"}
    writes = [o for o, _ in WRITE_OPS]
    reads = [o for o, _ in READ_OPS]
    for k in ("K1", "K2", "K3"):
        if k not in res:
            continue
        wc = [(cap_mean(k, o), o) for o in writes if cap_mean(k, o) is not None]
        rc = [(cap_mean(k, o), o) for o in reads if cap_mean(k, o) is not None]
        lo, hi = min(wc), max(wc)
        n[f"{k}_WRITE_MIN"], n[f"{k}_WRITE_MIN_OP"] = f"{lo[0]:.1f}", short[lo[1]]
        n[f"{k}_WRITE_MAX"], n[f"{k}_WRITE_MAX_OP"] = f"{hi[0]:.1f}", short[hi[1]]
        n[f"{k}_READ_MIN"], n[f"{k}_READ_MAX"] = f"{min(rc)[0]:.0f}", f"{max(rc)[0]:.0f}"
        l50 = [statistics.mean(res[k]["latency"][o]["p50"]) for o in writes if o in res[k]["latency"]]
        l95 = [statistics.mean(res[k]["latency"][o]["p95"]) for o in writes if o in res[k]["latency"]]
        n[f"{k}_LAT50_MIN"], n[f"{k}_LAT50_MAX"], n[f"{k}_LAT95_MAX"] = f"{min(l50):.2f}", f"{max(l50):.2f}", f"{max(l95):.2f}"
        n[f"{k}_SENTINEL_N"] = len(res[k]["sentinels"])
    if "K1" in res and "K2" in res:
        n["K2_OVER_K1"] = f"{cap_mean('K2', 'initiateSampleCustody') / cap_mean('K1', 'initiateSampleCustody'):.1f}"
        ratios = [cap_mean("K2", o) / cap_mean("K1", o) for o in writes]
        n["K2_OVER_K1_WRITES_MIN"], n["K2_OVER_K1_WRITES_MAX"] = f"{min(ratios):.1f}", f"{max(ratios):.1f}"
    if "K2" in res and "K3" in res:
        costs = {o: 100 * (1 - cap_mean("K3", o) / cap_mean("K2", o)) for o in writes}
        n["K3_COST_MAX"] = f"{max(costs.values()):.0f}"
        n["K3_COST_MAX_OP"] = short[max(costs, key=costs.get)]
        n["K3_COST_MEDIAN"] = f"{statistics.median(costs.values()):.0f}"
        n["K3_COST_BY_OP"] = {short[o]: round(v, 1) for o, v in costs.items()}
    # Complete samples per second if the six measured per-sample writes did not
    # interfere: 1 / sum(1 / capacity). An estimate, not a mixed-workload measurement.
    per_sample = ["initiateSampleCustody", "acknowledgeSampleCollection", "proposeCustodyTransfer",
                  "acceptCustodyTransfer", "recordSampleAnalysisResult", "triggerResultsManagement"]
    for k in res:
        n[f"SAMPLES_{k}"] = f"{1 / sum(1 / cap_mean(k, o) for o in per_sample):.1f}"
        for o, _ in WRITE_OPS:
            lat = res[k]["latency"].get(o)
            if lat:
                n[f"LAT50M_{k}_{o}"] = f"{statistics.mean(lat['p50']):.1f}"
    n["PEAK_SAMPLES"] = f"{330000 * 0.01 / 3600:.2f}"
    n["MEASURED_ALL"] = f"{sum(r['measured'] for r in res.values()):,}"
    n["FAIL_ALL"] = sum(r["failures"] for r in res.values())
    n["POOL_EXHAUSTED"] = {k: r["poolExhausted"] for k, r in res.items()}
    best = max(("K1", "K2", "K3"), key=lambda k: res[k]["saturation"] if k in res and res[k]["saturation"] else -1)
    n["SAT_BEST"] = f"{res[best]['saturation']:.1f}"
    n["SAT_BEST_CONFIG"] = best
    if base:
        tl = base["baseline-telog"]
        n["TELOG_OVER_BEST"] = f"{tl['saturation'] / res[best]['saturation']:.0f}"
        if tl["latencyP50"] and "K2" in res:
            k2lat = statistics.mean(res["K2"]["latency"]["initiateSampleCustody"]["p50"])
            n["TELOG_LAT_RATIO"] = f"{k2lat / tl['latencyP50']['mean']:.0f}"
    n["SENTINEL_SPREAD_SUMMARY"] = (f"{n.get('SENTINEL_SPREAD_K1', '—')}%, {n.get('SENTINEL_SPREAD_K2', '—')}% and "
                                    f"{n.get('SENTINEL_SPREAD_K3', '—')}% of the mean in K1, K2 and K3")
    n["ENDORSE_COST_SUMMARY"] = (f"{n.get('ENDORSE_COST_K2', '—')} under Raft with LevelDB and {n.get('ENDORSE_COST_K3', '—')} "
                                 f"under SmartBFT, but {n.get('ENDORSE_COST_K1', '—')} in K1, where CouchDB rather than "
                                 f"endorsement bounded throughput")
    if "K2" in res and "K3" in res:
        n["BFT_COST"] = (f"nothing for custody initiation ({n['CAPM_K3_initiateSampleCustody']} against "
                         f"{n['CAPM_K2_initiateSampleCustody']} transactions per second) and up to {n['K3_COST_MAX']}% "
                         f"for other writes (median {n['K3_COST_MEDIAN']}%)")
    n["STORAGE_FILE"] = "docs/measurements/K1-storage.json"

    # Table 4: capacity and latency by operation
    hdr = ["Operation", "Capacity K1", "Capacity K2", "Capacity K3", "p50 / p95 K1", "p50 / p95 K2", "p50 / p95 K3"]
    rows = []
    for o, lab in WRITE_OPS + READ_OPS:
        row = [lab]
        for k, _ in CONFIGS:
            row.append(n.get(f"CAP_{k}_{o}", "—"))
        for k, _ in CONFIGS:
            r = res.get(k)
            lat = r["latency"].get(o) if r else None
            row.append(f"{statistics.mean(lat['p50']):.2f} / {statistics.mean(lat['p95']):.2f}" if lat else "—")
        rows.append(row)
    if base:
        for w, lab in (("baseline-telog", "Baseline: tamper-evident log, single operator (custody initiation)"),
                       ("baseline-couchdb", "Baseline: single CouchDB, no replication (custody initiation)")):
            b = base[w]
            sat = f"{b['saturation']:.0f}" if b["saturation"] else "—"
            lat = (f"{b['latencyP50']['mean']:.3f} / {b['latencyP95']['mean']:.3f}" if b["latencyP50"] else "—")
            rows.append([lab, sat, "", "", lat, "", ""])
    n["T4_HEADER"] = hdr
    n["T4_ROWS"] = rows

    # S11: sweep
    s11 = []
    for k, name in CONFIGS:
        r = res.get(k)
        if not r:
            continue
        for cc in SWEEP:
            v = r["sweep"].get(cc)
            if v:
                s11.append([name, str(cc), fmt(stats(v["tps"]), 1), fmt(stats(v["p50"]), 2), fmt(stats(v["p95"]), 2)])
    if base:
        for w, name in (("baseline-telog", "Tamper-evident log"), ("baseline-couchdb", "Single CouchDB")):
            for cc in SWEEP:
                v = base[w]["sweep"].get(cc)
                if v:
                    s11.append([name, str(cc), fmt(stats(v["tps"]), 0), fmt(stats(v["p50"]), 3), fmt(stats(v["p95"]), 3)])
    n["S11_HEADER"] = ["Configuration", "Outstanding transactions", "Committed s⁻¹", "Median latency (s)", "95th percentile (s)"]
    n["S11_ROWS"] = s11

    # S3: scenarios
    ref = scen.get("K2") or next((s for k, s in scen.items() if s), None)
    if ref:
        rule_of = {"R1_AAF_CONFIRMED": "R1", "R5_PROCESS_INVALIDATED": "R5", "R2_AAF_PENDING_REVIEW": "R2",
                   "R2B_ANALYSIS_REJECTED": "R2b", "R3_ABP_ALERT_INITIATED": "R3", "R4_WHEREABOUTS_ADRV": "R4"}
        n["S3_ROWS"] = [[f"{s['id']}. {s['title']}", s.get("regulation", ""), rule_of.get(s.get("rule"), "—"),
                         s["outcome"]] for s in ref["scenarios"]]

    # S4: the contract interface (submitter as enforced by each function's checks)
    s4 = [
        ("custody", "initiateSampleCustody", "Write", "NADO", "open the chain of custody (ISTI)"),
        ("custody", "acknowledgeSampleCollection", "Write", "athlete organisation", "athlete's attestation of the sealed container"),
        ("custody", "proposeCustodyTransfer", "Write", "NADO", "dispatch; record bound to NADO and laboratory"),
        ("custody", "acceptCustodyTransfer", "Write", "the laboratory named in the dispatch", "receipt; seal compared with acknowledgement"),
        ("custody", "registerProhibitedList", "Write", "NADO or laboratory", "hash-registered list revision, write-once"),
        ("custody", "recordSampleAnalysisResult", "Write, private (results)", "laboratory", "analysis result, write-once (Art. 2.1, 6.1)"),
        ("custody", "recordWhereaboutsStatus", "Write, private (results)", "NADO", "whereabouts failure status (Art. 2.4)"),
        ("custody", "recordPassportEvaluation", "Write, private (results)", "laboratory or NADO", "passport evaluation (Q003, Q004)"),
        ("custody", "triggerResultsManagement", "Write, private (results)", "NADO", "Table 1 decision, write-once (Art. 7.1, 7.2)"),
        ("custody", "proposeResultsAmendment", "Write, private (results)", "NADO or laboratory", "propose a change of outcome"),
        ("custody", "approveResultsAmendment", "Write, private (results, notice)", "the other organisation", "apply it; status report after notice (Art. 14.1.4)"),
        ("custody", "notifyAthleteOfAAF", "Write, private (results, notice)", "NADO", "notice to athlete and federation (Art. 7.2, 14.1.1-2)"),
        ("custody", "enforceOversightRequirement", "Write, private (results)", "NADO or laboratory", "named human review (GDPR Art. 22)"),
        ("custody", "recordProvisionalSuspension", "Write, private (results, notice)", "NADO", "only after an upholding review (Art. 7.4)"),
        ("custody", "enforceResultsConfidentiality", "Read", "any", "what the caller may read, and why (Art. 14.1)"),
        ("custody", "getResultsManagement", "Read, private", "NADO or laboratory", "decision, amendments, oversight, notice"),
        ("custody", "getSample", "Read", "any", "sample record"),
        ("custody", "getCustodyChain", "Read", "any", "custody events, acknowledgement, exceptions"),
        ("custody", "getSampleHistory", "Read", "any", "ledger history of a sample record"),
        ("custody", "evaluateDecisionTable", "Read", "any", "Table 1 logic without ledger access"),
        ("custody", "getOrganisationalClasses", "Read", "any", "the five classes"),
        ("consent", "applyDefaultPrivacySettings", "Write, private", "athlete organisation", "nothing shared by default (Art. 25(2))"),
        ("consent", "recordConsentTransaction", "Write, private", "athlete organisation", "grant or amend consent (Art. 7)"),
        ("consent", "withdrawConsent", "Write, private", "athlete organisation", "withdrawal (Art. 7(3))"),
        ("consent", "validateConsent", "Write, private", "any requester", "decide and record access (Art. 5, 7, 9)"),
        ("consent", "flagForHumanReview", "Write, private", "any", "suspend an automated decision (Art. 22)"),
        ("consent", "enforceOversightRequirement", "Write, private", "any", "named human review (Art. 22)"),
        ("consent", "registerOffchainPayload", "Write, private", "athlete organisation, laboratory or NADO", "pointer, key reference, keyed commitment"),
        ("consent", "revokeDataAccessKey", "Write, private", "athlete organisation", "reversible suspension"),
        ("consent", "restoreDataAccessKey", "Write, private", "athlete organisation", "recovery with the athlete among the holders"),
        ("consent", "destroyIPFSAccessToken", "Write, private", "athlete organisation", "erasure and Art. 17(2) notice"),
        ("consent", "getAccessDecision", "Read, private", "the requester or athlete organisation", "a recorded decision"),
        ("consent", "previewConsentDecision", "Read, private", "any", "evaluate without recording"),
        ("consent", "enforceDataMinimisation", "Read", "any", "purpose ceiling (Art. 5(1)(c), 25(1))"),
        ("consent", "checkSpecialCategoryAuthorization", "Read, private", "any", "explicit Art. 9 authorisation"),
        ("consent", "getOversight", "Read, private", "any", "review flag and decision"),
        ("consent", "getOffchainPayload", "Read, private", "any", "registered pointer"),
        ("consent", "getErasureRecord", "Read, private", "athlete organisation", "erasure record and recipients"),
        ("consent", "getConsent", "Read, private", "athlete organisation or grantee", "one consent record"),
        ("consent", "listConsents", "Read, private", "athlete organisation", "an athlete's consent records"),
        ("consent", "listAccessDecisions", "Read, private", "athlete organisation", "an athlete's access decisions"),
        ("consent", "getDataCategories", "Read", "any", "the six categories and purpose ceilings"),
    ]
    assert sum(1 for r in s4 if r[0] == "custody") == n["N_CUSTODY_TX"], "S4 custody rows out of date"
    assert sum(1 for r in s4 if r[0] == "consent") == n["N_CONSENT_TX"], "S4 consent rows out of date"
    n["S4_ROWS"] = [list(r) for r in s4]

    # insider
    if insider:
        n["INSIDER"] = insider
        def word(v):
            if v == "COMMITTED":
                return "Succeeded (committed)"
            if v == "ENDORSEMENT_POLICY_FAILURE":
                return "Rejected at validation"
            if str(v).startswith("REFUSED"):
                return "Refused by both endorsing peers"
            return str(v)
        pr, rv = insider["previouslyReported"], insider["revised"]
        n["INSIDER_V1_OWN_OVERWRITE"] = word(pr["pinned"]["overwriteResultsManagement"])
        n["INSIDER_V1_BOTH_OVERWRITE"] = word(pr["both"]["overwriteResultsManagement"])
        n["INSIDER_V1_OWN_RECEIPT"] = word(pr["pinned"]["recordLaboratoryReceiptAsNado"])
        n["INSIDER_V1_BOTH_RECEIPT"] = word(pr["both"]["recordLaboratoryReceiptAsNado"])
        same = lambda a, b: word(a) if word(a) == word(b) else f"{word(a)} / {word(b)}"
        n["INSIDER_V2_OVERWRITE"] = same(rv["pinned"]["overwriteResultsManagement"], rv["both"]["overwriteResultsManagement"])
        n["INSIDER_V2_RECEIPT"] = same(rv["pinned"]["recordLaboratoryReceiptAsNado"], rv["both"]["recordLaboratoryReceiptAsNado"])

    evaluation = {"configurations": res, "baselines": base, "cpu": {k: {kk: vv for kk, vv in c.items() if kk != "samples"}
                                                                    for k, c in cpu.items()}}
    (ROOT / "docs" / "evaluation-summary.json").write_text(json.dumps(evaluation, indent=1, default=str), encoding="utf8")
    (ROOT / "manuscript-build").mkdir(exist_ok=True)
    (ROOT / "manuscript-build" / "numbers_auto.json").write_text(json.dumps(n, indent=1, ensure_ascii=False), encoding="utf8")

    FIG.mkdir(parents=True, exist_ok=True)
    if res and not no_figures:
        figure_performance(res, base, FIG / "Fig-performance.png")
        figure_drift(res, FIG / "FigS-drift.png")
    if cpu and not no_figures:
        figure_cpu(cpu, FIG / "FigS-cpu.png")
    print(json.dumps({k: v for k, v in n.items() if not isinstance(v, (list, dict))}, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
