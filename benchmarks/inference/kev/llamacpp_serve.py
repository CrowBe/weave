"""Kev's System One contract, served from a llama.cpp backbone.

Same checkpoint, same wire contract, different arithmetic. `kev.serve` runs the
backbone in PyTorch at fp32; this runs it quantised under llama.cpp, where the
weights can be offloaded to a GPU. On the Metabox Edge that is 2.5 s per
judgment-site request against 11.5 s, with the same answers — measured over 56
records, 47/56 correct either way, four disagreements splitting two each way.

**Only the backbone moves.** `to_record`, `to_answers` and the pointer head are
upstream's, unchanged, so answer shaping cannot drift between the two services.
What is replaced is the single step in between: hidden states for a token
sequence.

**Why each question runs as its own pass.** Kev packs a state and N questions
into one sequence and isolates them with a block-causal mask. llama.cpp exposes
no such mask, so each question is instead encoded as its own causal row
continuing from the shared state. This is an identity, not an approximation:
the row contains exactly the tokens that question may attend to, at the same
positions, so its readout is the one the packed form would have produced.
Upstream states the same equivalence in `kev.model.rows_of`. It was measured
here before the port — packed and `/v1/systemone/separate` agreed on 18/18
records for both score and boolean.

It is not free: N passes re-read the state N times, which cost 1.7x the tokens
of the packed form on the judgment-site corpus. `usage.input_tokens` reports
what was actually processed, so it is larger than the PyTorch service's figure
for the same request. That is the honest number, not a comparable one.

Run:
    python -m llamacpp_serve --run ~/.local/share/weave/kev/models/kev-4b \
        --backbone http://127.0.0.1:8099 --weights Qwen3-4B-Base.Q4_K_M.gguf --port 8001
"""
import argparse
import json
import time
import urllib.request

# inference limits, matching kev.serve
INFER_MAX_STATE, INFER_MAX_BRANCH = 8192, 8192

HIDDEN_TIMEOUT_S = 600


def branch_records(rec: dict) -> list[dict]:
    """One internal record per question, each carrying the whole shared state.

    The state is repeated rather than shared because each branch is a separate
    forward pass. Question order is preserved: probabilities come back one
    branch at a time and are zipped against a metadata list built once, in
    request order.
    """
    return [{"state": rec["state"], "questions": [q]} for q in rec["questions"]]


def checkpoint_identity(run: str, weights: str) -> dict:
    """What `/api/info` reports: the fields the readiness probe compares, plus
    disclosure of what is actually serving them.

    The probe in `createSystemdKevRuntime` compares `run`, `base` and `lora`
    only, and this service does serve that checkpoint — but at reduced
    precision on a different runtime, so it says so rather than presenting
    itself as the default service.
    """
    import torch

    meta = torch.load(f"{run}/head.pt", map_location="cpu", weights_only=True)
    return {
        "run": run,
        "base": meta["base"],
        "base_revision": meta.get("base_revision"),
        "lora": meta["lora"],
        "device": "llama.cpp",
        "backend": "llama.cpp",
        "weights": weights,
        "packed": False,
    }


def load_head(run: str):
    """The pointer head, in torch. Four small matrices; the backbone is elsewhere.

    A checkpoint may carry a fitted calibration temperature. Ours does not, so
    the divisor is 1.0 and the probabilities are raw — but ignoring a
    temperature that is present would silently mis-calibrate every answer.
    """
    import torch
    from kev.model import PointerHead

    meta = torch.load(f"{run}/head.pt", map_location="cpu", weights_only=True)
    head = PointerHead(meta["head"]["q.weight"].shape[1], dp=meta.get("head_dim", 256))
    head.load_state_dict(meta["head"])
    head = head.float().eval()
    head.kev_temperature = float(meta.get("temperature", 1.0) or 1.0)
    return head


def llamacpp_hidden(backbone: str, timeout: int = HIDDEN_TIMEOUT_S):
    """Per-token hidden states from a llama.cpp server.

    `--pooling none` makes `/embedding` return `last_hidden_state` rather than a
    pooled sentence vector; `--embd-normalize -1` leaves it unnormalised. The
    result matches the PyTorch backbone at cosine 0.9971.
    """
    import torch

    url = f"{backbone.rstrip('/')}/embedding"

    def hidden(ids):
        request = urllib.request.Request(
            url, data=json.dumps({"content": list(ids)}).encode(),
            headers={"content-type": "application/json"},
        )
        payload = json.load(urllib.request.urlopen(request, timeout=timeout))
        if isinstance(payload, list):
            payload = payload[0]
        return torch.tensor(payload["embedding"], dtype=torch.float32)

    return hidden


def branch_probabilities(tok, head, rec: dict, hidden) -> list[list[float]]:
    """One probability distribution per question, in request order.

    `hidden` is the seam: any callable from token ids to a `[L, d]` tensor of
    per-token hidden states. Injected rather than imported so the readout can be
    tested without a backbone.
    """
    import torch
    from kev.model import encode

    out = []
    for branch in branch_records(rec):
        enc = encode(tok, branch, max_state=INFER_MAX_STATE, max_branch=INFER_MAX_BRANCH)
        states = hidden(enc["ids"])
        if states.shape[0] != len(enc["ids"]):
            raise RuntimeError(
                f"backbone returned {states.shape[0]} hidden states for {len(enc['ids'])} tokens; "
                "a short response would silently read the wrong positions"
            )
        with torch.no_grad():
            logits = head(states[enc["decide_idx"][0]], states[torch.tensor(enc["opt_idx"][0])])
            logits = logits / getattr(head, "kev_temperature", 1.0)
            out.append(torch.softmax(logits, -1).tolist())
    return out


def answer(tok, head, req, hidden) -> dict:
    """The `/v1/systemone` envelope, built by upstream's own answer shaping."""
    from kev.api import output_tokens, to_answers, to_record
    from kev.model import encode

    started = time.time()
    rec, meta = to_record(req)
    probs = branch_probabilities(tok, head, rec, hidden)
    tokens = sum(
        len(encode(tok, b, max_state=INFER_MAX_STATE, max_branch=INFER_MAX_BRANCH)["ids"])
        for b in branch_records(rec)
    )
    answers = to_answers(probs, meta)
    return {
        "model": req.model,
        "answers": answers,
        "usage": {"input_tokens": tokens, "output_tokens": output_tokens(tok, answers)},
        "latency_ms": round((time.time() - started) * 1000, 1),
    }


def create_app(run: str, backbone: str, weights: str, hidden=None):
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from kev.api import SystemOneRequest
    from transformers import AutoTokenizer

    # NB: this module must not use `from __future__ import annotations`. FastAPI
    # resolves handler annotations against module globals, and SystemOneRequest is
    # bound here, in a closure. A stringified annotation would be unresolvable and
    # the request body would be demoted to a query parameter (HTTP 422).
    app = FastAPI(title="kev-llamacpp")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    tok = AutoTokenizer.from_pretrained(run)
    head = load_head(run)
    hidden = llamacpp_hidden(backbone) if hidden is None else hidden
    identity = checkpoint_identity(run, weights)

    @app.get("/api/info")
    def info():
        return identity

    @app.post("/v1/systemone")
    def systemone(req: SystemOneRequest):
        return answer(tok, head, req, hidden)

    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, help="checkpoint directory holding head.pt and the tokenizer")
    parser.add_argument("--backbone", default="http://127.0.0.1:8099", help="llama.cpp server serving the quantised backbone")
    parser.add_argument("--weights", required=True, help="the backbone file llama.cpp was started with, for disclosure")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    import uvicorn

    uvicorn.run(create_app(args.run, args.backbone, args.weights), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
