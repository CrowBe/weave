# Decision 1.0 Lux 9B paired transfer benchmark

Status: **not run on this host**. This directory records the pinned target and
the reason the planned local comparison cannot be executed faithfully here.
No model weights were downloaded, no CPU inference was attempted, and there
are no Lux predictions or local quality measurements.

## Target and native interface

- Model bundle: `llm-semantic-router/Decision-1.0-Lux-9B` at
  `bd45a30aee8c84032791c245c70f86dee5389cc8` (15.9 GB).
- Native package code: release commit
  `3e46eb1130424b5104893c67ff677a203304f095`.
- Backbone source: `Qwen/Qwen3.5-9B` at
  `c202236235762e1c871ad0ccb60c8ee5ba337b9a`.
- The released Lux bundle is a full-parameter adapted backbone with a shared
  candidate head; it is not a LoRA adapter to merge at inference time.
- Native typed API: `DecisionModel.from_pretrained(path,
  local_files_only=True).decide(state=..., questions=...)`. It accepts
  `Choice`, `Noul`, and `Score` questions and returns typed decisions and
  probability distributions. This is the model's decision interface, not a
  text-generation or gateway endpoint.

These pins and interface come from the official [model card and file
tree](https://huggingface.co/llm-semantic-router/Decision-1.0-Lux-9B/tree/bd45a30aee8c84032791c245c70f86dee5389cc8),
[release code](https://huggingface.co/llm-semantic-router/Decision-1.0-Lux-9B/tree/3e46eb1130424b5104893c67ff677a203304f095/code),
and [runtime instructions](https://huggingface.co/llm-semantic-router/Decision-1.0-Lux-9B/blob/3e46eb1130424b5104893c67ff677a203304f095/RUNTIME.md).

## Why this host cannot produce a valid pilot

The official runtime supports the shipped BF16 backbone and FP32 head with
PyTorch ROCm, FLA Gated DeltaNet, and SDPA. The release was validated on AMD
`gfx942` with PyTorch `2.12.0+git6bbd260`, HIP `7.2.53211`, Transformers
`5.17.0`, Triton `3.7.1`, FLA `0.5.2`, Tokenizers `0.23.2`, and Safetensors
`0.8.0`. Its runtime guide explicitly marks CPU and MPS unsupported and NVIDIA
unqualified. The bundled profile guard also fails closed unless CUDA/ROCm is
available and the detected GPU architecture is `gfx942`.

This host is an Intel Core i7-1355U with no ROCm `gfx942` GPU. A 1–3 case CPU
pilot would either stop at the official hardware guard or require changing the
model/runtime contract. It would not yield a faithful Lux result, so it was
not attempted. No wall-time estimate is recorded because no supported device
is available; the model card's AMD GPU timings are not transferable to this
CPU.

## Paired sample frozen for a future supported run

The existing Jev and Kev 4B local transfer results each contain 125 unique IDs,
and their ID sets match exactly. The selected ID order follows
`benchmarks/inference/jev/transfer-results.json`.

- Kev suite: `~/.local/share/weave/kev/src/evals/v4/transfer-v4/development.jsonl`
- Kev reference: `~/.local/share/weave/kev/runs/kev-4b-fp32-transfer/predictions.jsonl`
- Jev reference: `benchmarks/inference/jev/transfer-results.json`
- Suite SHA256: `ff374c49c6c9f15f8a56fb274b4a4857d20497eb8dd1ac07ce01560e682a5f2e`
- Ordered paired-ID SHA256: `4350abddc802a2a350cdabc57b808bbcd1cd6f7f253074741a10e50b5a82a7a0`

These hashes were checked locally on 2026-09-25. Before a future supported
run, prepare each model-visible record from state and typed question fields
only; keep labels and Jev/Kev outcomes in the scorer process and pass them to
the model API only after inference. The common 125-case transfer sample is
exploratory and is not evidence that it is held out from Lux training.

The official model card's own aggregate evaluation is separate evidence and
does not substitute for this local paired run. No model download, environment
installation, inference run, or scorer implementation has been made under
`.local/decision-lux/` or this directory.
