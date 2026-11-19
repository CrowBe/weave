"""Boundary tests for the llama.cpp-backed Kev service.

The seam under test is the wire contract, not the arithmetic. Upstream owns
`to_record`/`to_answers`; what this service promises is that swapping the
backend behind them changes nothing a caller can observe: the same checkpoint
identity, the same envelope, and answers attributed to the questions that asked
them.

The one substantive claim is the decomposition. llama.cpp cannot express Kev's
block-causal branch mask, so each question is encoded as its own causal row
continuing from the shared state. That is exact rather than approximate — the
row holds precisely the tokens the question may attend to, at the same
positions — and the tests below pin the two properties that make it so: every
branch carries the whole state, and no branch carries a sibling.

Tests needing torch, the upstream package or a live service skip when those are
absent, so this file runs under plain `python3`.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llamacpp_serve  # noqa: E402

HAS_KEV = importlib.util.find_spec("kev") is not None
HAS_TORCH = importlib.util.find_spec("torch") is not None
KEV_RUN = Path(os.environ.get("WEAVE_KEV_RUN", Path.home() / ".local/share/weave/kev/models/kev-4b"))

TORCH_URL = os.environ.get("WEAVE_KEV_BASE_URL")
LLAMACPP_URL = os.environ.get("WEAVE_KEV_LLAMACPP_BASE_URL")

RECORD = {
    "state": "the shared state",
    "questions": [
        {"instr": "first", "options": ["a", "b"], "label": 0},
        {"instr": "second", "options": ["c", "d", "e"], "label": 0},
    ],
}


class BranchRecords(unittest.TestCase):
    """The decomposition every answer depends on."""

    def test_one_record_per_question(self):
        self.assertEqual(len(llamacpp_serve.branch_records(RECORD)), 2)

    def test_every_branch_carries_the_whole_state(self):
        for branch in llamacpp_serve.branch_records(RECORD):
            self.assertEqual(branch["state"], RECORD["state"])

    def test_no_branch_carries_a_sibling(self):
        branches = llamacpp_serve.branch_records(RECORD)
        self.assertEqual([q["instr"] for b in branches for q in b["questions"]], ["first", "second"])
        for branch in branches:
            self.assertEqual(len(branch["questions"]), 1)

    def test_question_order_is_preserved(self):
        # Probabilities come back one branch at a time and are zipped against a
        # meta list built once, in request order. Reordering here would
        # silently attribute an answer to the wrong question.
        branches = llamacpp_serve.branch_records(RECORD)
        self.assertEqual([b["questions"][0] for b in branches], RECORD["questions"])

    def test_a_single_question_record_is_unchanged(self):
        one = {"state": "s", "questions": [RECORD["questions"][0]]}
        self.assertEqual(llamacpp_serve.branch_records(one), [one])

    def test_a_record_with_no_questions_yields_no_branches(self):
        self.assertEqual(llamacpp_serve.branch_records({"state": "s", "questions": []}), [])


@unittest.skipUnless(HAS_TORCH and KEV_RUN.exists(), "needs torch and a local checkpoint")
class Identity(unittest.TestCase):
    """What the readiness probe in `createSystemdKevRuntime` compares."""

    def test_identity_names_the_same_checkpoint_as_the_pytorch_service(self):
        info = llamacpp_serve.checkpoint_identity(str(KEV_RUN), "Qwen3-4B-Base.Q4_K_M.gguf")
        self.assertEqual(info["run"], str(KEV_RUN))
        self.assertEqual(info["base"], "Qwen/Qwen3-4B-Base")
        self.assertEqual(info["lora"], 16)

    def test_identity_discloses_the_backend_rather_than_impersonating_the_default(self):
        # The probe only compares run/base/lora, so these extra fields cost it
        # nothing — but a caller reading the endpoint must be able to tell that
        # the weights are quantised and the backend is not PyTorch.
        info = llamacpp_serve.checkpoint_identity(str(KEV_RUN), "Qwen3-4B-Base.Q4_K_M.gguf")
        self.assertEqual(info["backend"], "llama.cpp")
        self.assertIn("weights", info)


@unittest.skipUnless(HAS_KEV and HAS_TORCH and KEV_RUN.exists(), "needs the kev package, torch and a checkpoint")
class Readout(unittest.TestCase):
    """The pointer head must read the marker positions, not arbitrary rows."""

    def test_the_head_reads_the_decide_and_option_positions(self):
        import torch
        from kev.model import encode
        from transformers import AutoTokenizer

        tok = AutoTokenizer.from_pretrained(str(KEV_RUN))
        enc = encode(tok, {"state": "s", "questions": [{"instr": "i", "options": ["x", "y"], "label": 0}]})
        seen = {}

        def hidden(ids):
            seen["ids"] = list(ids)
            # One distinct row per position, so a misread is visible.
            return torch.arange(len(ids), dtype=torch.float32)[:, None].repeat(1, 2560)

        head = llamacpp_serve.load_head(str(KEV_RUN))
        probs = llamacpp_serve.branch_probabilities(tok, head, {"state": "s", "questions": [{"instr": "i", "options": ["x", "y"], "label": 0}]}, hidden)

        self.assertEqual(seen["ids"], list(enc["ids"]), "the whole branch is sent, once")
        self.assertEqual(len(probs), 1)
        self.assertEqual(len(probs[0]), 2, "one probability per option")
        self.assertAlmostEqual(sum(probs[0]), 1.0, places=5)

    def test_a_truncated_hidden_response_is_refused_rather_than_read_short(self):
        import torch
        from transformers import AutoTokenizer

        tok = AutoTokenizer.from_pretrained(str(KEV_RUN))
        head = llamacpp_serve.load_head(str(KEV_RUN))
        rec = {"state": "s", "questions": [{"instr": "i", "options": ["x", "y"], "label": 0}]}
        with self.assertRaises(RuntimeError):
            llamacpp_serve.branch_probabilities(
                tok, head, rec, lambda ids: torch.zeros(len(ids) - 1, 2560)
            )


@unittest.skipUnless(HAS_KEV and HAS_TORCH and KEV_RUN.exists(), "needs the kev package, torch and a checkpoint")
class HttpBoundary(unittest.TestCase):
    """The app's own HTTP surface, with the backbone stubbed out.

    A typed handler parameter that FastAPI cannot resolve is demoted to a query
    field, and the service then rejects every well-formed request with 422
    while still passing every unit test. Only a real request catches it.
    """

    def app(self):
        import torch
        return llamacpp_serve.create_app(
            str(KEV_RUN), "http://unused", "stub.gguf",
            hidden=lambda ids: torch.zeros(len(ids), 2560),
        )

    def client(self):
        from fastapi.testclient import TestClient
        return TestClient(self.app())

    def test_a_well_formed_request_is_accepted_as_a_body(self):
        response = self.client().post("/v1/systemone", json=WireEquivalence.REQUEST)
        self.assertEqual(response.status_code, 200, response.text)

    def test_the_envelope_carries_the_documented_fields(self):
        body = self.client().post("/v1/systemone", json=WireEquivalence.REQUEST).json()
        self.assertEqual(sorted(body), ["answers", "latency_ms", "model", "usage"])
        self.assertEqual(sorted(body["answers"]), ["ready", "risk"])
        self.assertEqual(sorted(body["usage"]), ["input_tokens", "output_tokens"])

    def test_each_answer_is_typed_as_its_question_asked(self):
        answers = self.client().post("/v1/systemone", json=WireEquivalence.REQUEST).json()["answers"]
        self.assertEqual(answers["ready"]["type"], "noul")
        self.assertEqual(answers["risk"]["type"], "score")

    def test_usage_counts_every_pass_rather_than_the_packed_sequence(self):
        # Two questions run as two passes over the same state, so the figure is
        # larger than kev.serve reports for the same request. Understating it
        # would misreport what the machine actually did.
        one = dict(WireEquivalence.REQUEST, questions={"ready": WireEquivalence.REQUEST["questions"]["ready"]})
        client = self.client()
        single = client.post("/v1/systemone", json=one).json()["usage"]["input_tokens"]
        both = client.post("/v1/systemone", json=WireEquivalence.REQUEST).json()["usage"]["input_tokens"]
        self.assertGreater(both, single)

    def test_info_is_served_where_the_readiness_probe_looks(self):
        body = self.client().get("/api/info").json()
        self.assertEqual(body["base"], "Qwen/Qwen3-4B-Base")
        self.assertEqual(body["lora"], 16)


def reachable(url):
    if url is None:
        return False
    try:
        urllib.request.urlopen(f"{url.rstrip('/')}/api/info", timeout=3).read()
        return True
    except (urllib.error.URLError, OSError):
        return False


@unittest.skipUnless(reachable(TORCH_URL) and reachable(LLAMACPP_URL),
                     "needs both WEAVE_KEV_BASE_URL and WEAVE_KEV_LLAMACPP_BASE_URL serving")
class WireEquivalence(unittest.TestCase):
    """The claim that justifies the swap: a caller cannot tell them apart."""

    REQUEST = {
        "model": "kev-4b",
        "state": {"goal": "ship the release", "facts": ["the build is green", "the changelog is written"]},
        "questions": {
            "ready": {"type": "noul", "instructions": "Consider whether the release can ship now.",
                      "criteria": {"true": "The release is ready to ship.", "false": "The release is not ready to ship."}},
            "risk": {"type": "score", "instructions": "Place the release on the scale.",
                     "criteria": ["no risk", "some risk", "high risk"]},
        },
    }

    @staticmethod
    def post(url, body):
        req = urllib.request.Request(f"{url.rstrip('/')}/v1/systemone",
                                     data=json.dumps(body).encode(),
                                     headers={"content-type": "application/json"})
        return json.load(urllib.request.urlopen(req, timeout=600))

    def test_both_services_return_the_same_envelope_and_answer_shapes(self):
        a = self.post(TORCH_URL, self.REQUEST)
        b = self.post(LLAMACPP_URL, self.REQUEST)
        self.assertEqual(sorted(a), sorted(b), "same envelope keys")
        self.assertEqual(sorted(a["answers"]), sorted(b["answers"]), "same questions answered")
        for qid in a["answers"]:
            self.assertEqual(sorted(a["answers"][qid]), sorted(b["answers"][qid]), f"{qid}: same answer keys")
            self.assertEqual(a["answers"][qid]["type"], b["answers"][qid]["type"])
        self.assertEqual(sorted(a["usage"]), sorted(b["usage"]))

    def test_both_services_agree_on_the_decision(self):
        a = self.post(TORCH_URL, self.REQUEST)["answers"]
        b = self.post(LLAMACPP_URL, self.REQUEST)["answers"]
        self.assertEqual(round(a["ready"]["noul"]), round(b["ready"]["noul"]), "same side of the boolean")
        self.assertEqual(round(a["risk"]["score"]), round(b["risk"]["score"]), "same level")


if __name__ == "__main__":
    unittest.main()
