#!/usr/bin/env python3
"""Build the Scientific Reports submission from the manuscript sources.

Inputs (all in this directory):
    main.md          main text with {{TOKEN}} placeholders
    methods.md       Methods section, substituted into main.md
    numbers.json     measured values, substituted into both
    tables.json      main and supplementary tables
    figures.json     figure sources and legends
    references.json  Nature-style references keyed by the ORIGINAL numbering

Outputs (into --out-dir):
    <title>.docx                 main manuscript, Scientific Reports format
    Supplementary Information.docx
    figures/Fig<N>.<ext>         one file per display figure
    wordcount.txt                countable word count report

References are renumbered by order of first citation; a reference that is never
cited is dropped and reported, and a citation to a missing reference is a hard
error rather than a silent gap.
"""

import argparse
import json
import pathlib
import re
import shutil
import sys

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

HERE = pathlib.Path(__file__).resolve().parent

# ------------------------------------------------------------------ formatting

INLINE = re.compile(r"(\*\*.+?\*\*|\*.+?\*|\^[^\s^]+?\^)")


def add_runs(paragraph, text, base_italic=False, base_bold=False):
    """Write `text` into `paragraph`, honouring **bold**, *italic* and ^super^."""
    for part in INLINE.split(text):
        if not part:
            continue
        bold, italic, sup = base_bold, base_italic, False
        body = part
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            bold, body = True, part[2:-2]
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            italic, body = True, part[1:-1]
        elif part.startswith("^") and part.endswith("^") and len(part) > 2:
            sup, body = True, part[1:-1]
        run = paragraph.add_run(body)
        run.bold = bold
        run.italic = italic
        run.font.superscript = sup


def para(doc, text="", *, size=11, bold=False, italic=False, align=None,
         space_after=6, space_before=0, style=None, keep_with_next=False):
    p = doc.add_paragraph(style=style)
    fmt = p.paragraph_format
    fmt.space_after = Pt(space_after)
    fmt.space_before = Pt(space_before)
    fmt.line_spacing = 1.5
    fmt.keep_with_next = keep_with_next
    if align is not None:
        p.alignment = align
    add_runs(p, text, base_italic=italic, base_bold=bold)
    for run in p.runs:
        run.font.size = Pt(size)
        run.font.name = "Times New Roman"
    return p


def heading(doc, text, level=1):
    sizes = {1: 13, 2: 11.5}
    p = para(doc, text, size=sizes.get(level, 11), bold=True,
             space_before=14 if level == 1 else 10, space_after=6,
             keep_with_next=True)
    if level == 2:
        for run in p.runs:
            run.italic = True
    return p


def set_cell(cell, text, *, bold=False, size=9):
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.line_spacing = 1.0
    add_runs(p, text, base_bold=bold)
    for run in p.runs:
        run.font.size = Pt(size)
        run.font.name = "Times New Roman"
        if bold:
            run.bold = True


def add_table(doc, spec, label):
    """One display table: caption above, grid, footnote below."""
    cap = para(doc, "", space_after=4, keep_with_next=True)
    r = cap.add_run(f"{label} | ")
    r.bold = True
    r.font.size = Pt(10)
    r.font.name = "Times New Roman"
    add_runs(cap, spec["caption"])
    for run in cap.runs[1:]:
        run.font.size = Pt(10)
        run.font.name = "Times New Roman"

    header, rows = spec["header"], spec["rows"]
    table = doc.add_table(rows=1, cols=len(header))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True
    for cell, text in zip(table.rows[0].cells, header):
        set_cell(cell, text, bold=True)
    for row in rows:
        cells = table.add_row().cells
        for cell, text in zip(cells, row):
            set_cell(cell, text)

    if spec.get("note"):
        para(doc, spec["note"], size=9, space_before=4, space_after=12)
    else:
        para(doc, "", size=9, space_after=8)


def add_page_numbers(section):
    """Page numbers in the footer, which Scientific Reports asks for at review."""
    p = section.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    for instr, kind in (("begin", None), (None, "PAGE"), ("end", None)):
        el = OxmlElement("w:fldChar") if kind is None else OxmlElement("w:instrText")
        if kind is None:
            el.set(qn("w:fldCharType"), instr)
        else:
            el.set(qn("xml:space"), "preserve")
            el.text = " PAGE "
        run._r.append(el)
    run.font.size = Pt(10)
    run.font.name = "Times New Roman"


def add_line_numbers(section):
    """Continuous line numbering, recommended for review."""
    sect_pr = section._sectPr
    ln = OxmlElement("w:lnNumType")
    ln.set(qn("w:countBy"), "1")
    ln.set(qn("w:restart"), "continuous")
    ln.set(qn("w:distance"), "360")
    sect_pr.append(ln)


# ------------------------------------------------------------------ references

CITE = re.compile(r"\^([\d,–\-]+)\^")


def renumber(text_blocks, refs):
    """Renumber citations by order of first appearance across `text_blocks`."""
    order, mapping = [], {}

    def expand(group):
        out = []
        for part in group.split(","):
            part = part.strip()
            if "–" in part or "-" in part:
                lo, hi = re.split("[–-]", part)
                out.extend(str(i) for i in range(int(lo), int(hi) + 1))
            else:
                out.append(part)
        return out

    for block in text_blocks:
        for match in CITE.finditer(block):
            for old in expand(match.group(1)):
                if old not in mapping:
                    if old not in refs:
                        sys.exit(f"citation to unknown reference {old}")
                    mapping[old] = len(order) + 1
                    order.append(old)

    def rewrite(block):
        def sub(match):
            news = sorted(mapping[o] for o in expand(match.group(1)))
            # Collapse runs of three or more into a range, as Nature style does.
            parts, i = [], 0
            while i < len(news):
                j = i
                while j + 1 < len(news) and news[j + 1] == news[j] + 1:
                    j += 1
                parts.append(f"{news[i]}–{news[j]}" if j - i >= 2 else
                             ",".join(str(n) for n in news[i:j + 1]))
                i = j + 1
            return f"^{','.join(parts)}^"
        return CITE.sub(sub, block)

    ordered_refs = [refs[old] for old in order]
    unused = [k for k in refs if k not in mapping and not k.startswith("_")]
    return rewrite, ordered_refs, unused


# ------------------------------------------------------------------- documents

def parse_md(text):
    """Markdown subset -> list of ('h1'|'h2'|'p', text)."""
    blocks = []
    for raw in text.split("\n"):
        line = raw.rstrip()
        if not line.strip():
            continue
        if line.startswith("## "):
            blocks.append(("h2", line[3:].strip()))
        elif line.startswith("# "):
            blocks.append(("h1", line[2:].strip()))
        else:
            blocks.append(("p", line.strip()))
    return blocks


def countable_words(sections):
    """Scientific Reports counts Introduction, Results and Discussion."""
    return sum(len(t.split()) for kind, t in sections if kind == "p")


def build_main(cfg, out_path):
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Times New Roman"
    style.font.size = Pt(11)

    section = doc.sections[0]
    section.top_margin = section.bottom_margin = Inches(1)
    section.left_margin = section.right_margin = Inches(1)
    add_page_numbers(section)
    add_line_numbers(section)

    md = cfg["main_blocks"]
    body = {}
    current = None
    for kind, text in md:
        if kind == "h1":
            current = text
            body[current] = []
        else:
            body.setdefault(current, []).append((kind, text))

    def emit(name, blocks, level_map=None):
        for kind, text in blocks:
            if kind == "h2":
                heading(doc, text, 2)
            else:
                para(doc, text, align=WD_ALIGN_PARAGRAPH.JUSTIFY)

    # Title block
    para(doc, body["TITLE"][0][1], size=15, bold=True, space_after=10,
         align=WD_ALIGN_PARAGRAPH.LEFT)
    para(doc, body["AUTHORS"][0][1], size=11, space_after=8)
    for _, line in body["AFFILIATIONS"]:
        para(doc, line, size=9, space_after=1)
    para(doc, "")

    heading(doc, "Abstract")
    for _, text in body["ABSTRACT"]:
        para(doc, text, align=WD_ALIGN_PARAGRAPH.JUSTIFY)

    for name in ("INTRODUCTION", "RESULTS", "DISCUSSION", "METHODS"):
        heading(doc, name.capitalize() if name != "METHODS" else "Methods")
        emit(name, body[name])

    for name, title in (("DATA AVAILABILITY", "Data availability"),
                        ("CODE AVAILABILITY", "Code availability"),
                        ("ACKNOWLEDGEMENTS", "Acknowledgements"),
                        ("AUTHOR CONTRIBUTIONS", "Author contributions"),
                        ("ADDITIONAL INFORMATION", "Additional information")):
        heading(doc, title)
        emit(name, body[name])

    heading(doc, "References")
    for i, ref in enumerate(cfg["ordered_refs"], 1):
        p = para(doc, "", size=10, space_after=4)
        run = p.add_run(f"{i}. ")
        run.font.size = Pt(10)
        run.font.name = "Times New Roman"
        add_runs(p, ref)
        for run in p.runs:
            run.font.size = Pt(10)
            run.font.name = "Times New Roman"

    heading(doc, "Figure legends")
    for i, fig in enumerate(cfg["figures"], 1):
        p = para(doc, "", space_after=8, align=WD_ALIGN_PARAGRAPH.JUSTIFY)
        run = p.add_run(f"Fig. {i} | ")
        run.bold = True
        add_runs(p, f"**{fig['title']}** {fig['legend']}")
        for run in p.runs:
            run.font.size = Pt(10)
            run.font.name = "Times New Roman"

    heading(doc, "Tables")
    for i, spec in enumerate(cfg["tables"], 1):
        add_table(doc, spec, f"Table {i}")

    # Figures last, one per page, so the text file carries the artwork too.
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    heading(doc, "Figures")
    for i, fig in enumerate(cfg["figures"], 1):
        para(doc, f"Fig. {i}", size=10, bold=True, space_after=4)
        doc.add_picture(str(fig["path"]), width=Inches(fig.get("width_in", 6.4)))
        doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
        if i < len(cfg["figures"]):
            doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    doc.save(out_path)


def build_supplementary(cfg, out_path):
    doc = Document()
    doc.styles["Normal"].font.name = "Times New Roman"
    doc.styles["Normal"].font.size = Pt(11)
    section = doc.sections[0]
    section.top_margin = section.bottom_margin = Inches(1)
    section.left_margin = section.right_margin = Inches(1)
    add_page_numbers(section)

    para(doc, "Supplementary Information", size=15, bold=True, space_after=8)
    para(doc, cfg["supp_title"], size=12, italic=True, space_after=14)
    for text in cfg["supp_intro"]:
        para(doc, text, align=WD_ALIGN_PARAGRAPH.JUSTIFY)

    heading(doc, "Supplementary Tables")
    for i, spec in enumerate(cfg["supp_tables"], 1):
        add_table(doc, spec, f"Supplementary Table S{i}")

    heading(doc, "Supplementary Figures")
    for i, fig in enumerate(cfg["supp_figures"], 1):
        p = para(doc, "", space_after=4, align=WD_ALIGN_PARAGRAPH.JUSTIFY)
        run = p.add_run(f"Supplementary Fig. S{i} | ")
        run.bold = True
        add_runs(p, f"**{fig['title']}** {fig['legend']}")
        for run in p.runs:
            run.font.size = Pt(10)
            run.font.name = "Times New Roman"
        doc.add_picture(str(fig["path"]), width=Inches(6.2))
        doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
        para(doc, "", space_after=10)

    doc.save(out_path)


# ------------------------------------------------------------------------ main

def substitute(text, numbers, passes=5):
    """Substitute until nothing changes.

    Hand-written prose carries scalar tokens of its own, so a single pass would
    leave the tokens inside a just-inserted paragraph untouched.
    """
    for _ in range(passes):
        before = text
        for key, value in numbers.items():
            if isinstance(value, (list, dict)):
                # A structured value replaces the quoted placeholder, so that
                # "rows": "{{T2_ROWS}}" becomes a JSON array, not a string.
                text = text.replace('"{{%s}}"' % key, json.dumps(value, ensure_ascii=False))
            else:
                text = text.replace("{{%s}}" % key, str(value))
        if text == before:
            break
    left = re.findall(r"\{\{[A-Z0-9_]+\}\}", text)
    return text, left


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", type=pathlib.Path, required=True)
    ap.add_argument("--media", type=pathlib.Path, required=True,
                    help="directory holding image1.png … extracted from the original")
    ap.add_argument("--diagrams", type=pathlib.Path, required=True)
    ap.add_argument("--repo", type=pathlib.Path, required=True)
    ap.add_argument("--allow-missing", action="store_true")
    args = ap.parse_args()

    # Measured values come from fill_numbers.py; prose that needs judgement
    # is hand-written. Prose wins on a key collision, which never happens by
    # design: the two files hold disjoint keys.
    numbers = json.loads((HERE / "numbers_auto.json").read_text(encoding="utf8"))
    numbers.update(json.loads((HERE / "prose.json").read_text(encoding="utf8")))
    methods = (HERE / "methods.md").read_text(encoding="utf8")
    main_md = (HERE / "main.md").read_text(encoding="utf8")
    tables = json.loads((HERE / "tables.json").read_text(encoding="utf8"))
    figures = json.loads((HERE / "figures.json").read_text(encoding="utf8"))
    refs = json.loads((HERE / "references.json").read_text(encoding="utf8"))

    methods, _ = substitute(methods, numbers)
    main_md = main_md.replace("{{METHODS}}", methods)
    main_md, leftover = substitute(main_md, numbers)
    if leftover and not args.allow_missing:
        sys.exit(f"unsubstituted tokens: {sorted(set(leftover))}")

    tables_text = json.dumps(tables)
    tables_text, _ = substitute(tables_text, numbers)
    tables = json.loads(tables_text)
    figures_text, _ = substitute(json.dumps(figures), numbers)
    figures = json.loads(figures_text)

    # Reference renumbering across every block that can carry a citation.
    #
    # The title block is excluded. Author affiliation markers use the same
    # superscript syntax as citations, and feeding them to the renumberer maps
    # references 1..10 to the affiliation order rather than to the order in
    # which the text first cites them.
    head, sep, body = main_md.partition("# ABSTRACT")
    if not sep:
        sys.exit("no ABSTRACT heading: cannot separate the title block from the body")
    citing = [body, json.dumps(tables), json.dumps(figures)]
    rewrite, ordered_refs, unused = renumber(citing, refs)
    main_md = head + sep + rewrite(body)
    tables = json.loads(rewrite(json.dumps(tables)))
    figures = json.loads(rewrite(json.dumps(figures)))

    blocks = parse_md(main_md)

    # Word count of the countable sections only.
    countable, inside = 0, False
    for kind, text in blocks:
        if kind == "h1":
            inside = text in ("INTRODUCTION", "RESULTS", "DISCUSSION")
        elif inside and kind == "p":
            countable += len(text.split())

    out = args.out_dir
    (out / "figures").mkdir(parents=True, exist_ok=True)

    def resolve(src):
        if src.startswith("media/"):
            return args.media / src.split("/", 1)[1]
        if src.startswith("diagrams/"):
            return args.diagrams / src.split("/", 1)[1]
        return args.repo / src

    main_figs = []
    for i, fig in enumerate(figures["main"], 1):
        path = resolve(fig["source"])
        if not path.exists():
            sys.exit(f"missing figure source: {path}")
        shutil.copy(path, out / "figures" / f"Fig{i}{path.suffix}")
        if fig.get("vector"):
            vec = resolve(fig["vector"])
            if vec.exists():
                shutil.copy(vec, out / "figures" / f"Fig{i}{vec.suffix}")
        main_figs.append({**fig, "path": path})

    supp_figs = []
    for i, fig in enumerate(figures["supplementary"], 1):
        path = resolve(fig["source"])
        if not path.exists():
            sys.exit(f"missing supplementary figure source: {path}")
        shutil.copy(path, out / "figures" / f"FigS{i}{path.suffix}")
        supp_figs.append({**fig, "path": path})

    title = next(t for k, t in blocks if k == "p")

    cfg = {
        "main_blocks": blocks,
        "ordered_refs": ordered_refs,
        "tables": tables["main"],
        "figures": main_figs,
        "supp_tables": tables["supplementary"],
        "supp_figures": supp_figs,
        "supp_title": title,
        "supp_intro": [numbers.get("SUPP_INTRO", "")],
    }

    main_path = out / "Manuscript (Scientific Reports).docx"
    build_main(cfg, main_path)
    build_supplementary(cfg, out / "Supplementary Information.docx")

    report = [
        f"countable words (Introduction + Results + Discussion): {countable}  [limit 4500]",
        f"references cited: {len(ordered_refs)}",
        f"references dropped as uncited: {sorted(unused, key=int) if unused else 'none'}",
        f"display items: {len(main_figs)} figures + {len(tables['main'])} tables "
        f"= {len(main_figs) + len(tables['main'])}  [limit 8]",
        f"supplementary: {len(supp_figs)} figures + {len(tables['supplementary'])} tables",
    ]
    (out / "wordcount.txt").write_text("\n".join(report), encoding="utf8")
    print("\n".join(report))
    print(f"\nwrote {main_path}")


if __name__ == "__main__":
    main()
