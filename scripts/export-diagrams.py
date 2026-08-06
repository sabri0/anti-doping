#!/usr/bin/env python3
"""Export every sequence diagram to PNG under docs/diagrams/.

Diagram sources live in scripts/gen-scenarios-doc.py, so the exported images and
the ones embedded in SCENARIOS.md and the HTML report are the same drawings —
there is no second copy to drift.

Rendering uses whichever renderer is available: a local `mmdc` (mermaid-cli) if
one is on PATH or given with --mmdc, otherwise the minlag/mermaid-cli container.
The local path drives an already-installed Chrome or Edge through Puppeteer, so
neither a Chromium download nor a container image is required.

THE TWO PATHS ARE NOT PIXEL-EQUIVALENT. Both render every diagram correctly, but
the container has none of the fonts named in THEME, so it substitutes one with
different metrics; text wraps at different points and the diagrams come out
taller. Rendered at the same base width, container output ran roughly 5-25%
taller per diagram. Pick one renderer and stay with it for a given figure set —
mixing them gives a set that does not look like a set. The committed PNGs under
docs/diagrams/ were produced by the local path.

Usage:
    python scripts/export-diagrams.py            # PNG at 3x
    python scripts/export-diagrams.py --svg      # also emit vector SVG
    python scripts/export-diagrams.py --scale 4
    python scripts/export-diagrams.py --mmdc /path/to/mmdc
"""

import argparse
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
IMAGE = "minlag/mermaid-cli:latest"

# Project palette (see web/index.html and docs/report.html), so exported
# diagrams sit alongside the platform UI rather than looking like defaults.
THEME = {
    "theme": "base",
    "themeVariables": {
        "background": "#FFFFFF",
        "primaryColor": "#E2F0EB",
        "primaryTextColor": "#0C1D24",
        "primaryBorderColor": "#2E9B82",
        "lineColor": "#4E635E",
        "secondaryColor": "#F6F9F8",
        "tertiaryColor": "#EAF0EE",
        "fontFamily": "IBM Plex Sans, Segoe UI, Helvetica, Arial, sans-serif",
        "fontSize": "15px",
        # sequence-diagram specifics
        "actorBkg": "#E2F0EB",
        "actorBorder": "#2E9B82",
        "actorTextColor": "#0C1D24",
        "actorLineColor": "#7C918B",
        "signalColor": "#1A3A44",
        "signalTextColor": "#0C1D24",
        "labelBoxBkgColor": "#F7EEDD",
        "labelBoxBorderColor": "#B87A25",
        "labelTextColor": "#0C1D24",
        "loopTextColor": "#0C1D24",
        "noteBkgColor": "#F6F9F8",
        "noteBorderColor": "#D3DDDA",
        "noteTextColor": "#1A3A44",
        "sequenceNumberColor": "#FFFFFF",
    },
    "sequence": {
        "diagramMarginX": 24,
        "diagramMarginY": 16,
        "actorMargin": 42,
        "boxMargin": 12,
        "messageAlign": "left",
        "wrap": True,
        "width": 190,
    },
}

# Stable, descriptive filenames: an image dropped into a manuscript should say
# what it is without the surrounding document.
NAMES = {
    "S1": "S1-aaf-confirmed",
    "S2": "S2-process-invalidated-incomplete-custody",
    "S3": "S3-aaf-pending-review",
    "S4": "S4-analysis-rejected-unaccredited-lab",
    "S5": "S5-whereabouts-adrv",
    "S6": "S6-abp-alert-expert-panel",
    "S7": "S7-insider-endorsement-blocked",
    "S8": "S8-article22-oversight-gate",
    "S9": "S9-purpose-limited-abac",
    "S10": "S10-consent-withdrawal",
    "S11": "S11-erasure-and-recovery",
    "S12": "S12-results-confidentiality",
    "S13": "S13-late-handover-exception",
}
FLOW_NAME = "F1-fabric-transaction-flow"


def load_diagrams():
    spec = importlib.util.spec_from_file_location(
        "gen_scenarios_doc", ROOT / "scripts" / "gen-scenarios-doc.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.DIAGRAMS, mod.FABRIC_FLOW


BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_browser() -> str | None:
    for candidate in BROWSERS:
        if pathlib.Path(candidate).exists():
            return candidate
    return None


def docker_ok() -> bool:
    try:
        return subprocess.run(
            ["docker", "image", "inspect", IMAGE],
            capture_output=True, timeout=60,
        ).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def find_mmdc(explicit: str | None) -> str | None:
    if explicit:
        return explicit if pathlib.Path(explicit).exists() else None
    return shutil.which("mmdc")


def render(out_dir: pathlib.Path, jobs, scale: int, fmt: str, mmdc: str | None) -> list[str]:
    """Render each .mmd to `fmt`. Returns the names that failed."""
    env = dict(os.environ, MSYS_NO_PATHCONV="1")
    failed = []

    for name in jobs:
        src, dst = out_dir / f"{name}.mmd", out_dir / f"{name}.{fmt}"
        if mmdc:
            cmd = [
                mmdc, "-i", str(src), "-o", str(dst),
                "-c", str(out_dir / "mermaid-config.json"),
                "-p", str(out_dir / "puppeteer-config.json"),
                "-b", "white",
            ]
        else:
            mount = str(out_dir.resolve()).replace("\\", "/")
            cmd = [
                "docker", "run", "--rm", "-v", f"{mount}:/data", IMAGE,
                "-i", f"/data/{name}.mmd", "-o", f"/data/{name}.{fmt}",
                "-c", "/data/mermaid-config.json", "-b", "white",
            ]
        if fmt == "png":
            cmd += ["--scale", str(scale)]

        p = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=env, shell=False)
        if p.returncode != 0 or not dst.exists():
            failed.append(name)
            detail = (p.stderr or p.stdout or "").strip().splitlines()
            print(f"  FAIL  {name}.{fmt}  {detail[-1] if detail else 'no output'}")
        else:
            print(f"  ok    {name}.{fmt}  ({dst.stat().st_size / 1024:.0f} KB)")
    return failed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", type=pathlib.Path, default=ROOT / "docs" / "diagrams")
    ap.add_argument("--scale", type=int, default=3, help="PNG pixel scale (default 3, print-usable)")
    ap.add_argument("--svg", action="store_true", help="also emit vector SVG")
    ap.add_argument("--keep-source", action="store_true", help="keep the .mmd sources")
    ap.add_argument("--mmdc", help="path to a local mermaid-cli binary")
    args = ap.parse_args()

    mmdc = find_mmdc(args.mmdc)
    if not mmdc and not docker_ok():
        sys.exit(
            "no renderer available. Either:\n"
            "  npm i -g @mermaid-js/mermaid-cli    (then re-run, or pass --mmdc)\n"
            f"  docker pull {IMAGE}\n"
        )
    print(f"renderer: {'local mmdc ' + mmdc if mmdc else 'container ' + IMAGE}")

    DIAGRAMS, FABRIC_FLOW = load_diagrams()
    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    (out / "mermaid-config.json").write_text(json.dumps(THEME, indent=2), encoding="utf8")

    if mmdc:
        browser = find_browser()
        if not browser:
            sys.exit("local mmdc found but no Chrome/Edge to drive it; use the container instead")
        print(f"browser:  {browser}")
        (out / "puppeteer-config.json").write_text(
            json.dumps({"executablePath": browser, "args": ["--no-sandbox"]}, indent=2),
            encoding="utf8",
        )

    jobs = []
    for sid, src in DIAGRAMS.items():
        name = NAMES.get(sid, sid)
        (out / f"{name}.mmd").write_text(src.strip() + "\n", encoding="utf8", newline="\n")
        jobs.append(name)
    (out / f"{FLOW_NAME}.mmd").write_text(FABRIC_FLOW.strip() + "\n", encoding="utf8", newline="\n")
    jobs.append(FLOW_NAME)

    print(f"rendering {len(jobs)} diagrams to {out} at scale {args.scale}\n")
    failed = render(out, jobs, args.scale, "png", mmdc)
    if args.svg:
        print()
        failed += render(out, jobs, args.scale, "svg", mmdc)

    if not args.keep_source:
        for name in jobs:
            (out / f"{name}.mmd").unlink(missing_ok=True)
        (out / "mermaid-config.json").unlink(missing_ok=True)
        (out / "puppeteer-config.json").unlink(missing_ok=True)

    produced = sorted(out.glob("*.png"))
    total = sum(p.stat().st_size for p in produced)
    print(f"\n{len(produced)} PNG files, {total / 1024 / 1024:.1f} MB total, in {out}")
    if failed:
        print(f"FAILED: {', '.join(failed)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
