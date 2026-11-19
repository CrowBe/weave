import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("transfer", Path(__file__).with_name("transfer.py"))
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


class ScoreAnswerTests(unittest.TestCase):
    def test_choice_uses_returned_option_and_its_probability(self):
        self.assertEqual(transfer.score_answer(
            {"type": "choice", "criteria": {"a": "A", "b": "B"}}, "b",
            {"choice": "b", "probabilities": {"a": 0.2, "b": 0.8}},
        ), ("b", True, 0.8, None))

    def test_noul_uses_half_threshold_and_probability_of_prediction(self):
        self.assertEqual(transfer.score_answer({"type": "noul"}, False, {"noul": 0.2}),
                         (False, True, 0.8, None))
        self.assertEqual(transfer.score_answer({"type": "noul"}, True, {"noul": 0.5}),
                         (True, True, 0.5, None))

    def test_score_rounds_half_up_and_records_error(self):
        answer = {"score": 2.5, "probabilities": {"3": 0.4}}
        self.assertEqual(transfer.score_answer({"type": "score", "criteria": ["0", "1", "2", "3"]}, 3, answer),
                         (3, True, 0.4, 0.5))

    def test_invalid_external_values_fail_closed(self):
        choice = {"type": "choice", "criteria": {"a": "A", "b": "B"}}
        with self.assertRaisesRegex(ValueError, "invalid choice"):
            transfer.score_answer(choice, "a", {"choice": "unexpected"})
        with self.assertRaisesRegex(ValueError, "invalid probability"):
            transfer.score_answer(choice, "a", {"choice": "a", "probabilities": {"a": float("nan")}})
        for value in (-0.1, 1.1, float("nan"), float("inf"), True):
            with self.subTest(kind="noul", value=value):
                with self.assertRaisesRegex(ValueError, "invalid NOUL probability"):
                    transfer.score_answer({"type": "noul"}, False, {"noul": value})
        score = {"type": "score", "criteria": ["0", "1", "2", "3"]}
        for value in (-0.1, 3.1, float("nan"), float("inf"), True):
            with self.subTest(kind="score", value=value):
                with self.assertRaisesRegex(ValueError, "invalid score"):
                    transfer.score_answer(score, 0, {"score": value})

    def test_unknown_type_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "unknown question type"):
            transfer.score_answer({"type": "other"}, 1, {})

    def test_label_is_excluded_from_native_question(self):
        record = {"question": {"type": "choice", "instructions": "Pick", "criteria": {"a": "A", "b": "B"},
                               "label": "b"}, "label": "b"}
        request_question = transfer.model_question(record)
        self.assertEqual(request_question, {"type": "choice", "instructions": "Pick", "criteria": {"a": "A", "b": "B"}})
        self.assertNotIn("label", request_question)

    def test_report_names_derived_probability_and_preserves_provider_answer(self):
        answer = {"choice": "b", "probabilities": {"a": 0.2, "b": 0.8}, "confidence": 0.7}
        record = {"id": "case", "source": "fixture",
                  "question": {"type": "choice", "criteria": {"a": "A", "b": "B"}},
                  "label": "b", "jev_correct": True, "kev_correct": False}
        row = transfer.report_row(record, answer, 12)
        self.assertEqual(row["selected_probability"], 0.8)
        self.assertNotIn("confidence", row)
        self.assertEqual(row["answer"], answer)


if __name__ == "__main__":
    unittest.main()
