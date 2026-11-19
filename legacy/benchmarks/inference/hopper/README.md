# Hopper local transfer benchmark disposition

Status: prepared, not run. This is an exploratory paired comparison, not
routing evidence or an admitted implementation.

## Pinned system

- Model/adapter: [`HopitAI/hopper`](https://huggingface.co/HopitAI/hopper) at
  Hub revision `80262fe93c42df744578d7cd8c48726b3b668b99`. The model card at
  this revision identifies the 1.1.1 serving-code release; its adapter weights
  and calibration map are unchanged from 1.1.0.
- Backbone: [`Qwen/Qwen3.5-4B`](https://huggingface.co/Qwen/Qwen3.5-4B) at
  revision `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a` (the backbone revision
  named by Hopper's model card).
- Serving code: [`hopit-ai/hopper`](https://github.com/hopit-ai/hopper), tag
  `v1.1.1`. The source release documents its environment and startup checks in
  the [official README](https://github.com/hopit-ai/hopper#gpu-and-memory).
- Native typed decision interface: `Decider.decide` or its HTTP
  `POST /v1/systemone` endpoint. Hopper applies Qwen3.5's chat template with
  thinking disabled, reads one next-token logit per option letter, softmaxes
  those logits, then applies its per-type calibration map. It does not generate
  free text. For this transfer comparison, all menus are at most 26 options;
  the 1.1.1 long-menu path is not needed.

The model card states “research and demo use only” and says the adapter must not
be used commercially because its training data includes RACE material via
MMLU's auxiliary set.

## Paired suite

The intended input is the exact set already measured for Jev and Kev 4B:
`transfer-v4/development.jsonl`, selected by the 125 IDs in the saved Jev and
Kev transfer results. The current suite SHA-256 is
`ff374c49c6c9f15f8a56fb274b4a4857d20497eb8dd1ac07ce01560e682a5f2e`; the
ordered paired-ID SHA-256 is
`4350abddc802a2a350cdabc57b808bbcd1cd6f7f253074741a10e50b5a82a7a0`.
It contains 72 `choice`, 43 `noul`, and 10 `score` decisions.

The model request must contain only the state's content and the typed question
(`type`, `instructions`, and `criteria`). The `label`, Jev outcome, and Kev
outcome remain in the scorer and must never be included in the request. Pairing
is valid only if the completed Hopper output resolves all 125 identical IDs.

Use the same scoring rules as the existing local transfer comparison:

- `choice`: returned choice key;
- `noul`: true at probability `>= 0.5`;
- `score`: nearest ordinal level, with absolute level error also reported.

Keep Hopper's native response and per-record latency, plus peak process RSS,
alongside paired Jev/Kev correctness. Treat its confidence as unvalidated on
this suite; the model card says its calibration map was fitted on the authors'
own held-out JevBench-style data.

## No-run disposition (2026-09-25)

No weights were downloaded and no inference was started. This host has no
visible NVIDIA runtime (`nvidia-smi` is absent), Python 3.14.7, and none of
`torch`, `transformers`, `peft`, `accelerate`, `flash_linear_attention`, or
`causal_conv1d` installed in the default interpreter. Other isolated
environments in this workspace do have some of those packages, but they do not
provide the required GPU. Hopper's official installation instructions pin
Python 3.12, PyTorch 2.8.0, Transformers 5.17.0, PEFT 0.21.0, Accelerate
1.15.0, flash-linear-attention 0.5.2, and causal-conv1d 1.7.0. The official
server startup verifies that its fast linear-attention GPU kernels actually
ran and refuses the slow reference path; the source documents a CUDA GPU with
at least 16 GB memory. Therefore a faithful pilot is not available on this
host. CPU inference would bypass the published runtime/performance contract,
so no substitute path was attempted.

When a compatible host is available, first run at most three cases through the
official v1.1.1 native server and record peak RSS, per-case latency, and the
full-run ETA. Continue to 125 only after confirming the request/response shape,
matching IDs, and that the label-bearing fields remain outside the model
request. Keep weights and runtime under ignored `.local/hopper/`; do not change
gateway routing.
