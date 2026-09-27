"""Materialize new, contract-authored Weave judgment-site examples.

Keep old and new corpora separate. This validates structural and exact-text
independence, not the truth of the authored labels or source-family separation.
"""
import argparse
import json
from pathlib import Path
import re
import unicodedata

import collect


HERE = Path(__file__).resolve().parent
NEW = (HERE / "collection-match-v2.json", HERE / "collection-evaluate-v2.json")
OLD = (HERE / "collection-match.json", HERE / "collection-evaluate.json")
DEFAULT_OUTPUT = collect.ROOT / ".local/gliner-decide/weave-v2"


def normalized(text):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).strip()).casefold()


def check_independence(new_rows, old_rows):
    old_groups = {x["group"] for x in old_rows}
    old_text = {normalized(x["text"]) for x in old_rows}
    reused_groups = {x["group"] for x in new_rows} & old_groups
    if reused_groups:
        raise ValueError(f"reused group: {sorted(reused_groups)[:3]}")
    reused_text = {normalized(x["text"]) for x in new_rows} & old_text
    if reused_text:
        raise ValueError(f"reused text: {sorted(reused_text)[:3]}")


def prepare(output):
    if output.exists():
        raise FileExistsError(output)
    old_rows = [x for path in OLD for x in collect.expand(path)]
    new_rows = [x for path in NEW for x in collect.expand(path)]
    check_independence(new_rows, old_rows)
    if len({x["id"] for x in new_rows}) != len(new_rows):
        raise ValueError("duplicate new IDs")
    old_labels = {x["site"]: set(x["labels"]) for x in old_rows}
    for x in new_rows:
        if set(x["labels"]) != old_labels[x["site"]]:
            raise ValueError(f"label vocabulary changed for {x['site']}")
    original = collect.SOURCES
    try:
        collect.SOURCES = NEW
        result = collect.build(output)
    finally:
        collect.SOURCES = original
    (output / "independence.json").write_text(json.dumps({
        "status": "exact input and group ID separation only; semantic label review required",
        "old_source_sha256": {p.name: collect.digest(p) for p in OLD},
        "new_source_sha256": {p.name: collect.digest(p) for p in NEW},
        "old_rows": len(old_rows), "new_rows": len(new_rows),
    }, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    print(json.dumps(prepare(args.output), indent=2))
