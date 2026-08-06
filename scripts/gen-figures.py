#!/usr/bin/env python3
"""Regenerate the manuscript's Figure 6 from measured benchmark results.

Replaces the projected performance figure of the original submission. Every
value plotted comes from docs/benchmark-results.json, so the figure cannot
disagree with the run behind it.

Three panels, each carrying a single measure against one axis. A dual-axis
throughput/latency chart would have been more compact and is the standard way
this figure is drawn; it is avoided deliberately, because two y-scales on one
frame let the reader infer a crossover that is an artefact of the scaling.

Usage:  python scripts/gen-figures.py [-r docs/benchmark-results.json]
"""

import argparse
import json
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# Validated palette (light surface). Checked with the data-viz validator:
# all-pairs CVD dE 9.2, normal-vision dE 24.0. Aqua sits below 3:1 contrast on
# this surface, so every aqua mark carries a direct value label (relief rule).
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#8a8985"
BLUE = "#2a78d6"
ORANGE = "#eb6834"
AQUA = "#1baf7a"

# WADA operational demand line: ~330,000 samples analysed in 2022 at roughly 30
# custody transactions per sample, concentrated into peak testing periods (§5.1).
WADA_DEMAND_TPS = 27

SWEEP = [("sweep-10tps", 10), ("sweep-25tps", 25), ("sweep-50tps", 50), ("sweep-100tps", 100)]

OPERATIONS = [
    ("initiateSampleCustody", "endorse-1org-initiateSampleCustody", "write"),
    ("initiateSampleCustody (2-org)", "endorse-2org-initiateSampleCustody", "write"),
    ("recordCustodyTransfer", "recordCustodyTransfer", "write"),
    ("recordSampleAnalysisResult", "recordSampleAnalysisResult", "write"),
    ("triggerResultsManagement", "triggerResultsManagement", "write"),
    ("validateConsent", "validateConsent", "write"),
    ("getCustodyChain", "getCustodyChain", "read"),
    ("previewConsentDecision", "previewConsentDecision", "read"),
    ("evaluateDecisionTable", "evaluateDecisionTable", "read"),
]


def style_axes(ax):
    """Recessive frame: no top/right spine, muted grid behind the marks."""
    ax.set_facecolor(SURFACE)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(MUTED)
        ax.spines[side].set_linewidth(0.8)
    ax.tick_params(colors=INK_2, labelsize=8, length=3, width=0.8)
    ax.grid(True, axis="y", color=MUTED, alpha=0.25, linewidth=0.6)
    ax.set_axisbelow(True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-r", "--results", type=pathlib.Path,
                    default=pathlib.Path("docs/benchmark-results.json"))
    ap.add_argument("-o", "--out", type=pathlib.Path,
                    default=pathlib.Path("docs/figure6-measured-performance.png"))
    args = ap.parse_args()

    R = json.loads(args.results.read_text(encoding="utf8"))["rounds"]

    # Latency is absent when a round recorded no successful transaction; such a
    # round is not a measurement and must not be plotted as one.
    sweep = [
        (offered, R[label])
        for label, offered in SWEEP
        if label in R and R[label].get("avgLatencyS") is not None and R[label]["successful"] > 0
    ]
    if not sweep:
        raise SystemExit("no usable sweep rounds in results")
    loads = [o for o, _ in sweep]
    tput = [r["throughputTps"] for _, r in sweep]
    lat = [r["avgLatencyS"] for _, r in sweep]

    fig, axes = plt.subplots(1, 3, figsize=(14.5, 4.2), facecolor=SURFACE)
    # Generous wspace: panel (c) carries long operation names as y tick labels,
    # which extend left of its axis and would otherwise collide with panel (b).
    fig.subplots_adjust(wspace=0.46, left=0.05, right=0.99, top=0.84, bottom=0.30)

    # ---- (a) throughput against offered load -------------------------------
    ax = axes[0]
    style_axes(ax)
    ax.axhline(WADA_DEMAND_TPS, color=INK_2, linestyle=(0, (4, 3)), linewidth=1.2, zorder=1)
    ax.annotate(
        f"WADA peak operational demand ≈ {WADA_DEMAND_TPS} TPS",
        xy=(loads[0], WADA_DEMAND_TPS), xytext=(0, 5), textcoords="offset points",
        fontsize=7.5, color=INK_2,
    )
    ax.plot(loads, tput, color=BLUE, linewidth=2, marker="o", markersize=7,
            markerfacecolor=BLUE, markeredgecolor=SURFACE, markeredgewidth=1.5, zorder=3)

    peak = max(tput)
    peak_load = loads[tput.index(peak)]
    # Selective direct labels: the first point and the saturation point only.
    for x, y in ((loads[0], tput[0]), (peak_load, peak)):
        ax.annotate(f"{y:.1f}", xy=(x, y), xytext=(0, 9), textcoords="offset points",
                    ha="center", fontsize=8, color=INK, fontweight="bold")
    ax.set_xlabel("Offered load (TPS)", fontsize=8.5, color=INK_2)
    ax.set_ylabel("Measured throughput (TPS)", fontsize=8.5, color=INK_2)
    ax.set_title("(a)  Throughput saturates near "
                 f"{peak:.0f} TPS", fontsize=9.5, color=INK, loc="left", pad=8)
    ax.set_ylim(0, max(peak, WADA_DEMAND_TPS) * 1.35)
    ax.set_xticks(loads)

    # ---- (b) latency against offered load ----------------------------------
    ax = axes[1]
    style_axes(ax)
    ax.plot(loads, lat, color=ORANGE, linewidth=2, marker="o", markersize=7,
            markerfacecolor=ORANGE, markeredgecolor=SURFACE, markeredgewidth=1.5, zorder=3)
    for x, y in ((loads[0], lat[0]), (loads[-1], lat[-1])):
        ax.annotate(f"{y:.1f}s", xy=(x, y), xytext=(0, 9), textcoords="offset points",
                    ha="center", fontsize=8, color=INK, fontweight="bold")
    ax.set_xlabel("Offered load (TPS)", fontsize=8.5, color=INK_2)
    ax.set_ylabel("Mean end-to-end latency (s)", fontsize=8.5, color=INK_2)
    ax.set_title("(b)  Past saturation, load becomes queueing delay",
                 fontsize=9.5, color=INK, loc="left", pad=8)
    ax.set_ylim(0, max(lat) * 1.3)
    ax.set_xticks(loads)

    # ---- (c) throughput by regulatory operation ----------------------------
    ax = axes[2]
    style_axes(ax)
    ax.grid(True, axis="x", color=MUTED, alpha=0.25, linewidth=0.6)
    ax.grid(False, axis="y")

    rows = [
        (name, R[label]["throughputTps"], kind)
        for name, label, kind in OPERATIONS
        if label in R and R[label]["successful"] > 0
    ]
    if not rows:
        raise SystemExit("no usable per-operation rounds in results")
    rows.sort(key=lambda r: r[1])
    ypos = range(len(rows))
    colors = [BLUE if kind == "write" else AQUA for _, _, kind in rows]

    ax.barh(list(ypos), [v for _, v, _ in rows], color=colors, height=0.68, zorder=3)
    # Direct value labels on every bar. Required for the aqua series (contrast
    # relief) and applied to both so the panel reads consistently.
    span = max(v for _, v, _ in rows)
    for y, (_, value, _) in zip(ypos, rows):
        ax.annotate(f"{value:.1f}", xy=(value, y), xytext=(4, 0), textcoords="offset points",
                    va="center", fontsize=7.5, color=INK)
    ax.set_yticks(list(ypos))
    ax.set_yticklabels([n for n, _, _ in rows], fontsize=7.5, color=INK_2)
    ax.set_xlabel("Measured throughput (TPS)", fontsize=8.5, color=INK_2)
    ax.set_xlim(0, span * 1.18)
    ax.set_title("(c)  Throughput by regulatory operation",
                 fontsize=9.5, color=INK, loc="left", pad=8)

    handles = [
        plt.Rectangle((0, 0), 1, 1, color=BLUE),
        plt.Rectangle((0, 0), 1, 1, color=AQUA),
    ]
    ax.legend(handles, ["Endorsed write", "Read-only evaluation"], loc="lower right",
              fontsize=7.5, frameon=False, labelcolor=INK_2)

    fig.text(
        0.055, 0.055,
        "Measured with Hyperledger Caliper on a five-organization Hyperledger Fabric 2.5 network "
        "(10 peers, CouchDB state databases, Raft ordering).\n"
        "All 36 containers, including the load driver, share one host (8 vCPU / 11.6 GB); the "
        "figures characterise this deployment, not a provisioned cluster.",
        fontsize=7, color=INK_2, va="bottom",
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.out, dpi=200, facecolor=SURFACE)
    fig.savefig(args.out.with_suffix(".pdf"), facecolor=SURFACE)
    print(f"wrote {args.out} and {args.out.with_suffix('.pdf')}")
    print(f"peak throughput {peak:.1f} TPS at {peak_load} TPS offered load")


if __name__ == "__main__":
    main()
