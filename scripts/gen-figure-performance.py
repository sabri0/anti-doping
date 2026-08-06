#!/usr/bin/env python3
"""Manuscript performance figure, drawn from the replicated benchmark summary.

Four panels, each carrying one measure against one axis:

  a  committed throughput and achieved send rate against configured send rate
  b  mean end-to-end latency against configured send rate
  c  committed throughput against the volume of state already written
  d  committed throughput by regulatory operation

Panels a, b and d are drawn from docs/benchmark-summary.json, produced by
aggregate-replicates.py, so every mark carries the spread across replicates
rather than a single observation. Panel c is drawn from docs/state-scaling.json,
a single sequence of identical rounds on a freshly created network.

Panel titles are descriptive, not interpretive: conclusions belong in the text.
No caption text is drawn into the artwork — the legend carries it.

Emits PDF and SVG (vector, for submission) alongside a 400-dpi PNG.

Usage:  python scripts/gen-figure-performance.py
"""

import argparse
import json
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# Validated palette (light surface): all-pairs CVD dE 9.2, normal-vision dE 24.0.
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#8a8985"
BLUE = "#2a78d6"
ORANGE = "#eb6834"
AQUA = "#1baf7a"

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
    ax.set_facecolor(SURFACE)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(MUTED)
        ax.spines[side].set_linewidth(0.8)
    ax.tick_params(colors=INK_2, labelsize=8, length=3, width=0.8)
    ax.grid(True, axis="y", color=MUTED, alpha=0.25, linewidth=0.6)
    ax.set_axisbelow(True)


def panel_label(ax, letter):
    ax.set_title(letter, fontsize=11, color=INK, loc="left", pad=8, fontweight="bold")


def err(s):
    """Asymmetric error bars from the observed range about the mean."""
    return ([s["mean"] - s["min"]], [s["max"] - s["mean"]])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-s", "--summary", type=pathlib.Path,
                    default=pathlib.Path("docs/benchmark-summary.json"))
    ap.add_argument("-c", "--scaling", type=pathlib.Path,
                    default=pathlib.Path("docs/state-scaling.json"))
    ap.add_argument("-o", "--out", type=pathlib.Path,
                    default=pathlib.Path("docs/figure-performance.png"))
    args = ap.parse_args()

    doc = json.loads(args.summary.read_text(encoding="utf8"))
    R = doc["rounds"]

    sweep = [(configured, R[label]) for label, configured in SWEEP if label in R]
    if not sweep:
        raise SystemExit("no usable sweep rounds in the summary")
    loads = [c for c, _ in sweep]

    fig, axes = plt.subplots(2, 2, figsize=(11.5, 8.2), facecolor=SURFACE)
    fig.subplots_adjust(wspace=0.30, hspace=0.34, left=0.075, right=0.985,
                        top=0.94, bottom=0.08)

    # ---- (a) throughput and achieved send rate vs configured send rate ------
    ax = axes[0][0]
    style_axes(ax)
    achieved = [r["sendRateTps"]["mean"] for _, r in sweep]
    ax.plot(loads, achieved, color=ORANGE, linewidth=1.6, marker="s", markersize=6,
            markerfacecolor=SURFACE, markeredgecolor=ORANGE, markeredgewidth=1.6,
            linestyle=(0, (5, 2)), zorder=2, label="Achieved send rate")
    tput = [r["throughputTps"]["mean"] for _, r in sweep]
    for x, r in sweep:
        ax.errorbar(x, r["throughputTps"]["mean"], yerr=err(r["throughputTps"]),
                    color=BLUE, capsize=3, linewidth=1.2, zorder=3)
    ax.plot(loads, tput, color=BLUE, linewidth=2, marker="o", markersize=7,
            markerfacecolor=BLUE, markeredgecolor=SURFACE, markeredgewidth=1.5,
            zorder=4, label="Committed throughput")
    peak = max(tput)
    for x, y in ((loads[0], tput[0]), (loads[tput.index(peak)], peak)):
        ax.annotate(f"{y:.1f}", xy=(x, y), xytext=(0, 10), textcoords="offset points",
                    ha="center", fontsize=8, color=INK, fontweight="bold")
    ax.set_xlabel("Configured send rate (transactions s⁻¹)", fontsize=8.5, color=INK_2)
    ax.set_ylabel("Rate (transactions s⁻¹)", fontsize=8.5, color=INK_2)
    ax.set_ylim(0, max(max(achieved), peak) * 1.25)
    ax.set_xticks(loads)
    ax.legend(loc="upper left", fontsize=7.5, frameon=False, labelcolor=INK_2)
    panel_label(ax, "a")

    # ---- (b) latency vs configured send rate --------------------------------
    ax = axes[0][1]
    style_axes(ax)
    lat = [r["avgLatencyS"]["mean"] for _, r in sweep]
    for x, r in sweep:
        ax.errorbar(x, r["avgLatencyS"]["mean"], yerr=err(r["avgLatencyS"]),
                    color=ORANGE, capsize=3, linewidth=1.2, zorder=3)
    ax.plot(loads, lat, color=ORANGE, linewidth=2, marker="o", markersize=7,
            markerfacecolor=ORANGE, markeredgecolor=SURFACE, markeredgewidth=1.5, zorder=4)
    for x, y in ((loads[0], lat[0]), (loads[-1], lat[-1])):
        ax.annotate(f"{y:.1f} s", xy=(x, y), xytext=(0, 10), textcoords="offset points",
                    ha="center", fontsize=8, color=INK, fontweight="bold")
    ax.set_xlabel("Configured send rate (transactions s⁻¹)", fontsize=8.5, color=INK_2)
    ax.set_ylabel("Mean end-to-end latency (s)", fontsize=8.5, color=INK_2)
    ax.set_ylim(0, max(r["avgLatencyS"]["max"] for _, r in sweep) * 1.25)
    ax.set_xticks(loads)
    panel_label(ax, "b")

    # ---- (c) throughput against accumulated state ---------------------------
    ax = axes[1][0]
    style_axes(ax)
    if args.scaling.exists():
        scaling = json.loads(args.scaling.read_text(encoding="utf8"))["rounds"]
        series = sorted((lbl, r) for lbl, r in scaling.items() if lbl.startswith("state-"))
        written, values = [], []
        cumulative = 0
        for _, r in series:
            written.append(cumulative)
            values.append(r["throughputTps"])
            cumulative += r["successful"]
        ax.plot(written, values, color=AQUA, linewidth=2, marker="o", markersize=6,
                markerfacecolor=AQUA, markeredgecolor=SURFACE, markeredgewidth=1.4, zorder=3)
        for x, y in ((written[0], values[0]), (written[-1], values[-1])):
            ax.annotate(f"{y:.1f}", xy=(x, y), xytext=(0, 10), textcoords="offset points",
                        ha="center", fontsize=8, color=INK, fontweight="bold")
        ax.set_ylim(0, max(values) * 1.25)
    ax.set_xlabel("Sample records already committed", fontsize=8.5, color=INK_2)
    ax.set_ylabel("Committed throughput (transactions s⁻¹)", fontsize=8.5, color=INK_2)
    panel_label(ax, "c")

    # ---- (d) throughput by regulatory operation -----------------------------
    ax = axes[1][1]
    style_axes(ax)
    ax.grid(True, axis="x", color=MUTED, alpha=0.25, linewidth=0.6)
    ax.grid(False, axis="y")
    rows = [(name, R[label]["throughputTps"], kind)
            for name, label, kind in OPERATIONS if label in R]
    rows.sort(key=lambda r: r[1]["mean"])
    ypos = list(range(len(rows)))
    colors = [BLUE if kind == "write" else AQUA for _, _, kind in rows]
    ax.barh(ypos, [s["mean"] for _, s, _ in rows], color=colors, height=0.68, zorder=3)
    for y, (_, s, _) in zip(ypos, rows):
        ax.errorbar(s["mean"], y, xerr=([s["mean"] - s["min"]], [s["max"] - s["mean"]]),
                    color=INK_2, capsize=2.5, linewidth=1.0, zorder=4)
        # Direct value labels on every bar: required for the aqua series
        # (contrast relief) and applied to both so the panel reads consistently.
        ax.annotate(f"{s['mean']:.1f}", xy=(s["max"], y), xytext=(5, 0),
                    textcoords="offset points", va="center", fontsize=7.5, color=INK)
    span = max(s["max"] for _, s, _ in rows)
    ax.set_yticks(ypos)
    ax.set_yticklabels([n for n, _, _ in rows], fontsize=7.5, color=INK_2)
    ax.set_xlabel("Committed throughput (transactions s⁻¹)", fontsize=8.5, color=INK_2)
    ax.set_xlim(0, span * 1.22)
    handles = [plt.Rectangle((0, 0), 1, 1, color=BLUE),
               plt.Rectangle((0, 0), 1, 1, color=AQUA)]
    ax.legend(handles, ["Endorsed write", "Read-only evaluation"], loc="lower right",
              fontsize=7.5, frameon=False, labelcolor=INK_2)
    panel_label(ax, "d")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.out, dpi=400, facecolor=SURFACE)
    fig.savefig(args.out.with_suffix(".pdf"), facecolor=SURFACE)
    fig.savefig(args.out.with_suffix(".svg"), facecolor=SURFACE)
    print(f"wrote {args.out}, .pdf and .svg  (n = {doc['replicates']} replicates)")


if __name__ == "__main__":
    main()
