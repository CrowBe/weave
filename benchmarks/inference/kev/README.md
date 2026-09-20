# Local typed-decision experiment

Status: experimental fallback candidate. The gateway has a local Kev adapter
and external-service lifecycle module, but no judgment site is admitted or
routed to it by default. Each composition root must opt in under the limits
recorded here.

Candidate semantic operation: **`decision.typed`**. Given a shared state view
and a set of typed questions — `noul` (boolean), `choice` over named options,
or `score` over an ordered scale — return one probability distribution per
question. Kev produces all of them from a single forward pass over the packed
request rather than generating an answer token by token.

This is a different operation from OpenJev's `text.assess-entailment`, which
relates a premise to a hypothesis. Neither substitutes for the other. See
[`model-selection.md`](model-selection.md)
for why 4B was chosen over 0.6B and 8B.

## Contract under test

- Inputs: a state view and one or more typed questions, under a token budget
  the two paths set very differently — the state may be at most 384 tokens in
  process but roughly 8180 served, with the state and the question drawing on
  one shared allowance. Over budget is refused, not truncated. Every quality
  number in this harness is therefore measured on states of at most 384 tokens.
  See "The two paths are not equivalent" below.
- Result: for each question, a distribution over exactly the declared option
  keys — `true`/`false` for `noul`, the criteria keys for `choice`, the scale
  indices for `score`. Probabilities are finite, in range, and sum to one
  within tolerance; they are renormalised before scoring. They are **not**
  calibrated confidence, and the upstream card describes `score` confidence as
  a surrogate because TypeSafe's formula is unpublished.
- Effects: local checkpoint reads and local result writes only. Evaluation is
  offline, with no vendor fallback. Downloading packages, weights, and the
  suite is a separate preparation step that receives no inference inputs.
- Failure: suite checksum mismatch, option keys that differ from the request,
  non-finite or out-of-range probabilities, a probability sum outside
  tolerance, a request that exceeds the token budget (HTTP 422), or an endpoint
  that stays unreachable across its retries. No partial result is promoted.
  The served path's size error names the question branch even when the state
  is what overran the budget; see below.
- Authority: results are observations. Permission checks stay deterministic.
- Quality: a subsample of the author's development split is a bounded
  measurement on someone else's corpus. It is not held-out admission evidence
  for Weave's own judgment sites, and it is not a calibration study.

A constant predictor that reads neither the state nor the question must fail
this corpus before the real checkpoint is tested. The stub is required to
return well-formed distributions over the correct keys, so that it fails on
accuracy rather than by being unscorable.

API compatibility with `/v1/systemone` does not establish quality parity with
hosted Jev or identical probability semantics. A privacy requirement must fail
closed when no acceptable local implementation is available; it must never
cause a hosted escalation.

## Pins

| Component | Value |
| --- | --- |
| Upstream source | `github.com/jaredpalmer/kev` at `20fa6268c8ceb226530be2fb5266ab2c36b37724` |
| Adapter + pointer head | `jaredpalmer/kev-4b` at `2bd3bb9a9957aff9a4803be7ce91a521cdff0a31` |
| Backbone | `Qwen/Qwen3-4B-Base` at `906bfd4b4dc7f14ee4320094d8b41684abff8539` |
| Checkpoint identity | `v7-rc3/01-trial-1`, per the adapter's `training_config.json` |
| In-distribution suite | `evals/v4/decision-v4`, manifest sha256 `1b33e566d114f9eafeff55b36c221fadb2a4ae358a1b9cc68006e82c7cfad8f1` |
| — its split | `development.jsonl`, sha256 `8d5765d7aec4d08c61854f4664ca79ec2ba44ed092e9b967eaf61ed86c496d9c`, 1204 records / 1468 questions / 1264 clean |
| Out-of-domain suite | `evals/v4/transfer-v4`, manifest sha256 `31677c2256b406222e7d94ffdc0a02a70ce05746b9efe307876024c4e77291d1` |
| — its split | `development.jsonl`, sha256 `ff374c49c6c9f15f8a56fb274b4a4857d20497eb8dd1ac07ce01560e682a5f2e`, 764 records / 764 questions |

The backbone revision is pinned three ways that agree: the adapter's
`head.pt` records `base_revision`, the suite manifest records the same hash,
and the Hub reports it for `main`. `head.pt` also records `lora: 16`,
`head_dim: 256`, `option_isolation: false`.

The locked `test` split is never used here. `kev.suite.load_split` refuses it
without an explicit flag, and this harness does not pass one.

Everything downloaded lives outside the checkout under
`${WEAVE_KEV_HOME:-$XDG_DATA_HOME/weave/kev}`. On this PC that resolves to
`~/.local/share/weave/kev`. The repository contains only this harness, recorded
results, and the gateway code that discovers or starts an operator-registered
service.

## What this harness adds, and what it does not

Upstream owns scoring. `kev.benchmark` defines the metrics, validates every
returned distribution, and writes the report; `kev.suite.load_split` verifies
the split against the manifest checksum. `bench.py` calls all of that as a
library and reimplements none of it, so the numbers below are comparable to
the author's published `result.json` for the same checkpoint.

It adds two things upstream's CLI does not provide:

1. **A deterministic, source-stratified subsample.** A full development pass
   costs hours on this CPU. The subsample cannot be drawn record by record:
   a permuted record is scored against its clean parent, and each contrastive
   pair is scored against its sibling — and every pair spans two parent
   groups. So the sampling unit is the connected component over parent-group
   and pair edges, and the closure is asserted before anything is scored.
2. **A constant predictor**, for the red-first check described above.

## What this suite can and cannot show

**`decision-v4` is an in-distribution suite.** Its manifest lists twelve
`trainable_sources` — banking77, boolq, agnews, mnli, sst5, yelp, trec,
dbpedia14, amazon, imdb, legacy_policy, compositional — and an empty
`holdout_sources`. Every source in the split is a source the checkpoint was
trained on, and the upstream card labels the resulting figure
"in-distribution accuracy". Reproducing the author's number on it is evidence
that the checkpoint, the adapter, the backbone revision, the tokenizer, and
this harness are all installed and wired correctly. It is **not** evidence
that Kev generalises to content it has not seen, and Weave's judgment sites
are exactly that kind of content.

**`transfer-v4` is the out-of-domain counterpart**, and it is the number that
bears on Weave. Its manifest declares `trainable_sources: []`,
`eval_only: true`, and nine holdout sources: mmlu, emotion, tweet_offensive,
qnli, paws, sciq, contrastive, legacy_holdout, composition_holdout. The
upstream card reports 0.790 accuracy and a 0.328 Brier score there, against
0.854 and 0.213 in distribution. Both are run here, and both are reported
below, because quoting only the first would overstate the case.

**The constant-predictor floor is suite-dependent, so the two accuracies are
not comparable to each other.** `decision-v4` is dominated by wide `choice`
questions (banking77 alone has 77 options), and a stub that always takes the
first option scores 0.370. `transfer-v4` carries many binary questions (paws,
qnli, contrastive), and the same stub scores 0.490. The published 0.854 sits
0.48 above its floor; the published 0.790 sits 0.30 above its own. Accuracy
differences across suites are mostly a statement about option counts.

## The two paths are not equivalent

`bench.py --run` scores the model in process; `bench.py --remote` and Weave's
`typesafeAiEvaluator` go over HTTP to `kev.serve`. These are not the same
contract, and the differences are in the server's favour on speed and against
it on safety. Read against `kev/serve.py` and `kev/api.py` at the pinned
commit.

**The two paths accept states that differ by a factor of twenty.**
`LocalPredictor` calls `encode(..., strict=True)` (`benchmark.py:191`) and
leaves the limits at their defaults, `MAX_STATE, MAX_BRANCH = 384, 1024`
(`model.py:11`). The suite manifest declares the same envelope —
`max_state: 384, max_branch: 1024, max_packed: 2048, truncate: false`. The
server instead calls `encode(rec, max_state=8192, max_branch=8192)` with
`strict` left false (`serve.py:46`). Measured against the pinned commit with a
one-question `noul` request:

| state tokens | in process, strict 384/1024 | served, lax 8192/8192 |
| ---: | --- | --- |
| 370 | answered | answered |
| 401 | `ValueError: state exceeds 384 tokens: 401` | answered |
| 1001 | `ValueError: state exceeds 384 tokens: 1001` | answered |
| 9001 | `ValueError: state exceeds 384 tokens: 9001` | `ValueError: branch too long: 12` -> HTTP 422 |

This is the most consequential difference between the two paths, and it is not
a safety hole but a measurement gap. The server will answer a 2000-token state
without complaint; no number in this document, and no number on the upstream
model card, was measured on a state that size. A Weave judgment site that
sends more than 384 tokens of state is operating outside the evaluated
envelope, and the accuracy and calibration figures below do not carry over to
it. Either keep state under 384 tokens, or measure again at the size actually
used.

In the lax mode `encode` keeps `state_tokens[: max_state - 1]` and reports
`state_truncated: True`, which `_probs` then discards — so on a first reading
the server looks like it will answer confidently on a truncated state. It does
not, and the reason is arithmetic rather than a check: the branch guard is
`len(br) > max_branch - len(S)` and both limits are 8192, so a state long
enough to truncate leaves exactly zero branch budget and every question fails.
No silently truncated answer reaches a caller, and the discarded
`state_truncated` flag is unreachable in practice rather than dangerous.

What is wrong is the message. At 9001 state tokens the served path reports
`branch too long: 12`; the 12-token question is not too long, the state
consumed the budget. A caller sizing its request from that error will shrink
the wrong half. `typesafeAiEvaluator` classifies the 422 as `invalid_request`,
non-retryable, which is the correct disposition.

**Probabilities are rounded to two decimals.** `kev/api.py` applies `r2()` to
every served probability and to `confidence`. The recorded hosted TypeSafe
response in the gateway's adapter test carries values at the same precision, so
this reads as the wire contract rather than a Kev defect — but the in-process
path does not lose it, and on a wide `choice` most of the distribution falls
below the rounding floor. `benchmarks/inference/kev/wire_precision.py` replays a completed
local run through exactly this rounding and rescores it, so the cost is
measured rather than asserted.

**The server answers one request at a time.** `_probs` holds `STATE["lock"]`
across the forward pass, so concurrent callers queue. There is no batching.

**The server has no authentication** and selects its device automatically with
no override.

## Results

Measured 2026-09-20 on the i7-1355U, fp32, 8 threads, offline, desktop idle.
Peak RSS 19.3 GiB; cold load 6.3 s (in process) and 7.8 s (server). Raw
figures, per-source breakdowns and the full environment record are in
[`results.json`](results.json);
the discussion is in
[`../README.md`](../README.md).

| | decision-v4 (in-distribution) | transfer-v4 (out-of-domain) |
| --- | ---: | ---: |
| sample | 129 of 1204 records, 138 clean questions | 125 of 764 records, 104 clean questions |
| accuracy | **0.884** | **0.808** |
| always-first stub | 0.370 | 0.490 |
| margin over stub | +0.514 | +0.318 |
| author, full split | 0.854 | 0.790 |
| ECE | 0.082 | 0.081 |
| Brier | 0.199 | 0.291 |
| confident error rate | 0.058 | 0.077 |
| contrastive flip / both-correct | 0.750 / 0.750 (8 pairs) | 0.833 / 0.833 (12 pairs) |
| latency median / p95 | 8.9 s / 52.0 s | 6.4 s / 20.6 s |
| throughput | 14.0 tok/s | 14.3 tok/s |

Both accuracies are **consistent with the author's published figures, not
better than them**: +1.1 standard errors in distribution, +0.5 out of domain.
The samples can separate a working checkpoint from a broken one; they cannot
resolve a few points. Compare each accuracy against its own stub floor rather
than against the other suite — transfer-v4 has more binary questions, so its
floor is higher and the apparent 7.6-point drop understates the real one
(the margin over chance falls from 0.51 to 0.32).

The red-first control passed on both suites before the checkpoint was trusted:
two constant predictors that read neither state nor question returned
well-formed distributions, passed upstream's own validation, and scored a
contrastive flip rate of 0.000 against the checkpoint's 0.750 and 0.833.

Nothing here is calibrated confidence or held-out admission evidence for a
Weave judgment site. It supports only the bounded baseline fallback described
in [`SERVICE.md`](SERVICE.md), not an unrestricted automatic substitution.

## What the HTTP boundary actually does

Measured against a running `kev.serve`, driving the real
`typesafeAiEvaluator` from `packages/gateway`. The adapter needed no change:
it parsed a live Kev response into Weave's answer types, classified an aborted
call as `cancelled` and an unreachable endpoint as `unavailable`/retryable.
The recorded response is now a fixture in
`packages/gateway/test/typesafe-ai.test.ts`.

Four things a caller should know, all observed rather than read:

1. **No request id.** Hosted TypeSafe returns `x-typesafe-request-id`, which
   the adapter surfaces as `provider_response_id` and appends to failure
   messages. Kev sends no such header, so a locally served call has no handle
   for after-the-fact correlation.
2. **The model string is not validated.** `POST /v1/systemone` with
   `"model": "totally-made-up"` is answered by the one loaded checkpoint and
   the made-up name is echoed back in the response. `/v1/models` advertises
   `kev-latest` with a `jev-latest` alias, but there is no routing behind it.
   The response's `model` field is caller-supplied data reflected back, not
   provenance; `GET /api/info` (`run`, `base`, `lora`) is the real identity.
3. **Over-budget input fails fast and is classified correctly.** A 9000-word
   state was refused in 49 ms — before any forward pass — as HTTP 422, which
   the adapter maps to `invalid_request`, non-retryable. The misleading
   `branch too long: 12` text reaches the caller verbatim.
4. **Under-budget-but-unevaluated input is answered silently.** A 1016-token
   state — 2.6x the 384-token limit the benchmark enforces and the suite
   manifest declares — returned `status: completed` with an ordinary-looking
   `probability: 0.57` after 39.3 s. Nothing in the response marks it as
   outside the evaluated envelope. This is the practical risk, not the 422.

Single-question floor latency is about 1.0 s for a 20-token request.

## Reproduce

From the repository root. Choose a data directory outside the checkout.
Network is required only for this preparation step:

```bash
export WEAVE_KEV_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/weave/kev"
git clone https://github.com/jaredpalmer/kev.git "$WEAVE_KEV_HOME/src"
git -C "$WEAVE_KEV_HOME/src" checkout 20fa6268c8ceb226530be2fb5266ab2c36b37724
(cd "$WEAVE_KEV_HOME/src" && UV_PYTHON=3.12 uv sync --extra serve)

export HF_HOME="$WEAVE_KEV_HOME/hf"
"$WEAVE_KEV_HOME/src/.venv/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download("jaredpalmer/kev-4b", revision="2bd3bb9a9957aff9a4803be7ce91a521cdff0a31",
                  local_dir=os.environ["WEAVE_KEV_HOME"] + "/models/kev-4b")
snapshot_download("Qwen/Qwen3-4B-Base", revision="906bfd4b4dc7f14ee4320094d8b41684abff8539",
                  allow_patterns=["*.json", "*.safetensors", "*.txt"])
PY
```

`uv sync` installs upstream's own locked environment: Python 3.12.14,
torch 2.8.0+cu128, transformers 4.57.6, peft 0.21.0. The `+cu128` wheel brings
roughly 7 GB of NVIDIA libraries that this machine cannot use — there is no
CUDA device. A `+cpu` wheel would avoid that, but it is a divergence from the
configuration upstream tests, so this experiment keeps the locked one and
records the cost rather than quietly substituting.

Then run the offline experiment:

```bash
npm run test:decision   # python3 -m unittest discover -s benchmarks/inference/kev -p 'test_*.py'

export WEAVE_KEV_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/weave/kev"
export HF_HOME="$WEAVE_KEV_HOME/hf" HF_HUB_OFFLINE=1 \
       PYTHONPATH="$WEAVE_KEV_HOME/src"
"$WEAVE_KEV_HOME/src/.venv/bin/python" benchmarks/inference/kev/bench.py \
  --stub first --limit 120 --out "$WEAVE_KEV_HOME/runs/stub-first"
"$WEAVE_KEV_HOME/src/.venv/bin/python" benchmarks/inference/kev/bench.py \
  --run "$WEAVE_KEV_HOME/models/kev-4b" --limit 120 \
  --out "$WEAVE_KEV_HOME/runs/kev-4b-fp32"
```

`--suite` selects the corpus; it defaults to the in-distribution
`evals/v4/decision-v4`. Run the out-of-domain suite too — it is the figure
that bears on unseen content, and the stub floor differs between them, so
each suite needs its own control:

```bash
for mode in "--stub first" "--stub uniform" "--run $WEAVE_KEV_HOME/models/kev-4b"; do
  "$WEAVE_KEV_HOME/src/.venv/bin/python" benchmarks/inference/kev/bench.py \
    --suite "$WEAVE_KEV_HOME/src/evals/v4/transfer-v4" $mode \
    --limit 120 --out "$WEAVE_KEV_HOME/runs/transfer-${mode##* }"
done
```

The test file runs under plain `python3` for the sampler checks; the four
constant-predictor checks need `PYTHONPATH` and the venv, and skip otherwise.
`--out` must not already exist — upstream refuses to overwrite a run.

**Do not set `KEV_DTYPE` on this machine.** It halves weight memory, and
upstream applies it on any device (`kev/evaluate.py` reads the variable before
looking at the device, so the README's "CUDA serving option" framing is not
what the code does). But this CPU reports `AVX2` as its capability and its
flags carry no `avx512_bf16` and no AMX, so PyTorch has no vectorised bf16
GEMM and falls back to scalar emulation. Measured on this machine with a
1024-cube matmul, four threads, nothing else running:

| dtype | per matmul | throughput |
| --- | --- | --- |
| fp32 | 17.8 ms | 120.4 GFLOP/s |
| bf16 | 2596.4 ms | 0.8 GFLOP/s |
| fp16 | 2703.8 ms | 0.8 GFLOP/s |

That is a 146x penalty, and it is visible end to end: under `KEV_DTYPE=bf16` a
single 703-token banking77 record took 191 s and a 754-token one took 271 s.
The memory saving is real and useless here. fp32 is the only workable
precision on this hardware, which also means the full ~16 GB of weights has to
fit. Reserve bf16 for a machine whose CPU advertises `avx512_bf16` or AMX, or
for a CUDA device.

To score the HTTP boundary instead of the model in process — the same
`/v1/systemone` contract `packages/gateway/src/adapters/typesafe-ai.ts`
speaks — start the server and point `--remote` at it:

```bash
"$WEAVE_KEV_HOME/src/.venv/bin/python" -m kev.serve \
  --run "$WEAVE_KEV_HOME/models/kev-4b" --port 8008
"$WEAVE_KEV_HOME/src/.venv/bin/python" benchmarks/inference/kev/bench.py \
  --remote http://127.0.0.1:8008 --limit 120 \
  --out "$WEAVE_KEV_HOME/runs/kev-4b-http"
```

`kev.serve` has no authentication and selects its device automatically.
