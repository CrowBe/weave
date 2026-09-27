"""Freeze a small, auditable BEV test-split smoke sample. Run with Kev's venv."""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
REVISION = "f83fe8b97094112fa305bfc793be07c8f8742282"
DATA = ROOT / ".local/bev-decision-150k" / REVISION / "data"
OUTPUT = ROOT / ".local/bev-decision-150k" / REVISION / "sample-v1"
SEED = "weave-bev-smoke-v1"
CELLS = [
    ("Support and intent routing", "choice", None, 4),
    ("Tool and workflow decisions", "choice", None, 4),
    ("Reading comprehension", "noul", "answer", 4),
    ("Tool and workflow decisions", "noul", "should_call_available_tool", 4),
    ("Retail, product, and shopping", "score", "invoice_value_band", 4),
    ("Sentiment, emotion, and moderation", "score", "sentiment", 4),
]
REVIEWED_EXCLUSIONS = {
    "test:7009:answer": "airport location wording makes the published false label ambiguous",
    "test:8655:should_call_available_tool": "place search could help the booking request, making the published false label ambiguous",
}
BALANCE = {
    ("Reading comprehension", "noul"): {"true": 2, "false": 2},
    ("Retail, product, and shopping", "score"): {"0": 2, "1+": 2},
}
CONTACT = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?://|\b\+?\d[\d ().-]{8,}\d\b", re.I)
OVERRIDE = re.compile(r"\b(?:ignore|disregard|forget|override|bypass)\b.{0,60}\b(?:previous|prior|above|earlier|all)\b.{0,35}\b(?:instructions|prompts|rules|messages)\b|\bDAN\b|developer mode", re.I | re.S)


def normalized(value):
    return unicodedata.normalize("NFKC", value).strip().casefold()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def eligible(state, q):
    if not isinstance(state, str) or not 20 <= len(state) <= 850:
        return False
    if CONTACT.search(state) or OVERRIDE.search(state):
        return False
    if set(q) - {"type", "instructions", "criteria", "label", "src"}:
        return False
    kind = q.get("type")
    if kind not in {"choice", "noul", "score"} or not isinstance(q.get("instructions"), (str, dict)):
        return False
    if CONTACT.search(json.dumps(q, ensure_ascii=False)) or OVERRIDE.search(json.dumps(q, ensure_ascii=False)):
        return False
    crit, label = q.get("criteria"), q.get("label")
    if kind == "choice":
        return isinstance(crit, dict) and 2 <= len(crit) <= 8 and label in crit
    if kind == "noul":
        return isinstance(label, bool) and (crit is None or isinstance(crit, dict))
    return isinstance(crit, list) and 3 <= len(crit) <= 7 and type(label) is int and 0 <= label < len(crit)


def label_bucket(kind, label):
    if kind == "noul":
        return str(label).lower()
    if kind == "score":
        return "0" if label == 0 else "1+"
    return str(label)


def main():
    train_path, test_path = DATA / "train.parquet", DATA / "test.parquet"
    assert sha(train_path) == "1b163182db155ba986c8ab8d3d582ac09ec1b1dcbc13c65d048e61379be9fe5b"
    assert sha(test_path) == "eba9f9df6ad54ccdc3aa6516ab97e4f9dea4030422e0dc90510b85e462206a61"
    train_states = {normalized(s) for s in pq.read_table(train_path, columns=["state"]).column("state").to_pylist()}
    test = pq.read_table(test_path).to_pylist()
    pools = {(domain, kind, qkey): [] for domain, kind, qkey, _ in CELLS}
    for i, row in enumerate(test):
        state = row["state"]
        if normalized(state) in train_states:
            continue
        for qid, q in json.loads(row["questions_json"]).items():
            cell = (row["domain"], q.get("type"), qid if (row["domain"], q.get("type"), qid) in pools else None)
            if cell not in pools or not eligible(state, q):
                continue
            key = f"test:{i}:{qid}"
            if key in REVIEWED_EXCLUSIONS:
                continue
            rank = hashlib.sha256(f"{SEED}:{key}".encode()).hexdigest()
            pools[cell].append((rank, i, qid, state, q))
    cases, labels = [], []
    for domain, kind, qkey, count in CELLS:
        pool = sorted(pools[(domain, kind, qkey)])
        if len(pool) < count:
            raise ValueError(f"insufficient candidates for {domain}/{kind}")
        selected = []
        counts = {}
        quotas = BALANCE.get((domain, kind))
        for item in pool:
            bucket = label_bucket(kind, item[4]["label"])
            if quotas is not None and counts.get(bucket, 0) >= quotas.get(bucket, 0):
                continue
            selected.append(item)
            counts[bucket] = counts.get(bucket, 0) + 1
            if len(selected) == count:
                break
        if len(selected) != count:
            raise ValueError(f"could not meet sample balance for {domain}/{kind}")
        for _, row_index, qid, state, q in selected:
            ident = f"test:{row_index}:{qid}"
            cases.append({"id": ident, "row_index": row_index, "domain": domain, "type": kind,
                          "question_key": qid, "state": state,
                          "question": {"type": kind, "instructions": q["instructions"],
                                       "criteria": q.get("criteria") if q.get("criteria") is not None else {}}})
            labels.append({"id": ident, "label": q["label"]})
    dataset = {"name": "avbiswas/bev-decision-150K", "revision": REVISION,
               "split": "test", "train_sha256": sha(train_path), "test_sha256": sha(test_path)}
    selection = {"seed": SEED, "cells": [{"domain": d, "type": k, "question_key": q, "n": n} for d, k, q, n in CELLS],
                 "reviewed_exclusions": REVIEWED_EXCLUSIONS,
                 "label_balance": {f"{d} / {k}": quota for (d, k), quota in BALANCE.items()},
                 "filters": "short state; no contact/URL/override pattern; no NFKC exact train-state match; valid typed question"}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "cases.json").write_text(json.dumps({"dataset": dataset, "selection": selection, "cases": cases}, indent=2, ensure_ascii=False) + "\n")
    (OUTPUT / "labels.json").write_text(json.dumps({"dataset_revision": REVISION, "labels": labels}, indent=2, ensure_ascii=False) + "\n")
    print(f"selected {len(cases)} questions")
    for case in cases:
        print(case["id"], case["domain"], case["type"], len(case["state"]))


if __name__ == "__main__":
    main()
