"""Boundary tests for the Kev measurement harness.

The seam under test is the sample handed to upstream's scorer. Upstream owns
the metrics and validates the distributions it receives; what this harness
promises is that the record set it passes in is one the scorer can actually
score, and that the constant predictor is a fair red-first control rather than
a malformed one.

Tests that need the suite or the upstream package skip when those are absent,
so this file runs under plain `python3` as well as under the Kev venv.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bench  # noqa: E402
import wire_precision  # noqa: E402

KEV_HOME = Path(os.environ.get("WEAVE_KEV_HOME", Path.home() / ".local/share/weave/kev"))
SUITE = KEV_HOME / "src/evals/v4/decision-v4/development.jsonl"
HAS_KEV = importlib.util.find_spec("kev") is not None


def record(rid, *, source="s", variant="clean", group=None, parent=None,
           pair=None, sibling=None, questions=None):
    meta = {"id": rid, "source": source, "variant": variant,
            "group_id": group or rid}
    if parent:
        meta["parent_id"] = parent
    if pair:
        meta["pair_id"] = pair
        meta["sibling"] = sibling
    return {"state": "", "questions": questions or {
        "q": {"type": "noul", "instructions": "?", "label": True, "src": source}}, "_meta": meta}


class ComponentGrouping(unittest.TestCase):
    def test_variant_joins_its_clean_parent(self):
        records = [record("a"), record("a#p", variant="permuted", parent="a")]
        self.assertEqual(len(bench.components(records)), 1)

    def test_contrastive_pair_merges_two_parent_groups(self):
        # Each sibling is its own clean record, so without the pair edge these
        # would be two components and a sample could take only half the pair.
        records = [record("a", pair="p1", sibling="a"), record("b", pair="p1", sibling="b")]
        merged = bench.components(records)
        self.assertEqual(len(merged), 1)
        self.assertEqual(len(merged[0]), 2)

    def test_unrelated_records_stay_separate(self):
        self.assertEqual(len(bench.components([record("a"), record("b")])), 2)

    def test_grouping_is_independent_of_input_order(self):
        records = [record("a"), record("a#p", variant="permuted", parent="a"), record("b")]
        forward = [sorted(r["_meta"]["id"] for r in c) for c in bench.components(records)]
        backward = [sorted(r["_meta"]["id"] for r in c) for c in bench.components(records[::-1])]
        self.assertEqual(forward, backward)


class ClosureRefusal(unittest.TestCase):
    def test_orphan_variant_is_refused(self):
        with self.assertRaisesRegex(ValueError, "clean parent"):
            bench.assert_closed([record("a#p", variant="permuted", parent="a")])

    def test_half_a_contrastive_pair_is_refused(self):
        with self.assertRaisesRegex(ValueError, "incomplete contrastive"):
            bench.assert_closed([record("a", pair="p1", sibling="a")])

    def test_sample_without_clean_records_is_refused(self):
        with self.assertRaisesRegex(ValueError, "no clean records"):
            bench.assert_closed([record("a#n", variant="none_present", group="a", parent="a#n")])

    def test_closed_sample_is_accepted(self):
        bench.assert_closed([record("a"), record("a#p", variant="permuted", parent="a")])


@unittest.skipUnless(SUITE.exists(), "development split not downloaded")
class SubsampleOnRealSuite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records = [json.loads(line) for line in SUITE.read_text().splitlines()]

    def test_sample_is_closed(self):
        # The property that matters: upstream's report can be produced from it.
        bench.assert_closed(bench.subsample(self.records, 120, seed=0))

    def test_sample_is_deterministic_for_a_seed(self):
        first = [r["_meta"]["id"] for r in bench.subsample(self.records, 120, 0)]
        second = [r["_meta"]["id"] for r in bench.subsample(self.records, 120, 0)]
        self.assertEqual(first, second)

    def test_different_seeds_draw_different_samples(self):
        a = {r["_meta"]["id"] for r in bench.subsample(self.records, 120, 0)}
        b = {r["_meta"]["id"] for r in bench.subsample(self.records, 120, 1)}
        self.assertNotEqual(a, b)

    def test_every_source_is_represented(self):
        sample = bench.subsample(self.records, 120, 0)
        self.assertEqual({r["_meta"]["source"] for r in sample},
                         {r["_meta"]["source"] for r in self.records})

    def test_every_question_type_is_represented(self):
        sample = bench.subsample(self.records, 120, 0)
        types = {q["type"] for r in sample for q in r["questions"].values()}
        self.assertEqual(types, {"choice", "noul", "score"})

    def test_size_is_close_to_the_request(self):
        sample = bench.subsample(self.records, 120, 0)
        # Components are admitted whole, so exactness is not available; a
        # sample that silently returned 12 or 600 records would be.
        self.assertGreaterEqual(len(sample), 100)
        self.assertLessEqual(len(sample), 170)

    def test_requesting_everything_returns_the_split(self):
        self.assertEqual(len(bench.subsample(self.records, 10_000, 0)), len(self.records))


@unittest.skipUnless(HAS_KEV, "kev package not importable; run under the Kev venv")
class ConstantPredictorIsAFairControl(unittest.TestCase):
    """The stub must fail on accuracy, not by returning something unscorable.

    A stub rejected as malformed would demonstrate nothing about the corpus.
    """

    def records(self):
        return [
            record("c", questions={"q": {"type": "choice", "instructions": "?",
                                         "criteria": {"x": None, "y": None}, "label": "y", "src": "s"}}),
            record("n", questions={"q": {"type": "noul", "instructions": "?",
                                         "label": True, "src": "s"}}),
            record("s", questions={"q": {"type": "score", "instructions": "?",
                                         "criteria": ["lo", "mid", "hi"], "label": 2, "src": "s"}}),
        ]

    def test_output_passes_upstreams_own_validation(self):
        from kev.benchmark import prediction_rows

        for mode in ("first", "uniform"):
            predictor = bench.ConstantPredictor(mode)
            for rec in self.records():
                rows = prediction_rows(rec, predictor(rec))
                self.assertEqual(len(rows), 1)
                self.assertAlmostEqual(sum(rows[0]["p"]), 1.0, places=6)

    def test_keys_match_the_declared_options(self):
        predictor = bench.ConstantPredictor("uniform")
        for rec in self.records():
            from kev.benchmark import labels
            for qid, question in rec["questions"].items():
                self.assertEqual(set(predictor(rec)["probabilities"][qid]),
                                 set(labels(question)[0]))

    def test_it_does_not_read_the_state(self):
        predictor = bench.ConstantPredictor("first")
        rec = self.records()[0]
        baseline = predictor(rec)["probabilities"]
        rec["state"] = "a completely different situation"
        self.assertEqual(predictor(rec)["probabilities"], baseline)

    def test_unknown_mode_is_refused(self):
        with self.assertRaises(ValueError):
            bench.ConstantPredictor("clairvoyant")


class WirePrecisionReplay(unittest.TestCase):
    """Rounding must be modelled the way the server actually serves it."""

    def test_noul_keeps_its_complement_exact(self):
        # The server sends one rounded p(true); the client derives p(false),
        # so the pair always sums to one however coarse the rounding.
        row = {"type": "noul", "keys": ["false", "true"], "p": [0.1234, 0.8766]}
        wired = wire_precision.through_the_wire(row)
        self.assertEqual(sum(wired), 1.0)
        self.assertAlmostEqual(wired[1], 0.88)

    def test_choice_is_rounded_then_renormalised(self):
        # 0.614/0.323/0.063 round to 0.61/0.32/0.06, which sums to 0.99, so
        # the client's renormalisation is observable rather than a no-op.
        row = {"type": "choice", "keys": ["a", "b", "c"], "p": [0.614, 0.323, 0.063]}
        wired = wire_precision.through_the_wire(row)
        self.assertAlmostEqual(sum(wired), 1.0, places=9)
        self.assertAlmostEqual(wired[0], 0.61 / 0.99, places=9)

    def test_small_options_survive_rounding(self):
        row = {"type": "choice", "keys": ["a", "b"], "p": [0.5, 0.5]}
        self.assertEqual(wire_precision.through_the_wire(row), [0.5, 0.5])

    def test_a_wide_distribution_can_collapse_entirely(self):
        # 300 near-uniform options all round to 0.00. This is the failure the
        # replay exists to quantify, so it must not raise or divide by zero.
        row = {"type": "choice", "keys": [str(i) for i in range(300)],
               "p": [1 / 300] * 300}
        wired = wire_precision.through_the_wire(row)
        self.assertAlmostEqual(sum(wired), 1.0, places=9)

    def test_mass_below_the_floor_is_discarded_not_kept(self):
        # An option at 0.004 is served as 0.00 and vanishes; the surviving
        # options absorb its mass. Asserting this keeps the replay honest
        # about being lossy rather than merely imprecise.
        row = {"type": "choice", "keys": ["a", "b"], "p": [0.996, 0.004]}
        self.assertEqual(wire_precision.through_the_wire(row), [1.0, 0.0])


if __name__ == "__main__":
    unittest.main()
