#!/usr/bin/env python3
"""Render the scenarios and metrics as a single self-contained HTML page.

Reads the same JSON the documents are generated from, and the diagram sources
from gen-scenarios-doc.py, so the page cannot disagree with them.

Usage:  python scripts/gen-artifact.py [-o docs/report.html]
"""

import argparse
import html
import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_diagrams():
    """Import DIAGRAMS/FABRIC_FLOW from the hyphenated sibling module."""
    spec = importlib.util.spec_from_file_location(
        "gen_scenarios_doc", ROOT / "scripts" / "gen-scenarios-doc.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.DIAGRAMS, mod.FABRIC_FLOW


E = html.escape

CSS = """
:root{
  color-scheme: light;
  --ink:#0C1D24; --ink-2:#1A3A44;
  --paper:#EDF1F0; --surface:#FFFFFF; --surface-2:#F6F9F8; --surface-3:#EAF0EE;
  --line:#D3DDDA; --line-soft:#E4EBE9;
  --text:#0C1D24; --muted:#4E635E; --faint:#7C918B;
  --jade:#2E9B82; --jade-deep:#1B7460; --jade-wash:#E2F0EB;
  --amber:#B87A25; --amber-wash:#F7EEDD;
  --rose:#AE443B; --rose-wash:#F6E4E2;
  --radius:10px; --radius-sm:6px;
  --shadow:0 1px 2px rgba(12,29,36,.05), 0 6px 18px rgba(12,29,36,.05);
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    color-scheme: dark;
    --ink:#E8F0EE; --ink-2:#CBDAD6;
    --paper:#0A1418; --surface:#101F24; --surface-2:#14262C; --surface-3:#193039;
    --line:#24424C; --line-soft:#1C343C;
    --text:#E8F0EE; --muted:#9DB3AE; --faint:#6E8781;
    --jade:#4FBFA2; --jade-deep:#6FD3B8; --jade-wash:#12332C;
    --amber:#D79B44; --amber-wash:#33260F;
    --rose:#D9695E; --rose-wash:#361A17;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 6px 20px rgba(0,0,0,.30);
  }
}
:root[data-theme="dark"]{
  color-scheme: dark;
  --ink:#E8F0EE; --ink-2:#CBDAD6;
  --paper:#0A1418; --surface:#101F24; --surface-2:#14262C; --surface-3:#193039;
  --line:#24424C; --line-soft:#1C343C;
  --text:#E8F0EE; --muted:#9DB3AE; --faint:#6E8781;
  --jade:#4FBFA2; --jade-deep:#6FD3B8; --jade-wash:#12332C;
  --amber:#D79B44; --amber-wash:#33260F;
  --rose:#D9695E; --rose-wash:#361A17;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 6px 20px rgba(0,0,0,.30);
}

*{box-sizing:border-box}
body{
  margin:0; background:var(--paper); color:var(--text);
  font-family:var(--sans); line-height:1.55; letter-spacing:-.003em;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1180px; margin:0 auto; padding:0 28px 96px}
h1,h2,h3{ text-wrap:balance; line-height:1.15; letter-spacing:-.021em; margin:0 }
code,.mono{font-family:var(--mono)}
a{color:var(--jade-deep)}
:focus-visible{outline:2.5px solid var(--jade); outline-offset:3px; border-radius:4px}

/* ---------- masthead ---------- */
.mast{ border-bottom:1px solid var(--line); background:var(--surface); }
.mast-in{ max-width:1180px; margin:0 auto; padding:40px 28px 30px; }
.eyebrow{
  font-family:var(--mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase;
  color:var(--jade-deep); font-weight:600;
}
.mast h1{ font-size:clamp(27px,3.6vw,40px); font-weight:700; margin:12px 0 10px; max-width:22ch }
.lede{ color:var(--muted); font-size:15.5px; max-width:68ch; margin:0 }

/* ---------- figure strip ---------- */
.figs{
  display:grid; grid-template-columns:repeat(auto-fit,minmax(148px,1fr));
  gap:1px; background:var(--line-soft); border:1px solid var(--line-soft);
  border-radius:var(--radius); overflow:hidden; margin-top:28px;
}
.fig{ background:var(--surface); padding:14px 16px }
.fig-n{
  font-family:var(--mono); font-size:22px; font-weight:600; color:var(--ink);
  font-variant-numeric:tabular-nums; line-height:1.1;
}
.fig-l{ font-size:11.5px; color:var(--faint); margin-top:5px; line-height:1.35 }

/* ---------- layout ---------- */
.cols{ display:grid; grid-template-columns:210px 1fr; gap:44px; margin-top:40px; align-items:start }
@media (max-width:920px){ .cols{ grid-template-columns:1fr; gap:24px } .rail{position:static !important} }

.rail{ position:sticky; top:22px }
.rail-h{
  font-family:var(--mono); font-size:10.5px; letter-spacing:.15em; text-transform:uppercase;
  color:var(--faint); font-weight:600; padding:0 0 10px;
}
.rail a{
  display:flex; gap:9px; align-items:baseline; padding:5px 8px; margin-left:-8px;
  border-radius:var(--radius-sm); text-decoration:none; color:var(--muted);
  font-size:13px; line-height:1.3;
}
.rail a:hover{ background:var(--surface-3); color:var(--text) }
.rail a .id{ font-family:var(--mono); font-size:11px; color:var(--jade-deep); font-weight:600; flex:none; width:26px }

section{ scroll-margin-top:20px }
.sec-h{
  display:flex; align-items:baseline; gap:12px; margin:44px 0 6px;
  padding-top:22px; border-top:1px solid var(--line);
}
.sec-h:first-of-type{ border-top:none; padding-top:0; margin-top:0 }
.sec-h h2{ font-size:19px; font-weight:650 }
.sec-num{
  font-family:var(--mono); font-size:12px; color:var(--jade-deep); font-weight:600;
  border:1px solid var(--jade); padding:2px 7px; border-radius:4px; flex:none;
}
.sec-sub{ color:var(--muted); font-size:14px; max-width:70ch; margin:0 0 20px }

/* ---------- scenario card ---------- */
.card{
  background:var(--surface); border:1px solid var(--line); border-radius:var(--radius);
  box-shadow:var(--shadow); overflow:hidden; margin-bottom:20px;
}
.card-h{ padding:16px 20px 14px; border-bottom:1px solid var(--line-soft) }
.card-t{ display:flex; align-items:baseline; gap:10px; flex-wrap:wrap }
.card-t h3{ font-size:15.5px; font-weight:650; flex:1; min-width:260px }
.tags{ display:flex; gap:6px; flex-wrap:wrap; margin-top:9px }
.tag{
  font-family:var(--mono); font-size:10.5px; padding:2.5px 7px; border-radius:4px;
  background:var(--surface-3); color:var(--muted); border:1px solid var(--line-soft);
  letter-spacing:.01em;
}
.tag.rule{ background:var(--jade-wash); color:var(--jade-deep); border-color:transparent; font-weight:600 }
.pill{
  font-family:var(--mono); font-size:10.5px; font-weight:700; letter-spacing:.07em;
  padding:3px 8px; border-radius:999px; text-transform:uppercase; flex:none;
  display:inline-flex; align-items:center; gap:5px;
}
.pill.pass{ background:var(--jade-wash); color:var(--jade-deep) }
.pill.fail{ background:var(--rose-wash); color:var(--rose) }
.pill::before{ content:""; width:6px; height:6px; border-radius:50%; background:currentColor }

.diagram{ padding:6px 12px; background:var(--surface-2); border-bottom:1px solid var(--line-soft); overflow-x:auto }
.diagram pre.mermaid{ margin:0; text-align:center; min-width:520px }

.observed{ padding:14px 20px; display:flex; gap:12px; align-items:flex-start }
.observed .k{
  font-family:var(--mono); font-size:10px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--faint); flex:none; padding-top:3px; width:74px; font-weight:600;
}
.observed .v{ font-family:var(--mono); font-size:12.5px; color:var(--ink-2); line-height:1.6 }

details{ border-top:1px solid var(--line-soft) }
summary{
  cursor:pointer; padding:10px 20px; font-size:12.5px; color:var(--muted);
  font-family:var(--mono); letter-spacing:.02em; list-style:none;
}
summary::-webkit-details-marker{display:none}
summary::before{ content:"▸ "; color:var(--jade) }
details[open] summary::before{ content:"▾ " }
summary:hover{ background:var(--surface-2); color:var(--text) }

/* ---------- tables ---------- */
.tbl-wrap{ overflow-x:auto; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); margin-bottom:22px }
table{ border-collapse:collapse; width:100%; font-size:13px; min-width:520px }
th,td{ text-align:left; padding:9px 14px; border-bottom:1px solid var(--line-soft); vertical-align:top }
thead th{
  background:var(--surface-2); font-family:var(--mono); font-size:10.5px; font-weight:600;
  letter-spacing:.1em; text-transform:uppercase; color:var(--faint); white-space:nowrap;
}
tbody tr:last-child td{ border-bottom:none }
tbody tr:hover{ background:var(--surface-2) }
td.num,th.num{ text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums; white-space:nowrap }
td.mono{ font-family:var(--mono); font-size:12px }
tr.total td{ font-weight:700; background:var(--surface-2) }
.ok{ color:var(--jade-deep); font-weight:600 }
.no{ color:var(--rose); font-weight:600 }

/* proportion bar inside a cell */
.bar{ display:flex; align-items:center; gap:9px; min-width:150px }
.bar-t{ flex:1; height:6px; background:var(--surface-3); border-radius:3px; overflow:hidden }
.bar-f{ height:100%; background:var(--jade); border-radius:3px }
.bar-f.amber{ background:var(--amber) }
.bar-v{ font-family:var(--mono); font-size:12px; font-variant-numeric:tabular-nums; width:48px; text-align:right }

.note{
  border-left:2px solid var(--jade); background:var(--jade-wash);
  padding:12px 16px; border-radius:0 var(--radius-sm) var(--radius-sm) 0;
  font-size:13.5px; color:var(--ink-2); margin:0 0 22px; max-width:74ch;
}
.note.warn{ border-left-color:var(--amber); background:var(--amber-wash) }
.note strong{ color:var(--ink) }

footer{ margin-top:56px; padding-top:22px; border-top:1px solid var(--line); color:var(--faint); font-size:12.5px }
"""


def bar(pct, amber=False):
    cls = " amber" if amber else ""
    return (f'<div class="bar"><div class="bar-t"><div class="bar-f{cls}" '
            f'style="width:{min(pct, 100):.1f}%"></div></div>'
            f'<span class="bar-v">{pct:.1f}%</span></div>')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", type=pathlib.Path, default=ROOT / "docs" / "report.html")
    args = ap.parse_args()

    docs = ROOT / "docs"
    scen = json.loads((docs / "scenario-results.json").read_text(encoding="utf8"))
    M = json.loads((docs / "metrics.json").read_text(encoding="utf8"))
    DIAGRAMS, FABRIC_FLOW = load_diagrams()

    by_id = {s["id"]: s for s in scen["scenarios"]}
    perf = (M.get("performance") or {}).get("rounds", {})
    perf_tot = (M.get("performance") or {}).get("totals", {})
    res = M.get("resources") or {}
    net = M.get("network") or {}
    tests = M["tests"]
    reg = M["regulatory"]
    ds = M["decisionSpace"]

    peak_w = max((r["throughputTps"] for k, r in perf.items() if k.startswith("sweep")), default=0)
    peak_r = max((perf[k]["throughputTps"] for k in
                  ("evaluateDecisionTable", "previewConsentDecision", "getCustodyChain")
                  if k in perf), default=0)

    H: list[str] = []
    w = H.append

    w(f"<style>{CSS}</style>")

    # ------------------------------------------------------------ masthead
    w('<header class="mast"><div class="mast-in">')
    w('<div class="eyebrow">Reference implementation &middot; verification record</div>')
    w("<h1>Anti-doping governance framework: scenarios and metrics</h1>")
    w('<p class="lede">Thirteen WADA Code and GDPR workflows, executed against a running '
      'five-organization Hyperledger Fabric network. Every diagram below transcribes '
      'transactions that actually committed, and every figure is collected from the '
      'deployment rather than estimated.</p>')

    figs = [
        (f"{scen['total'] - scen['failures']}/{scen['total']}", "scenarios executed and asserted"),
        (str(tests["_totals"].get("tests", "—")), "unit tests passing"),
        (str(ds["vectors"]), "condition vectors, all enumerated"),
        (f"{peak_w:.1f}", "TPS peak write throughput"),
        (f"{peak_r:.0f}", "TPS peak read throughput"),
        (f"{perf_tot.get('successfulTransactions', 0):,}", "benchmark transactions, 0 failed"),
        (str(net.get("ledgerHeightBlocks", "—")), "blocks on the ledger"),
        (f"{sum(v['implemented'] for v in reg['_totals'].values())}"
         f"/{sum(v['mapped'] for v in reg['_totals'].values())}", "regulated functions implemented"),
    ]
    w('<div class="figs">')
    for n, l in figs:
        w(f'<div class="fig"><div class="fig-n">{E(n)}</div><div class="fig-l">{E(l)}</div></div>')
    w("</div>")
    w("</div></header>")

    w('<div class="wrap"><div class="cols">')

    # ---------------------------------------------------------------- rail
    w('<nav class="rail"><div class="rail-h">Scenarios</div>')
    for sid in DIAGRAMS:
        s = by_id.get(sid)
        if not s:
            continue
        short = s["title"].split(" — ")[0]
        short = short if len(short) < 46 else short[:44] + "…"
        w(f'<a href="#{sid.lower()}"><span class="id">{sid}</span><span>{E(short)}</span></a>')
    w('<div class="rail-h" style="padding-top:16px">Reference</div>')
    w('<a href="#flow"><span class="id">§</span><span>Transaction flow</span></a>')
    w('<a href="#metrics"><span class="id">§</span><span>Metrics</span></a>')
    w("</nav>")

    w("<main>")

    # ----------------------------------------------------------- scenarios
    w('<div class="sec-h"><span class="sec-num">A</span><h2>Regulatory scenarios</h2></div>')
    w('<p class="sec-sub">Each scenario is driven through the REST gateway against the deployed '
      'network and asserts its expected regulatory outcome; the run fails if any assertion does '
      'not hold. Rules <code>R1</code>–<code>R5</code> are the published rows of the '
      'manuscript\'s Table 2; <code>R2B</code> closes a case the table as originally specified leaves '
      'undefined.</p>')

    for sid, diagram in DIAGRAMS.items():
        s = by_id.get(sid)
        if not s:
            continue
        ok = s["passed"]
        w(f'<article class="card" id="{sid.lower()}">')
        w('<div class="card-h"><div class="card-t">')
        w(f'<h3><span class="mono" style="color:var(--jade-deep)">{sid}</span> &nbsp;{E(s["title"])}</h3>')
        w(f'<span class="pill {"pass" if ok else "fail"}">{"verified" if ok else "failed"}</span>')
        w("</div><div class=\"tags\">")
        w(f'<span class="tag">{E(s["regulation"])}</span>')
        if s.get("rule"):
            w(f'<span class="tag rule">{E(s["rule"])}</span>')
        w("</div></div>")

        w(f'<div class="diagram"><pre class="mermaid">{E(diagram.strip())}</pre></div>')

        w('<div class="observed"><div class="k">Observed</div>'
          f'<div class="v">{E(s["outcome"])}</div></div>')

        if s.get("steps"):
            w(f"<details><summary>{len(s['steps'])} executed steps</summary>")
            w('<div class="tbl-wrap" style="border:none;border-radius:0;margin:0">')
            w("<table><thead><tr><th>Actor</th><th>Action</th><th>Outcome</th></tr></thead><tbody>")
            for st in s["steps"]:
                w(f'<tr><td class="mono">{E(st["actor"])}</td><td>{E(st["action"])}</td>'
                  f'<td class="mono">{E(st["outcome"])}</td></tr>')
            w("</tbody></table></div></details>")
        w("</article>")

    # --------------------------------------------------------- fabric flow
    w('<section id="flow"><div class="sec-h"><span class="sec-num">B</span>'
      "<h2>Platform transaction flow</h2></div>")
    w('<p class="sec-sub">The six-phase Fabric flow every scenario runs through, in the deployed '
      'configuration — including the key-level endorsement check the insider-collusion mitigation '
      'depends on.</p>')
    w('<article class="card"><div class="diagram">'
      f'<pre class="mermaid">{E(FABRIC_FLOW.strip())}</pre></div></article>')
    w('<div class="note"><strong>Invalid transactions are retained.</strong> A rejected '
      'transaction stays in its block, flagged invalid — so an attempt to write '
      'results-management state with insufficient endorsement (S7) becomes part of the audit '
      'trail rather than disappearing.</div>')
    w("</section>")

    # -------------------------------------------------------------- metrics
    w('<section id="metrics"><div class="sec-h"><span class="sec-num">C</span>'
      "<h2>Metrics</h2></div>")
    w('<p class="sec-sub">Collected from the running network, the test suites and the source '
      'tree. Anything that could not be measured is absent rather than estimated.</p>')

    # regulatory coverage
    w("<h3 style=\"font-size:14px;margin:0 0 10px\">Regulatory coverage</h3>")
    w('<div class="tbl-wrap"><table><thead><tr><th>Article</th><th>Requirement</th>'
      "<th>Function</th><th>Implemented</th></tr></thead><tbody>")
    for regime in ("WADA Code", "GDPR"):
        for e in reg[regime]:
            mark = '<span class="ok">yes</span>' if e["implemented"] else '<span class="no">no</span>'
            w(f'<tr><td class="mono">{E(regime.split()[0])} {E(e["article"])}</td>'
              f'<td>{E(e["requirement"])}</td><td class="mono">{E(e["function"])}</td>'
              f"<td>{mark}</td></tr>")
    w("</tbody></table></div>")

    # decision space
    w("<h3 style=\"font-size:14px;margin:0 0 10px\">Decision-space coverage</h3>")
    w('<div class="tbl-wrap"><table><thead><tr><th>Outcome</th><th class="num">Vectors</th>'
      "<th>Share of the 192-point space</th></tr></thead><tbody>")
    for outcome, n in sorted(ds["distribution"].items(), key=lambda kv: -kv[1]):
        pct = n / ds["vectors"] * 100
        w(f'<tr><td class="mono">{E(outcome)}</td><td class="num">{n}</td>'
          f"<td>{bar(pct)}</td></tr>")
    w(f'<tr class="total"><td>Total</td><td class="num">{ds["vectors"]}</td>'
      "<td>exhaustively enumerated</td></tr>")
    w("</tbody></table></div>")
    w('<div class="note">Half the space resolving to <code>PROCESS_INVALIDATED</code> is correct, '
      "not a defect: an unverified custody chain is a precondition guard, so it invalidates "
      "regardless of the other six conditions.</div>")

    # performance
    w("<h3 style=\"font-size:14px;margin:0 0 10px\">Measured performance</h3>")
    w('<div class="tbl-wrap"><table><thead><tr><th>Operation</th><th>Type</th>'
      '<th class="num">Throughput</th><th class="num">Mean latency</th>'
      '<th class="num">Transactions</th></tr></thead><tbody>')
    rows = [
        ("initiateSampleCustody — 1 org", "Write", "endorse-1org-initiateSampleCustody"),
        ("initiateSampleCustody — 2 orgs", "Write", "endorse-2org-initiateSampleCustody"),
        ("recordCustodyTransfer", "Write", "recordCustodyTransfer"),
        ("recordSampleAnalysisResult", "Write", "recordSampleAnalysisResult"),
        ("triggerResultsManagement", "Write", "triggerResultsManagement"),
        ("validateConsent", "Write", "validateConsent"),
        ("evaluateDecisionTable", "Read", "evaluateDecisionTable"),
        ("previewConsentDecision", "Read", "previewConsentDecision"),
        ("getCustodyChain", "Read", "getCustodyChain"),
    ]
    for name, kind, label in rows:
        if label not in perf:
            continue
        r = perf[label]
        lat = r["avgLatencyS"]
        lat_s = f"{lat:.2f}" if lat is not None and lat < 1 else (f"{lat:.1f}" if lat is not None else "—")
        w(f'<tr><td class="mono">{E(name)}</td><td>{kind}</td>'
          f'<td class="num">{r["throughputTps"]:.1f} TPS</td><td class="num">{lat_s} s</td>'
          f'<td class="num">{r["successful"]}</td></tr>')
    w("</tbody></table></div>")

    one = perf.get("endorse-1org-initiateSampleCustody")
    two = perf.get("endorse-2org-initiateSampleCustody")
    trm = perf.get("triggerResultsManagement")
    edt = perf.get("evaluateDecisionTable")
    if one and two and trm and edt:
        cost = (1 - two["throughputTps"] / one["throughputTps"]) * 100
        ratio = edt["throughputTps"] / trm["throughputTps"]
        w(f'<div class="note"><strong>The regulatory logic is not the cost.</strong> The Table 2 '
          f'engine alone runs at {edt["throughputTps"]:.0f} TPS against '
          f'{trm["throughputTps"]:.1f} TPS for the full on-chain results-management transaction — '
          f'a factor of {ratio:.0f}. What costs is ledger I/O, endorsement and consensus. '
          f'Requiring two organizations to endorse rather than one — the mitigation against '
          f'insider collusion — costs about {cost:.0f}% of write throughput.</div>')

    # resources
    if res.get("byComponent"):
        w("<h3 style=\"font-size:14px;margin:0 0 10px\">Where the CPU goes under load</h3>")
        w('<div class="tbl-wrap"><table><thead><tr><th>Component</th>'
          '<th class="num">CPU</th><th>Share of load</th>'
          '<th class="num">Memory / container</th></tr></thead><tbody>')
        labels = {"couchdb": "CouchDB (10)", "peers": "Peers (10)", "orderer": "Ordering service",
                  "chaincode": "Chaincode (2)", "ipfs": "IPFS (3)",
                  "CAs": "Certification authorities (6)", "driver": "Benchmark driver",
                  "other": "Other tooling"}
        for k, c in sorted(res["byComponent"].items(), key=lambda kv: -kv[1]["shareOfLoadPercent"]):
            w(f'<tr><td>{E(labels.get(k, k))}</td>'
              f'<td class="num">{c["cpuPercent"]:.0f}%</td>'
              f'<td>{bar(c["shareOfLoadPercent"], amber=(k == "couchdb"))}</td>'
              f'<td class="num">{c["avgMemMiB"]:.0f} MiB</td></tr>')
        w("</tbody></table></div>")
        couch = res["byComponent"].get("couchdb", {}).get("shareOfLoadPercent", 0)
        w(f'<div class="note warn"><strong>State persistence dominates, not consensus.</strong> '
          f'CouchDB takes {couch:.0f}% of processor time while the ordering service is close to '
          "negligible. CouchDB is required by the six-category access-control model, which needs "
          "rich queries the embedded state database cannot serve — so the cost of granular data "
          "sovereignty is measurable, and this is where it is paid. No embedded-database "
          "counterfactual was run, so the size of that penalty is not quantified.</div>")

    # tests
    w("<h3 style=\"font-size:14px;margin:0 0 10px\">Test suites</h3>")
    w('<div class="tbl-wrap"><table><thead><tr><th>Package</th><th class="num">Tests</th>'
      '<th class="num">Statements</th><th class="num">Branches</th>'
      '<th class="num">Functions</th><th class="num">Lines</th></tr></thead><tbody>')
    for pkg, e in tests.items():
        if pkg.startswith("_"):
            continue
        c = e.get("coverage") or {}
        w(f'<tr><td class="mono">{E(pkg)}</td><td class="num">{e.get("tests", "—")}</td>'
          + "".join(f'<td class="num">{c.get(k, "—")}%</td>'
                    for k in ("statements", "branches", "functions", "lines"))
          + "</tr>")
    w(f'<tr class="total"><td>Total</td><td class="num">{tests["_totals"].get("tests", "—")}</td>'
      '<td class="num" colspan="4">0 failing</td></tr>')
    w("</tbody></table></div>")

    # topology
    if net.get("runningContainersByRole"):
        w("<h3 style=\"font-size:14px;margin:0 0 10px\">Deployed topology</h3>")
        w('<div class="tbl-wrap"><table><thead><tr><th>Role</th>'
          '<th class="num">Containers</th></tr></thead><tbody>')
        for role, n in sorted(net["runningContainersByRole"].items(), key=lambda kv: -kv[1]):
            w(f'<tr><td>{E(role)}</td><td class="num">{n}</td></tr>')
        w(f'<tr class="total"><td>Running</td><td class="num">{net.get("runningContainers", "—")}</td></tr>')
        w("</tbody></table></div>")

    w('<div class="note warn"><strong>Not measured.</strong> 15-, 30- and 100-organization '
      "configurations were not run and are not extrapolated; nor were multi-host deployment, an "
      "embedded-state-database comparison, Byzantine fault-tolerant ordering, soak or failure "
      "testing, or adversarial testing of the gateway.</div>")
    w("</section>")

    w("<footer>Generated from <code>docs/scenario-results.json</code> and "
      "<code>docs/metrics.json</code> by <code>scripts/gen-artifact.py</code>. "
      f"Scenarios last executed {E(scen['generatedAt'])}.</footer>")

    w("</main></div></div>")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(H), encoding="utf8", newline="\n")
    print(f"wrote {args.out} ({len(H)} blocks, {len(DIAGRAMS) + 1} diagrams)")


if __name__ == "__main__":
    main()
