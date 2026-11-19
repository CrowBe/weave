import unittest

from assess import assess


class EntailmentContract(unittest.TestCase):
    def test_preserves_neutral_and_scores_by_label(self):
        scores = {"neutral": 0.8, "contradiction": 0.15, "entailment": 0.05}
        result = assess("Alice may publish.", "Alice will publish.", lambda p, h: scores)
        self.assertEqual(result, {"label": "neutral", "scores": scores})

    def test_tie_does_not_choose_an_arbitrary_label(self):
        scores = {"neutral": 0.5, "contradiction": 0.0, "entailment": 0.5}
        self.assertEqual(assess("p", "h", lambda p, h: scores)["label"], "undetermined")

    def test_rejects_empty_input_before_inference(self):
        def unexpected(p, h):
            self.fail("invalid input reached inference")
        for p, h in [("", "h"), ("p", " ")]:
            with self.assertRaises(ValueError):
                assess(p, h, unexpected)

    def test_rejects_malformed_model_results(self):
        for scores in [
            {"entailment": 1.0},
            {"neutral": float("nan"), "contradiction": 0.0, "entailment": 1.0},
            {"neutral": -0.1, "contradiction": 0.1, "entailment": 1.0},
            {"neutral": 0.1, "contradiction": 0.1, "entailment": 0.1},
        ]:
            with self.subTest(scores=scores), self.assertRaises(ValueError):
                assess("p", "h", lambda p, h: scores)

    def test_inference_failure_is_not_a_judgment(self):
        def unavailable(p, h):
            raise RuntimeError("model unavailable")
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            assess("p", "h", unavailable)


if __name__ == "__main__":
    unittest.main()
