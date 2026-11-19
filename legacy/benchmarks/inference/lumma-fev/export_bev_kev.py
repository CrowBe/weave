"""Export the frozen BEV tool-selection pair to the existing Kev sample runner."""

import json
from pathlib import Path

from prepare_bev import digest, jsonl, OUT as PRIVATE


def main():
    manifest = json.loads((PRIVATE / "manifest.json").read_text())
    if digest(PRIVATE / "cases.jsonl") != manifest["cases_sha256"] or digest(PRIVATE / "labels.json") != manifest["labels_sha256"]:
        raise ValueError("private BEV sample changed")
    cases = [case for case in jsonl(PRIVATE / "cases.jsonl") if case["slice"] == "tool_selection"]
    labels = json.loads((PRIVATE / "labels.json").read_text())
    if len(cases) != 48:
        raise ValueError("expected 48 paired choice presentations")
    export = []
    gold = []
    for case in cases:
        prefix, row_index, target, order = case["id"].split(":")
        if prefix != "test" or target != "tool_selection" or order not in ("original", "reversed"):
            raise ValueError(f"unexpected case ID {case['id']}")
        export.append({"id": case["id"], "row_index": int(row_index),
                       "domain": "Tool and workflow decisions", "type": "choice",
                       "question_key": case["question_id"], "state": case["state"],
                       "question": case["question"]})
        gold.append({"id": case["id"], "label": labels[case["id"]]["gold"]})
    cases_path = PRIVATE / "kev-cases.json"
    labels_path = PRIVATE / "kev-labels.json"
    if cases_path.exists() or labels_path.exists():
        raise FileExistsError("Kev export already exists")
    cases_path.write_text(json.dumps({"dataset": {"name": manifest["dataset"], "revision": manifest["revision"]},
                                      "selection": manifest["selection"], "cases": export}, indent=2) + "\n")
    labels_path.write_text(json.dumps({"dataset_revision": manifest["revision"], "labels": gold}, indent=2) + "\n")
    print(json.dumps({"cases": len(export), "cases_sha256": digest(cases_path),
                      "labels_sha256": digest(labels_path)}, indent=2))


if __name__ == "__main__":
    main()
