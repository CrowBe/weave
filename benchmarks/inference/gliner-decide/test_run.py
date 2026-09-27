import unittest

from run import classify_input, summarize
from capability_match import load_cases, schema_for, summarize as summarize_match


class MappingTests(unittest.TestCase):
    def test_choice_uses_descriptions_and_preserves_option_keys(self):
        record = {
            "state": {"goal": "recover a file"},
            "questions": {"q": {"type": "choice", "instructions": "Which action?",
                                "criteria": {"a": "Read backup", "b": None}, "label": "a"}},
        }
        text, schema, _ = classify_input(record)
        self.assertIn("goal: recover a file", text)
        self.assertEqual(schema["answer"]["labels"], {"a": "Read backup", "b": "b"})
        self.assertEqual(schema["answer"]["prompt"], "Which action?")

    def test_boolean_uses_the_question_and_both_described_arms(self):
        record = {
            "state": "The file was deleted.",
            "questions": {"q": {"type": "noul", "instructions": "Was it deleted?",
                                "criteria": {"true": "Deleted", "false": "Still present"},
                                "label": True}},
        }
        _, schema, _ = classify_input(record)
        self.assertEqual(schema["answer"], {
            "labels": {"yes": "Deleted", "no": "Still present"},
            "prompt": "Was it deleted?",
        })

    def test_score_levels_are_classes_with_descriptions(self):
        record = {
            "state": "One day late",
            "questions": {"q": {"type": "score", "instructions": "How late?",
                                "criteria": ["On time", "Late"], "label": 1}},
        }
        _, schema, _ = classify_input(record)
        self.assertEqual(schema["answer"]["labels"], {"0": "On time", "1": "Late"})

    def test_majority_floor_is_per_source(self):
        rows = [
            {"source": "a", "label": "x", "correct": True, "latency_ms": 1},
            {"source": "a", "label": "x", "correct": False, "latency_ms": 2},
            {"source": "b", "label": "y", "correct": True, "latency_ms": 3},
        ]
        self.assertEqual(summarize(rows)["majority_floor"], 1.0)


class CapabilityMatchTests(unittest.TestCase):
    def test_grouped_splits_and_contrasts(self):
        rows = load_cases()
        self.assertEqual(len(rows), 36)
        self.assertEqual({r["split"] for r in rows}, {"development", "test"})
        families = {split: {r["catalogue"] for r in rows if r["split"] == split}
                    for split in ("development", "test")}
        self.assertFalse(families["development"] & families["test"])
        self.assertEqual(len({r["group"] for r in rows}), 12)
        self.assertEqual(sum(r["label"] == "none" for r in rows), 6)

    def test_reordering_changes_presentation_only(self):
        row = load_cases()[0]
        normal = schema_for(row)["match"]
        reversed_ = schema_for(row, reverse=True)["match"]
        self.assertEqual(normal["prompt"], reversed_["prompt"])
        self.assertEqual(normal["labels"], reversed_["labels"])
        self.assertEqual(list(normal["labels"]), list(reversed(reversed_["labels"])))

    def test_contrast_metrics_distinguish_flip_from_hold(self):
        cases = load_cases()[:3]
        predictions = [
            {"group": r["group"], "catalogue": r["catalogue"], "arm": r["arm"],
             "label": r["label"], "predicted": r["label"], "correct": True,
             "option_count": 4, "latency_ms": 1}
            for r in cases
        ]
        result = summarize_match(predictions)
        self.assertEqual(result["relevant_flip"], 1)
        self.assertEqual(result["irrelevant_hold"], 1)
        self.assertEqual(result["uniform_floor"], 0.25)
        self.assertEqual(result["false_match"], 0)
        self.assertEqual(result["false_no_match"], 0)

    def test_false_match_is_separate_from_other_errors(self):
        cases = load_cases()[3:6]  # the publish-or-sign group contains no_match
        predictions = [
            {"group": r["group"], "catalogue": r["catalogue"], "arm": r["arm"],
             "label": r["label"], "predicted": "c1", "correct": r["label"] == "c1",
             "option_count": 4, "latency_ms": 1}
            for r in cases
        ]
        result = summarize_match(predictions)
        self.assertEqual(result["no_match_cases"], 1)
        self.assertEqual(result["false_match"], 1)
        self.assertEqual(result["false_no_match"], 0)


if __name__ == "__main__":
    unittest.main()
