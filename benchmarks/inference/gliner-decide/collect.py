"""Validate authored seeds and materialize isolated GLiNER training/eval JSONL.

These are synthetic training seeds. They do not create a capability, change a
route, or turn any model output into authority. Group and split metadata remain
outside the library's training rows so the provenance is easy to audit.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import string


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCES = (HERE / "collection-match.json", HERE / "collection-evaluate.json")
SPLITS = ("train", "validation", "test")
ARMS = ("base", "relevant", "irrelevant")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def expand(path):
    source = json.loads(Path(path).read_text())
    if source.get("version") != "weave.training-seed.v1":
        raise ValueError(f"unexpected version: {path}")
    site = source["site"]
    if site not in ("capability.match", "result.evaluate") or source.get("kind") != "choice":
        raise ValueError(f"unsupported site or kind: {path}")
    labels = source["labels"]
    if not labels or any(not key or not description for key, description in labels.items()):
        raise ValueError(f"missing label descriptions: {path}")
    for name in source["source_contracts"]:
        if not (ROOT / name).is_file():
            raise ValueError(f"missing provenance source {name}")
    if not source.get("prompt", "").strip():
        raise ValueError(f"missing prompt: {path}")
    groups = source["groups"]
    seen_groups = set()
    rows = []
    for group in groups:
        group_id = group["id"]
        if group_id in seen_groups:
            raise ValueError(f"duplicate group {group_id}")
        seen_groups.add(group_id)
        if group["split"] not in SPLITS:
            raise ValueError(f"invalid split in {group_id}")
        if len(group["variants"]) != 2:
            raise ValueError(f"expected two surface variants in {group_id}")
        if len(group["arms"]) != 3 or {arm["arm"] for arm in group["arms"]} != set(ARMS):
            raise ValueError(f"incomplete contrast group {group_id}")
        arms = {arm["arm"]: arm for arm in group["arms"]}
        if arms["base"]["label"] != arms["irrelevant"]["label"]:
            raise ValueError(f"irrelevant arm changed label in {group_id}")
        if arms["base"]["label"] == arms["relevant"]["label"]:
            raise ValueError(f"relevant arm did not change label in {group_id}")
        if any(arm["label"] not in labels for arm in group["arms"]):
            raise ValueError(f"unknown label in {group_id}")
        if not group.get("family", "").strip():
            raise ValueError(f"missing semantic family in {group_id}")
        for variant_index, variables in enumerate(group["variants"]):
            if set(variables) != {"a", "b"} or variables["a"] == variables["b"]:
                raise ValueError(f"bad surface variables in {group_id}")
            texts = []
            for arm in group["arms"]:
                fields = {field for _, field, _, _ in string.Formatter().parse(arm["text"]) if field}
                if not fields <= set(variables):
                    raise ValueError(f"unknown placeholder in {group_id}")
                rendered = arm["text"].format_map(variables).strip()
                if not rendered:
                    raise ValueError(f"blank input in {group_id}")
                texts.append(rendered)
                rows.append({
                    "id": f"{group_id}.v{variant_index}.{arm['arm']}",
                    "site": site, "kind": "choice", "split": group["split"],
                    "group": group_id, "family": group["family"],
                    "variant": variant_index, "arm": arm["arm"], "text": rendered,
                    "semantic_label": arm["label"],
                    "labels": labels, "prompt": source["prompt"],
                })
            if len(set(texts)) != 3:
                raise ValueError(f"contrast arms have duplicate text in {group_id}.v{variant_index}")
    by_split = Counter(row["split"] for row in rows)
    if any(by_split[split] == 0 for split in SPLITS):
        raise ValueError(f"missing split in {site}")
    if len({row["text"] for row in rows}) != len(rows):
        raise ValueError(f"duplicate rendered input in {site}")
    return rows


def wire_case(row):
    """Opaque option IDs vary by group; descriptions carry the semantics."""
    names = list(row["labels"])
    if row["site"] == "capability.match":
        operations = [name for name in names if name != "none"]
        offset = int(hashlib.sha256(row["group"].encode()).hexdigest()[:8], 16) % len(operations)
        operations = operations[offset:] + operations[:offset]
        ids = {name: f"c{i}" for i, name in enumerate(operations)}
        ids["none"] = "none"
        if row["variant"] == 1:
            ordered = list(reversed(operations)) + ["none"]
        else:
            ordered = operations + ["none"]
        descriptions = {ids[name]: row["labels"][name] for name in ordered}
        label = ids[row["semantic_label"]]
    else:
        ordered = names if row["variant"] == 0 else list(reversed(names))
        descriptions = {name: row["labels"][name] for name in ordered}
        label = row["semantic_label"]
    task = "match" if row["site"] == "capability.match" else "result"
    training = {
        "input": row["text"],
        "output": {"classifications": [{
            "task": task, "labels": list(descriptions), "true_label": [label],
            "label_descriptions": descriptions, "prompt": row["prompt"],
        }]},
    }
    index = {key: row[key] for key in ("id", "site", "split", "group", "family", "variant", "arm", "semantic_label")}
    index["wire_label"] = label
    return training, index


def load_split(directory, split):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    data_path = directory / f"{split}.jsonl"
    index_path = directory / f"{split}-index.jsonl"
    if digest(data_path) != manifest["output_sha256"][split]:
        raise ValueError(f"{split} data digest differs from manifest")
    if digest(index_path) != manifest["index_sha256"][split]:
        raise ValueError(f"{split} index digest differs from manifest")
    data = [json.loads(line) for line in data_path.read_text().splitlines()]
    index = [json.loads(line) for line in index_path.read_text().splitlines()]
    if len(data) != len(index) or len(data) != manifest["examples"][split]:
        raise ValueError(f"{split} index does not align")
    for case, meta in zip(data, index):
        true_label = case["output"]["classifications"][0]["true_label"]
        if true_label != [meta["wire_label"]]:
            raise ValueError(f"{split} label differs for {meta['id']}")
    return data, index, manifest


def build(output_dir):
    all_rows = [expand(path) for path in SOURCES]
    source_digests = {path.name: digest(path) for path in SOURCES}
    manifests = {}
    for rows, source_path in zip(all_rows, SOURCES):
        site = rows[0]["site"]
        directory = Path(output_dir) / site
        directory.mkdir(parents=True, exist_ok=True)
        counts = Counter()
        groups = defaultdict(set)
        for split in SPLITS:
            selected = [row for row in rows if row["split"] == split]
            train_path = directory / f"{split}.jsonl"
            index_path = directory / f"{split}-index.jsonl"
            with train_path.open("w") as train_file, index_path.open("w") as index_file:
                for row in selected:
                    training, index = wire_case(row)
                    train_file.write(json.dumps(training, ensure_ascii=False) + "\n")
                    index_file.write(json.dumps(index, ensure_ascii=False) + "\n")
                    counts[split] += 1
                    groups[split].add(row["group"])
        manifest = {
            "version": "weave.training-seed.v1", "site": site, "kind": "choice",
            "status": "synthetic seed, not promotion evidence",
            "source_sha256": source_digests[source_path.name],
            "examples": dict(counts),
            "groups": {split: sorted(groups[split]) for split in SPLITS},
            "group_counts": {split: len(groups[split]) for split in SPLITS},
            "output_sha256": {split: digest(directory / f"{split}.jsonl") for split in SPLITS},
            "index_sha256": {split: digest(directory / f"{split}-index.jsonl") for split in SPLITS},
        }
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        manifests[site] = manifest
    return manifests


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT / ".local/gliner-decide/collected")
    args = parser.parse_args()
    print(json.dumps(build(args.output_dir), indent=2))


if __name__ == "__main__":
    main()
