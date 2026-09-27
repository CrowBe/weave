import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("bev_tool", Path(__file__).with_name("bev_tool.py"))
bev_tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bev_tool)


class BevToolSplitTest(unittest.TestCase):
    def test_request_group_does_not_cross_splits(self):
        def row(request, label):
            import json
            return {"domain": "Tool and workflow decisions",
                    "state": json.dumps({"request": request, "available_tool": {"name": "lookup"}}),
                    "questions_json": json.dumps({"should_call_available_tool":
                        {"type": "noul", "label": label}})}

        train = [row(f"Please check item number {i} for me.", i % 2 == 0) for i in range(100)]
        train.append(row("Please check item number 0 for me.", False))
        test = [row("Please check item number 0 for me.", True),
                row("Please check item number 1 for me.", False)]
        splits = bev_tool.choose_cases(train, test)
        self.assertTrue(splits["train"])
        self.assertTrue(splits["validation"])
        self.assertEqual(len(splits["test"]), 2)
        groups = [{x["group"] for x in splits[s]} for s in ("train", "validation", "test")]
        self.assertFalse(groups[0] & groups[1])
        self.assertFalse(groups[0] & groups[2])
        self.assertFalse(groups[1] & groups[2])
        self.assertEqual(len(sum(splits.values(), [])), 100)

    def test_training_label_is_not_in_input(self):
        case = bev_tool.training_case({"text": "request and available tool", "label": "skip"})
        self.assertEqual(case["input"], "request and available tool")
        self.assertEqual(case["output"]["classifications"][0]["true_label"], ["skip"])

    def test_load_split_binds_index_digest_and_paired_label(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            data_path = output / "validation.jsonl"
            index_path = output / "validation-index.jsonl"
            case = bev_tool.training_case({"text": "request", "label": "use_tool"})
            data_path.write_text(json.dumps(case) + "\n")
            index_path.write_text(json.dumps({"id": "case", "group": "group", "label": "skip"}) + "\n")
            manifest = {"splits": {"validation": {
                "rows": 1, "sha256": hashlib.sha256(data_path.read_bytes()).hexdigest(),
                "index_sha256": hashlib.sha256(index_path.read_bytes()).hexdigest(),
            }}}
            (output / "manifest.json").write_text(json.dumps(manifest) + "\n")
            with mock.patch.object(bev_tool, "OUT", output):
                with self.assertRaisesRegex(ValueError, "label mismatch"):
                    bev_tool.load_split("validation")

    def test_load_split_rejects_changed_index(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            data_path = output / "validation.jsonl"
            index_path = output / "validation-index.jsonl"
            case = bev_tool.training_case({"text": "request", "label": "use_tool"})
            data_path.write_text(json.dumps(case) + "\n")
            index_path.write_text(json.dumps({"id": "case", "group": "group", "label": "use_tool"}) + "\n")
            manifest = {"splits": {"validation": {
                "rows": 1, "sha256": hashlib.sha256(data_path.read_bytes()).hexdigest(),
                "index_sha256": hashlib.sha256(index_path.read_bytes()).hexdigest(),
            }}}
            (output / "manifest.json").write_text(json.dumps(manifest) + "\n")
            index_path.write_text(json.dumps({"id": "other", "group": "group", "label": "use_tool"}) + "\n")
            with mock.patch.object(bev_tool, "OUT", output):
                with self.assertRaisesRegex(ValueError, "index changed"):
                    bev_tool.load_split("validation")

    def test_probe_row_names_provider_confidence_as_top_score(self):
        row = bev_tool.probe_row(
            {"id": "case", "group": "group", "label": "call"},
            {"label": "call", "confidence": 0.75}, 3.5)
        self.assertEqual(row["top_score"], 0.75)
        self.assertNotIn("confidence", row)

    def test_probe_row_rejects_malformed_model_output(self):
        meta = {"id": "case", "group": "group", "label": "call"}
        for result in (None, {}, {"label": "unexpected"}, {"label": "call", "confidence": float("nan")},
                       {"label": "call", "confidence": 1.1}):
            with self.subTest(result=result):
                with self.assertRaisesRegex(ValueError, "invalid tool-suitability"):
                    bev_tool.probe_row(meta, result, 3.5)


if __name__ == "__main__":
    unittest.main()
