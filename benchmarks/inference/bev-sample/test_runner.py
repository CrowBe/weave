"""Safety and scoring checks for the BEV smoke-test boundary."""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE = Path(__file__).with_name("runner.py")
spec = importlib.util.spec_from_file_location("bev_sample_runner", MODULE)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerBoundaryTest(unittest.TestCase):
    def test_label_cannot_be_in_model_visible_case(self):
        with tempfile.TemporaryDirectory() as directory:
            case = {"id": "test:1:q", "row_index": 1, "domain": "test", "type": "noul",
                    "question_key": "q", "state": "A short test state",
                    "question": {"type": "noul", "instructions": "Is this true?", "criteria": {}}}
            cases = Path(directory) / "cases.json"
            labels = Path(directory) / "labels.json"
            cases.write_text(json.dumps({"dataset": {"revision": "rev"}, "selection": {}, "cases": [case]}))
            labels.write_text(json.dumps({"dataset_revision": "rev", "labels": [{"id": case["id"], "label": True}]}))
            runner.load_sample(cases, labels)
            case["question"]["label"] = True
            cases.write_text(json.dumps({"dataset": {"revision": "rev"}, "selection": {}, "cases": [case]}))
            with self.assertRaisesRegex(ValueError, "question"):
                runner.load_sample(cases, labels)

    def test_score_reports_expected_level_separately_from_mode(self):
        sys.path.insert(0, str(runner.KEV_SOURCE))
        case = {"type": "score", "question_key": "q",
                "question": {"type": "score", "instructions": "Rate", "criteria": ["low", "mid", "high"]}}
        result = runner.prediction_for(case, 1, {"probabilities": {"q": {"0": 0.40, "1": 0.25, "2": 0.35}},
                                                 "latency_ms": 1, "input_tokens": 10})
        self.assertEqual(result["predicted"], "0")
        self.assertFalse(result["correct"])
        self.assertEqual(result["rounded_level"], 1)
        self.assertTrue(result["rounded_correct"])


if __name__ == "__main__":
    unittest.main()
