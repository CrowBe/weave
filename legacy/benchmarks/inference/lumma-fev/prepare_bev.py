"""Freeze private BEV tool-suitability and order-paired tool-selection cases."""

from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import unicodedata


ROOT = Path(__file__).resolve().parents[3]
REVISION = "f83fe8b97094112fa305bfc793be07c8f8742282"
SOURCE = ROOT / ".local/bev-decision-150k" / REVISION / "data"
GLINER = ROOT / ".local/gliner-decide/bev-tool-v1"
OUT = ROOT / ".local/lumma-fev/bev"
TRAIN_SHA = "1b163182db155ba986c8ab8d3d582ac09ec1b1dcbc13c65d048e61379be9fe5b"
TEST_SHA = "eba9f9df6ad54ccdc3aa6516ab97e4f9dea4030422e0dc90510b85e462206a61"
CONTACT = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?://|\b\+?\d[\d ().-]{8,}\d\b", re.I)
OVERRIDE = re.compile(r"\b(?:ignore|disregard|forget|override|bypass)\b.{0,60}\b(?:previous|prior|above|earlier|all)\b.{0,35}\b(?:instructions|prompts|rules|messages)\b|\bDAN\b|developer mode", re.I | re.S)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def norm(value):
    return unicodedata.normalize("NFKC", value).strip().casefold()


def main():
    import pyarrow.parquet as pq

    if OUT.exists():
        raise FileExistsError(OUT)
    if digest(SOURCE / "train.parquet") != TRAIN_SHA or digest(SOURCE / "test.parquet") != TEST_SHA:
        raise ValueError("BEV source digest differs")
    manifest = json.loads((GLINER / "manifest.json").read_text())
    if digest(GLINER / "test.jsonl") != manifest["splits"]["test"]["sha256"]:
        raise ValueError("GLiNER tool-suitability split differs")
    gliner_data = jsonl(GLINER / "test.jsonl")
    gliner_index = jsonl(GLINER / "test-index.jsonl")
    gliner_report = json.loads((GLINER / "test-adapter.json").read_text())
    if len(gliner_data) != len(gliner_index) or len(gliner_data) != 105 or gliner_report["split_sha256"] != manifest["splits"]["test"]["sha256"]:
        raise ValueError("GLiNER test artifacts do not align")
    paired_gliner = {row["id"]: row for row in gliner_report["rows"]}
    if len(paired_gliner) != 105:
        raise ValueError("GLiNER report does not contain 105 unique IDs")

    # Read only the pinned source's fields needed for input/label validation.
    test = pq.read_table(SOURCE / "test.parquet", columns=["state", "questions_json"]).to_pylist()
    train = pq.read_table(SOURCE / "train.parquet", columns=["state", "questions_json"]).to_pylist()
    cases, labels = [], {}
    for item, meta in zip(gliner_data, gliner_index):
        prefix, index, target = meta["id"].split(":")
        if prefix != "test" or target != "should_call_available_tool":
            raise ValueError(f"unexpected GLiNER case ID {meta['id']}")
        row = test[int(index)]
        question = json.loads(row["questions_json"])[target]
        gold = question["label"]
        if type(gold) is not bool or row["state"] != item["input"] or meta["label"] != ("call" if gold else "skip"):
            raise ValueError(f"BEV/GLiNER label or state differs for {meta['id']}")
        reference = paired_gliner[meta["id"]]
        if reference["label"] != meta["label"] or reference["prediction"] not in ("call", "skip"):
            raise ValueError(f"GLiNER result differs for {meta['id']}")
        cases.append({"id": meta["id"], "slice": "tool_suitability", "state": row["state"],
                      "question_id": target,
                      "question": {k: question[k] for k in ("type", "instructions", "criteria") if k in question}})
        labels[meta["id"]] = {"gold": gold, "gliner_prediction": reference["prediction"]}

    # This BEV target puts the labeled option first throughout the pinned
    # source. Freeze one row per normalized request and probe both option orders.
    train_states = {norm(row["state"]) for row in train if "tool_selection" in json.loads(row["questions_json"])}
    eligible = {}
    order_counts = Counter()
    for index, row in enumerate(test):
        question = json.loads(row["questions_json"]).get("tool_selection")
        if question is None:
            continue
        keys = list(question.get("criteria", {}))
        if question.get("type") != "choice" or len(keys) != 2 or question.get("label") not in keys:
            raise ValueError(f"invalid tool_selection row {index}")
        order_counts[keys.index(question["label"])] += 1
        if not 20 <= len(row["state"]) <= 1400 or CONTACT.search(row["state"]) or OVERRIDE.search(row["state"]):
            continue
        if norm(row["state"]) in train_states:
            continue
        try:
            state = json.loads(row["state"])
        except json.JSONDecodeError:
            continue
        if set(state) != {"request", "available_tools"} or not isinstance(state["request"], str) or not isinstance(state["available_tools"], list):
            continue
        tool_names = [tool.get("name") for tool in state["available_tools"] if isinstance(tool, dict)]
        if len(tool_names) != 2 or set(tool_names) != set(keys):
            continue
        group = norm(state["request"])
        ident = f"test:{index}:tool_selection"
        if group not in eligible or ident < eligible[group][0]:
            eligible[group] = (ident, row, question)
    if order_counts != {0: 779}:
        raise ValueError(f"expected pinned first-option label pattern, got {order_counts}")
    selected = sorted(eligible.items(), key=lambda pair: hashlib.sha256(pair[0].encode()).hexdigest())[:24]
    if len(selected) != 24:
        raise ValueError("fewer than 24 distinct eligible tool-selection requests")
    for group, (ident, row, question) in selected:
        for order in ("original", "reversed"):
            criteria = question["criteria"] if order == "original" else dict(reversed(list(question["criteria"].items())))
            case_id = f"{ident}:{order}"
            cases.append({"id": case_id, "slice": "tool_selection", "group": hashlib.sha256(group.encode()).hexdigest(),
                          "order": order, "state": row["state"], "question_id": "tool_selection",
                          "question": {"type": "choice", "instructions": question["instructions"], "criteria": criteria}})
            labels[case_id] = {"gold": question["label"]}
    if len(cases) != 153 or len(labels) != 153 or len({case["id"] for case in cases}) != 153:
        raise ValueError("expected 105 suitability plus 48 order-paired selection presentations")

    OUT.mkdir(parents=True)
    (OUT / "cases.jsonl").write_text("".join(json.dumps(case, ensure_ascii=False) + "\n" for case in cases))
    (OUT / "labels.json").write_text(json.dumps(labels, indent=2) + "\n")
    report = {"dataset": "avbiswas/bev-decision-150K", "revision": REVISION,
              "source_sha256": {"train": TRAIN_SHA, "test": TEST_SHA},
              "gliner_test_sha256": manifest["splits"]["test"]["sha256"],
              "gliner_report_sha256": digest(GLINER / "test-adapter.json"),
              "selection": "105 existing filtered should_call_available_tool test rows; 24 tool_selection request groups by SHA256(normalized request), each in original and reversed option order",
              "tool_selection_gold_position_in_source": dict(order_counts),
              "counts": {"tool_suitability": 105, "tool_selection_presentations": 48, "tool_selection_groups": 24},
              "cases_sha256": digest(OUT / "cases.jsonl"), "labels_sha256": digest(OUT / "labels.json"),
              "status": "private exploratory source; raw text and labels retained under ignored .local"}
    (OUT / "manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
