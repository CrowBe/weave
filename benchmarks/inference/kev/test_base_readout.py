"""Boundary tests for the untrained-base readout.

The conclusion this script supports is a negative one — that the corpus cannot
separate the trained checkpoint from the base — so the statistics carrying it
are load-bearing in a way the usual happy path is not. A wrong significance test
would turn "we cannot tell" into "they are the same". The tests below pin the
paired test against hand-computable values, the calibration estimator against
its degenerate cases, and the position-bias stratification against the case it
exists to catch.

Everything here is arithmetic and rendering. Nothing needs torch, the upstream
package or a live service, so this file runs under plain `python3`.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import base_readout  # noqa: E402


def record(case_id, predicted, label, confidence, presented, ordering_index=0):
    others = [c for c in presented if c != predicted]
    spread = (1.0 - confidence) / len(others) if others else 0.0
    probs = {c: (confidence if c == predicted else spread) for c in presented}
    return {"case_id": case_id, "ordering_index": ordering_index, "label": label,
            "presented": list(presented), "predicted": predicted,
            "confidence": confidence, "probabilities": probs, "markers_missing": 0}


class Mcnemar(unittest.TestCase):
    def test_no_disagreement_is_no_evidence(self):
        self.assertEqual(base_readout.mcnemar(0, 0), 1.0)

    def test_an_even_split_is_no_evidence(self):
        # 6 vs 5 is what the corpus actually produced against the best rendering.
        self.assertAlmostEqual(base_readout.mcnemar(6, 5), 1.0, places=6)

    def test_hand_computed_tails(self):
        # n=2, k=0: 2 * (1/4). n=5, k=0: 2 * (1/32).
        self.assertAlmostEqual(base_readout.mcnemar(2, 0), 0.5, places=6)
        self.assertAlmostEqual(base_readout.mcnemar(5, 0), 0.0625, places=6)
        # The two measured extremes, to three places.
        self.assertAlmostEqual(base_readout.mcnemar(8, 3), 0.227, places=3)
        self.assertAlmostEqual(base_readout.mcnemar(8, 4), 0.388, places=3)

    def test_it_is_symmetric(self):
        self.assertEqual(base_readout.mcnemar(8, 3), base_readout.mcnemar(3, 8))

    def test_a_lopsided_split_does_reach_significance(self):
        # The test is not incapable of rejecting; the corpus simply never made it.
        self.assertLess(base_readout.mcnemar(12, 1), 0.01)


class Discordance(unittest.TestCase):
    def test_only_disagreements_count(self):
        keys = [("a", 0), ("b", 0), ("c", 0)]
        left = {k: record(k[0], "x", "x", 0.9, ["x", "y"]) for k in keys}
        right = dict(left)
        right[("b", 0)] = record("b", "y", "x", 0.9, ["x", "y"])
        self.assertEqual(base_readout.discordant(left, right), (1, 0))

    def test_agreement_on_wrong_answers_is_not_discordant(self):
        keys = [("a", 0)]
        both = {k: record("a", "y", "x", 0.9, ["x", "y"]) for k in keys}
        self.assertEqual(base_readout.discordant(both, dict(both)), (0, 0))


class Calibration(unittest.TestCase):
    def test_certain_and_right_is_perfectly_calibrated(self):
        recs = [record(f"c{i}", "x", "x", 1.0, ["x", "y"]) for i in range(10)]
        self.assertAlmostEqual(base_readout.ece(recs), 0.0, places=6)

    def test_certain_and_wrong_is_maximally_miscalibrated(self):
        recs = [record(f"c{i}", "y", "x", 0.95, ["x", "y"]) for i in range(10)]
        self.assertAlmostEqual(base_readout.ece(recs), 0.95, places=6)

    def test_empty_reports_zero_rather_than_dividing_by_zero(self):
        self.assertEqual(base_readout.ece([]), 0.0)
        self.assertEqual(base_readout.brier([]), 0.0)
        self.assertEqual(base_readout.position_bias([]), 0.0)


class PositionBias(unittest.TestCase):
    def test_a_first_position_lock_is_caught(self):
        recs = [record("a", "x", "x", 0.9, ["x", "y"]),
                record("b", "p", "q", 0.9, ["p", "q"])]
        self.assertAlmostEqual(base_readout.position_bias(recs), 0.5, places=6)

    def test_a_state_reading_predictor_scores_zero(self):
        recs = [record("a", "x", "x", 0.9, ["x", "y"]),
                record("b", "q", "q", 0.9, ["p", "q"])]
        self.assertAlmostEqual(base_readout.position_bias(recs), 0.0, places=6)

    def test_stratification_catches_a_last_position_lock(self):
        # Unstratified, a last-position lock spreads across index 1 and index 3
        # when the corpus mixes widths, and hides. Within a stratum it is
        # concentrated again, which is what the lock actually is.
        recs = [record("a", "y", "x", 0.9, ["x", "y"]),
                record("b", "d", "a", 0.9, ["a", "b", "c", "d"])]
        self.assertGreater(base_readout.position_bias(recs), 0.9)


class Stability(unittest.TestCase):
    def test_a_case_asked_one_way_is_not_counted_as_stable(self):
        recs = [record("a", "x", "x", 0.9, ["x", "y"], 0),
                record("a", "x", "x", 0.9, ["x", "y"], 1)]
        self.assertEqual(base_readout.stability(recs), (0, 0))

    def test_a_case_that_holds_across_presentations_is_stable(self):
        recs = [record("a", "x", "x", 0.9, ["x", "y"], 0),
                record("a", "x", "x", 0.9, ["y", "x"], 1)]
        self.assertEqual(base_readout.stability(recs), (1, 1))

    def test_an_answer_that_follows_the_presentation_is_not(self):
        recs = [record("a", "x", "x", 0.9, ["x", "y"], 0),
                record("a", "y", "x", 0.9, ["y", "x"], 1)]
        self.assertEqual(base_readout.stability(recs), (0, 1))


class Readout(unittest.TestCase):
    def test_normalising_is_over_the_markers_alone(self):
        probs = base_readout.normalise([-1.0, -2.0, -30.0])
        self.assertAlmostEqual(sum(probs), 1.0, places=9)
        self.assertGreater(probs[0], probs[1])
        self.assertGreater(probs[1], probs[2])

    def test_normalising_is_shift_invariant(self):
        a = base_readout.normalise([-1.0, -2.0])
        b = base_readout.normalise([9.0, 8.0])
        for x, y in zip(a, b):
            self.assertAlmostEqual(x, y, places=9)


ITEM = {
    "case_id": "x", "ordering_index": 0, "label": "c_two",
    "presented": ["c_two", "c_one"],
    "state": {"goal": "G", "situation": "S", "facts": ["F1", "F2"],
              "eligible_candidates": [
                  {"candidate_id": "c_one", "operation": "op.one", "summary": "first"},
                  {"candidate_id": "c_two", "operation": "op.two", "summary": "second"}]},
}


class Rendering(unittest.TestCase):
    def test_options_follow_the_presented_order_not_the_corpus_order(self):
        prompt, markers = base_readout.render(ITEM, "letter_answer")
        self.assertEqual(markers, [" A", " B"])
        self.assertLess(prompt.index("op.two"), prompt.index("op.one"))

    def test_every_candidate_and_fact_reaches_the_prompt(self):
        prompt, _ = base_readout.render(ITEM, "letter_answer")
        for fragment in ("G", "S", "F1", "F2", "op.one", "op.two", "first", "second"):
            self.assertIn(fragment, prompt)

    def test_a_digit_marker_carries_no_leading_space(self):
        # Qwen3 tokenises " 1" as two tokens. If the space rode on the marker the
        # readout would score a bare space and every option would tie.
        prompt, markers = base_readout.render(ITEM, "digit_answer")
        self.assertEqual(markers, ["1", "2"])
        self.assertTrue(prompt.endswith("Answer: "))

    def test_a_letter_marker_carries_the_space_instead(self):
        prompt, markers = base_readout.render(ITEM, "letter_answer")
        self.assertTrue(all(m.startswith(" ") for m in markers))
        self.assertFalse(prompt.endswith(" "))

    def test_every_style_renders(self):
        for style in base_readout.STYLES:
            prompt, markers = base_readout.render(ITEM, style)
            self.assertEqual(len(markers), 2)
            self.assertTrue(prompt.endswith(base_readout.STYLES[style]["cue"]))


class MarkerGuard(unittest.TestCase):
    def test_a_multi_token_marker_is_refused(self):
        original = base_readout.post
        base_readout.post = lambda base, path, payload, timeout=600: {
            "tokens": [1, 2] if payload["content"] == " 1" else [7]}
        try:
            with self.assertRaises(RuntimeError) as caught:
                base_readout.marker_ids("http://stub", [" A", " 1"])
            self.assertIn("2 tokens", str(caught.exception))
        finally:
            base_readout.post = original

    def test_single_token_markers_are_accepted(self):
        original = base_readout.post
        base_readout.post = lambda base, path, payload, timeout=600: {"tokens": [42]}
        try:
            self.assertEqual(base_readout.marker_ids("http://stub", [" A"]), {" A": 42})
        finally:
            base_readout.post = original


if __name__ == "__main__":
    unittest.main()
