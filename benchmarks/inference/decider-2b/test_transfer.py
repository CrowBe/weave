import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("transfer", Path(__file__).with_name("transfer.py"))
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


class ScoreAnswerTests(unittest.TestCase):
    def test_choice_keeps_option_key(self):
        result = transfer.score_answer(
            {"type": "choice"}, "b",
            {"choice": "b", "probabilities": {"a": 0.2, "b": 0.8}},
        )
        self.assertEqual(result, ("b", True, 0.8, None))

    def test_noul_uses_boolean_probability(self):
        self.assertEqual(transfer.score_answer({"type": "noul"}, False, {"noul": 0.2}),
                         (False, True, 0.8, None))

    def test_score_rounds_half_up_as_jev_transfer_does(self):
        answer = {"score": 2.5, "probabilities": {"3": 0.4}}
        self.assertEqual(transfer.score_answer({"type": "score"}, 3, answer),
                         (3, True, 0.4, 0.5))

    def test_report_names_derived_probability_and_preserves_provider_answer(self):
        answer = {"choice": "b", "probabilities": {"a": 0.2, "b": 0.8}, "confidence": 0.7}
        record = {"id": "case", "source": "fixture", "question": {"type": "choice"},
                  "label": "b", "jev_correct": True, "kev_correct": False}
        row = transfer.report_row(record, answer, 12)
        self.assertEqual(row["selected_probability"], 0.8)
        self.assertNotIn("confidence", row)
        self.assertEqual(row["answer"], answer)


if __name__ == "__main__":
    unittest.main()
