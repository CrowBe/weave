"""Check the seed's boundaries and training export, not model quality."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("collect", HERE / "collect.py")
collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collect)


class CollectionTest(unittest.TestCase):
    def test_group_splits_and_contrasts(self):
        for source in collect.SOURCES:
            rows = collect.expand(source)
            groups = {}
            for row in rows:
                groups.setdefault(row["group"], []).append(row)
            self.assertGreaterEqual(len(groups), 16)
            for group_rows in groups.values():
                self.assertEqual(len(group_rows), 6)
                self.assertEqual(len({r["split"] for r in group_rows}), 1)
                for variant in (0, 1):
                    arms = {r["arm"]: r for r in group_rows if r["variant"] == variant}
                    self.assertEqual(arms["base"]["semantic_label"], arms["irrelevant"]["semantic_label"])
                    self.assertNotEqual(arms["base"]["semantic_label"], arms["relevant"]["semantic_label"])
            for split in collect.SPLITS:
                labels = {r["semantic_label"] for r in rows if r["split"] == split}
                if source.name == "collection-evaluate.json":
                    self.assertEqual(labels, {"met", "partial", "unmet", "unknown"})
                else:
                    self.assertIn("none", labels)

    def test_no_exact_reuse_of_prior_match_probe(self):
        prior = json.loads((HERE / "capability-match-cases.json").read_text())
        old = {arm["desired"] for group in prior["groups"] for arm in group["arms"]}
        new = {row["text"] for row in collect.expand(HERE / "collection-match.json")}
        self.assertFalse(old & new)

    def test_export_is_loadable_and_preserves_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifests = collect.build(temporary)
            self.assertEqual(set(manifests), {"capability.match", "result.evaluate"})
            for site, manifest in manifests.items():
                self.assertEqual(manifest["examples"]["train"], 60)
                self.assertEqual(manifest["group_counts"]["train"], 10)
                for split in collect.SPLITS:
                    directory = Path(temporary) / site
                    training = [json.loads(line) for line in (directory / f"{split}.jsonl").read_text().splitlines()]
                    index = [json.loads(line) for line in (directory / f"{split}-index.jsonl").read_text().splitlines()]
                    self.assertEqual(len(training), len(index))
                    self.assertEqual(len(training), manifest["examples"][split])
                    self.assertEqual(collect.digest(directory / f"{split}.jsonl"), manifest["output_sha256"][split])
                    for item, meta in zip(training, index):
                        classification = item["output"]["classifications"][0]
                        self.assertEqual(classification["true_label"], [meta["wire_label"]])
                        self.assertIn(meta["wire_label"], classification["labels"])
                        self.assertEqual(set(classification["labels"]), set(classification["label_descriptions"]))
                        self.assertEqual(meta["split"], split)
                    self.assertEqual(len({m["group"] for m in index}), manifest["group_counts"][split])

    def test_match_options_are_opaque_and_order_varies(self):
        rows = collect.expand(HERE / "collection-match.json")
        base = {r["variant"]: collect.wire_case(r)[0] for r in rows
                if r["group"] == "match.inspect-versus-assemble" and r["arm"] == "base"}
        first = base[0]["output"]["classifications"][0]
        second = base[1]["output"]["classifications"][0]
        self.assertEqual(set(first["labels"]), {"c0", "c1", "c2", "c3", "c4", "none"})
        self.assertNotEqual(first["labels"], second["labels"])
        self.assertEqual(first["true_label"], second["true_label"])


if __name__ == "__main__":
    unittest.main()
