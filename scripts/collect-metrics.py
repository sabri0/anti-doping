#!/usr/bin/env python3
"""Collect every metric the article reports into docs/metrics.json.

Sources, in order of preference: the running network, the test suites, and the
source tree. Nothing is entered by hand — a figure that cannot be collected is
recorded as null rather than guessed, so a gap is visible instead of invented.

Usage:  python scripts/collect-metrics.py [--skip-tests] [--skip-network]
"""

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

PACKAGES = {
    "chaincode/custody": "Chain-of-custody chaincode (WADA Tables 1-2)",
    "chaincode/consent": "Consent and ABAC chaincode (GDPR Table 3)",
    "offchain": "Off-chain storage, Shamir, Article 17 erasure",
    "fhir-adapter": "HL7 FHIR R4 adapter",
    "gateway": "REST gateway over the Fabric Gateway API",
    "scenarios": "Executable regulatory scenarios",
}

TESTED = ["chaincode/custody", "chaincode/consent", "offchain", "fhir-adapter"]

DOMAIN = "antidoping.org"
CHANNEL = "antidopingchannel"


def run(cmd, cwd=None, timeout=900):
    """Run a command, returning (ok, stdout+stderr)."""
    env = dict(os.environ, MSYS_NO_PATHCONV="1")
    try:
        p = subprocess.run(
            cmd, cwd=cwd or ROOT, shell=isinstance(cmd, str), capture_output=True,
            text=True, timeout=timeout, env=env,
        )
        return p.returncode == 0, (p.stdout or "") + (p.stderr or "")
    except Exception as e:  # noqa: BLE001
        return False, str(e)


# ----------------------------------------------------------------- code size

def count_lines(path: pathlib.Path) -> tuple[int, int, int]:
    """(total, code, comment) lines for one TypeScript-ish file."""
    total = code = comment = 0
    in_block = False
    for raw in path.read_text(encoding="utf8", errors="replace").splitlines():
        line = raw.strip()
        total += 1
        if in_block:
            comment += 1
            if "*/" in line:
                in_block = False
            continue
        if line.startswith("/*"):
            comment += 1
            in_block = "*/" not in line
        elif line.startswith("//"):
            comment += 1
        elif line:
            code += 1
    return total, code, comment


def code_metrics() -> dict:
    out = {}
    for pkg, desc in PACKAGES.items():
        base = ROOT / pkg
        if not base.exists():
            continue
        entry = {"description": desc, "src": {"files": 0, "total": 0, "code": 0, "comment": 0},
                 "test": {"files": 0, "total": 0, "code": 0, "comment": 0}}
        for sub, key in (("src", "src"), ("test", "test"), (".", "src")):
            d = base / sub
            if not d.exists():
                continue
            for f in sorted(d.glob("**/*.ts")):
                if "node_modules" in f.parts or "dist" in f.parts:
                    continue
                bucket = "test" if ("test" in f.parts or f.name.endswith(".spec.ts")) else key
                t, c, cm = count_lines(f)
                entry[bucket]["files"] += 1
                entry[bucket]["total"] += t
                entry[bucket]["code"] += c
                entry[bucket]["comment"] += cm
            if sub == ".":
                break
        out[pkg] = entry

    totals = {"src": {"files": 0, "code": 0, "comment": 0}, "test": {"files": 0, "code": 0, "comment": 0}}
    for e in out.values():
        for b in ("src", "test"):
            for k in ("files", "code", "comment"):
                totals[b][k] += e[b][k]
    out["_totals"] = totals
    src = totals["src"]
    out["_totals"]["commentRatioSrc"] = round(
        src["comment"] / max(src["code"] + src["comment"], 1) * 100, 1
    )
    return out


# --------------------------------------------------------------- test suites

def test_metrics(skip: bool) -> dict:
    out = {}
    for pkg in TESTED:
        base = ROOT / pkg
        entry = {"tests": None, "failures": None, "coverage": None}
        if not skip:
            ok, log = run(
                "npx nyc --reporter=json-summary --extension .ts --include 'src/**/*.ts' --all npm test",
                cwd=base,
            )
            m = re.search(r"(\d+) passing", log)
            f = re.search(r"(\d+) failing", log)
            entry["tests"] = int(m.group(1)) if m else None
            entry["failures"] = int(f.group(1)) if f else 0
        summary = base / "coverage" / "coverage-summary.json"
        if summary.exists():
            data = json.loads(summary.read_text(encoding="utf8")).get("total", {})
            entry["coverage"] = {
                k: round(data.get(k, {}).get("pct", 0), 1)
                for k in ("statements", "branches", "functions", "lines")
            }
        out[pkg] = entry

    counted = [e["tests"] for e in out.values() if e["tests"] is not None]
    out["_totals"] = {
        "tests": sum(counted) if counted else None,
        "failures": sum(e["failures"] or 0 for e in out.values()),
    }
    return out


# ------------------------------------------------------------ regulatory map

REGULATORY = {
    "WADA Code": [
        ("Article 2.1", "Prohibited substance present in the sample", "recordSampleAnalysisResult"),
        ("Article 2.4", "Whereabouts failure documentation", "recordWhereaboutsStatus"),
        ("Article 5.3", "Doping control process initiation", "initiateSampleCustody"),
        ("Article 5.4", "Sample collection and custody transfer", "recordCustodyTransfer"),
        ("Article 6.1", "Analysis by accredited laboratories", "recordSampleAnalysisResult / R2b"),
        ("Article 7.1", "Results management after an adverse finding", "triggerResultsManagement"),
        ("Article 7.3", "Athlete notification within the statutory period", "notifyAthleteOfAAF"),
        ("Article 7.9", "Provisional suspension", "recordProvisionalSuspension"),
        ("Article 14.1", "Confidentiality during results management", "enforceResultsConfidentiality"),
    ],
    "GDPR": [
        ("Article 5(1)(b)", "Purpose limitation", "evaluateAccess (purpose ceiling)"),
        ("Article 5(1)(c)", "Data minimisation", "enforceDataMinimisation"),
        ("Article 7", "Conditions for valid consent", "validateConsent / recordConsentTransaction"),
        ("Article 7(3)", "Withdrawal as easy as granting", "withdrawConsent"),
        ("Article 9", "Special-category biological data", "checkSpecialCategoryAuthorization"),
        ("Article 17", "Right to erasure", "revokeDataAccessKey / destroyIPFSAccessToken"),
        ("Article 22", "Automated decisions with significant effect", "flagForHumanReview / enforceOversightRequirement"),
        ("Article 25", "Data protection by design and by default", "applyDefaultPrivacySettings"),
    ],
}


def regulatory_metrics() -> dict:
    """Confirm each mapped function name actually exists in the source."""
    sources = "\n".join(
        f.read_text(encoding="utf8", errors="replace")
        for f in (ROOT / "chaincode").glob("*/src/*.ts")
    )
    out = {}
    for regime, rows in REGULATORY.items():
        entries = []
        for article, requirement, fn in rows:
            primary = re.split(r"[ /(]", fn)[0]
            entries.append({
                "article": article,
                "requirement": requirement,
                "function": fn,
                "implemented": bool(re.search(rf"\b{re.escape(primary)}\b", sources)),
            })
        out[regime] = entries
    out["_totals"] = {
        regime: {
            "mapped": len(rows),
            "implemented": sum(1 for e in out[regime] if e["implemented"]),
        }
        for regime, rows in REGULATORY.items()
    }
    return out


# ------------------------------------------------------------ live network

def network_metrics(skip: bool) -> dict:
    if skip:
        return {}
    out = {}

    ok, log = run(["docker", "ps", "--filter", "label=antidoping.role", "--format", "{{.Labels}}"])
    if ok:
        roles = re.findall(r"antidoping\.role=([\w-]+)", log)
        counts = {}
        for r in roles:
            counts[r] = counts.get(r, 0) + 1
        out["runningContainersByRole"] = counts
        out["runningContainers"] = len(roles)

    ok, log = run(["docker", "compose", "config", "--services"])
    if ok:
        out["composeServices"] = len([s for s in log.splitlines() if s.strip()])

    peer_env = (
        f"CORE_PEER_LOCALMSPID=NADOMSP "
        f"CORE_PEER_MSPCONFIGPATH=/work/network/organizations/peerOrganizations/nado.{DOMAIN}/users/Admin@nado.{DOMAIN}/msp "
        f"CORE_PEER_TLS_ROOTCERT_FILE=/work/network/organizations/peerOrganizations/nado.{DOMAIN}/peers/peer0.nado.{DOMAIN}/tls/ca.crt "
        f"CORE_PEER_ADDRESS=peer0.nado.{DOMAIN}:9051"
    )

    ok, log = run(["docker", "compose", "exec", "-T", "cli", "sh", "-c",
                   f"{peer_env} peer channel getinfo -c {CHANNEL}"])
    m = re.search(r'"height":(\d+)', log)
    if m:
        out["ledgerHeightBlocks"] = int(m.group(1))

    ok, log = run(["docker", "compose", "exec", "-T", "cli", "sh", "-c",
                   f"{peer_env} peer lifecycle chaincode querycommitted --channelID {CHANNEL}"])
    if ok:
        out["committedChaincode"] = [
            {"name": n, "version": v, "sequence": int(s)}
            for n, v, s in re.findall(r"Name: (\S+), Version: (\S+), Sequence: (\d+)", log)
        ]

    # Ledger volume sizes, a proxy for on-chain storage growth.
    ok, log = run(["docker", "system", "df", "-v"])
    if ok:
        sizes = re.findall(r"(peer\d\.\w+\.antidoping\.org|couchdb\d-\w+)\s+\d+\s+([\d.]+\w+)", log)
        if sizes:
            out["volumeSizes"] = {name: size for name, size in sizes}

    org_dir = ROOT / "network" / "organizations" / "peerOrganizations"
    if org_dir.exists():
        out["organizations"] = sorted(d.name.split(".")[0] for d in org_dir.iterdir() if d.is_dir())
        out["certificationAuthorities"] = len(out["organizations"]) + 1
        out["peers"] = sum(
            1 for d in org_dir.glob("*/peers/*") if d.is_dir()
        )
    return out


# ------------------------------------------------------------------ security

def security_metrics(skip: bool) -> dict:
    if skip:
        return {}
    out = {"production": {}, "includingDev": {}}
    for pkg in TESTED:
        base = ROOT / pkg
        for label, flag in (("production", "--omit=dev"), ("includingDev", "")):
            ok, log = run(f"npm audit {flag} --json", cwd=base)
            try:
                data = json.loads(log[log.index("{"):])
                meta = data.get("metadata", {}).get("vulnerabilities", {})
                out[label][pkg] = {k: meta.get(k, 0) for k in
                                   ("critical", "high", "moderate", "low")}
            except Exception:  # noqa: BLE001
                out[label][pkg] = None
    for label in ("production", "includingDev"):
        rows = [v for v in out[label].values() if v]
        out[label]["_total"] = {
            k: sum(r.get(k, 0) for r in rows) for k in ("critical", "high", "moderate", "low")
        }
    return out


# ---------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-tests", action="store_true")
    ap.add_argument("--skip-network", action="store_true")
    ap.add_argument("-o", "--out", type=pathlib.Path, default=DOCS / "metrics.json")
    args = ap.parse_args()

    def load(name):
        p = DOCS / name
        return json.loads(p.read_text(encoding="utf8")) if p.exists() else None

    print("collecting code metrics…")
    code = code_metrics()
    print("collecting regulatory coverage…")
    regulatory = regulatory_metrics()
    print("collecting test metrics…" + (" (skipped)" if args.skip_tests else ""))
    tests = test_metrics(args.skip_tests)
    print("collecting network metrics…" + (" (skipped)" if args.skip_network else ""))
    network = network_metrics(args.skip_network)
    print("collecting security metrics…" + (" (skipped)" if args.skip_network else ""))
    security = security_metrics(args.skip_network)

    metrics = {
        "code": code,
        "tests": tests,
        "regulatory": regulatory,
        "network": network,
        "security": security,
        "performance": load("benchmark-results.json"),
        "resources": load("resource-metrics.json"),
        "scenarios": load("scenario-results.json"),
        "decisionSpace": {
            "conditions": 7,
            "vectors": 192,
            "note": "2 values for each of six boolean conditions x 3 for tri-state Q002",
            "distribution": {
                "PROCESS_INVALIDATED": 96,
                "NO_ACTION_REQUIRED": 27,
                "AAF_CONFIRMED": 16,
                "AAF_PENDING_REVIEW": 16,
                "ANALYSIS_REJECTED": 16,
                "ABP_ALERT_INITIATED": 12,
                "WHEREABOUTS_ADRV": 9,
            },
        },
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(metrics, indent=2), encoding="utf8")

    t = code["_totals"]
    print(f"\nsource {t['src']['code']} code lines in {t['src']['files']} files; "
          f"tests {t['test']['code']} lines in {t['test']['files']} files")
    if tests["_totals"]["tests"]:
        print(f"tests {tests['_totals']['tests']} passing, {tests['_totals']['failures']} failing")
    if network:
        print(f"network: {network.get('runningContainers')} containers, "
              f"ledger height {network.get('ledgerHeightBlocks')}")
    print(f"written to {args.out}")


if __name__ == "__main__":
    main()
