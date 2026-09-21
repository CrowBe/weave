# Local entailment experiment

Status: experimental; no admitted capability, gateway route, or Jev fallback.

Candidate semantic operation: **`text.assess-entailment`**. Given a premise
and a hypothesis, assess whether the hypothesis follows from, contradicts,
or is not established by the premise. This does not verify the premise's truth.

## Contract under test

- Inputs: nonempty premise and hypothesis, bounded by the recorded tokenizer
  limit. Oversized input fails rather than being silently truncated.
- Result: `entailment`, `contradiction`, or `neutral`, with all three model
  scores preserved. Scores are uncalibrated; neutral is not false. A tied
  maximum yields `undetermined` rather than an arbitrary decision.
- Effects: local checkpoint reads and local result writes only. Evaluation is
  offline, without vendor fallback. Downloading packages and weights is a
  separate preparation step and receives no inference inputs.
- Failure: invalid input, unknown label mapping, malformed scores, unavailable
  model, or exceeded external process timeout. No partial result is promoted.
- Authority: results are observations. Permission checks stay deterministic.
- Quality: hand-labeled exploratory cases are a smoke test, not held-out
  admission evidence or a calibration study. Held-out evidence now exists and
  is weaker than the smoke test implies — see "What has been measured".
  Calibration is still unstudied.

The initial seam under test is the semantic result of one premise/hypothesis
pair. A stub that always returns neutral must fail the labeled corpus before
the real checkpoint is tested. Native sequence-classification scores must be
mapped by label name, not an assumed numeric order.

Privacy and latency constrain which implementation can serve an operation;
they do not make different operations interchangeable. Entailment may later
support evidence matching or a separately evaluated ranking composition.
It does not by itself satisfy general Jev boolean, choice, or score requests.
An API failure cannot silently substitute a different semantic contract.

## Checkpoint

- Repository: `AlexWortega/openjev`
- Revision: `4b5f9a67fa2ebe77466bce0656ce350effc3148c`
- Subfolder: `qwen3.5-4b-nli-v2`
- Native Transformers sequence classification, no trusted remote code.
- CPU, batch size one, maximum 256 tokens per pair; record dtype and threads.

Source: <https://huggingface.co/AlexWortega/openjev>.

The model and isolated environment live in ignored `.local/openjev/`.
There is no background service and nothing starts at login.

## Reproduce

From the repository root, prepare the environment and download the public
checkpoint (network required only for these steps):

```bash
uv venv --python 3.12 .local/openjev/venv
uv pip sync --python .local/openjev/venv/bin/python benchmarks/inference/openjev/requirements.txt \
  --extra-index-url https://download.pytorch.org/whl/cpu
.local/openjev/venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("AlexWortega/openjev", revision="4b5f9a67fa2ebe77466bce0656ce350effc3148c", allow_patterns=["qwen3.5-4b-nli-v2/*", "README.md"], local_dir=".local/openjev/model")'
```

The dependency snapshot is the tested Linux CPU environment, not a universal
lockfile for other operating systems. Then run the offline experiment:

```bash
python3 -m unittest discover -s benchmarks/inference/openjev -p 'test_*.py'
timeout 600 .local/openjev/venv/bin/python benchmarks/inference/openjev/probe.py \
  --model .local/openjev/model/qwen3.5-4b-nli-v2 \
  --output .local/openjev/results.json
```

`--limit 3` provides a short first pass. The external timeout bounds the
entire process; this is not a service with a request deadline or cancellation
protocol.

**Use `--dtype float32 --threads 2`.** Both defaults are wrong for this host
and both were measured, not assumed:

- fp32 is **3.7x faster** than bf16 at sustained clock (8.83 s against 33.02 s
  on a 128-token pair), because this CPU has no vectorised bf16 GEMM. It costs
  memory: peak RSS is **22.1 GiB** against bf16's 7.3 GiB, which fits 31 GiB
  only with the desktop quiet. Cap it (`systemd-run --user --scope
  -p MemoryMax=26G -p MemorySwapMax=0`) so an overrun kills the probe rather
  than the session.
- More threads is *slower* at fp32: 8.83 s at 2 threads against 10.32 s at 8
  and 11.64 s at 12. This is the opposite of the `-t 8` that is correct for
  llama.cpp on the same machine, and the opposite of what bf16 wants.

**Timing this model requires a warmup.** A cold process runs ~69% faster than
it can sustain, and the burst plateau is flat enough that a convergence test
settles inside it. Warm for a fixed 200 s, then re-time a reference forward at
the end and discard the run if it drifted more than 5%. The 4.86 s median
previously recorded here was both bf16 and cold.

The full corpus was recorded before loading the checkpoint. A constant-neutral
placeholder was rejected on 8 of 12 cases (demonstrated red). The five contract
checks separately cover neutral preservation, ties, empty inputs, malformed
scores, and inference failures. Passing those checks does not imply the model
passes the semantic corpus.

## What has been measured

The 12 exploratory cases pass 12/12 at both dtypes, but that corpus is
hand-authored by the harness author and 20-38 tokens long, so it is a smoke
test and nothing more. On held-out records it scores far lower.

- **Held-out accuracy 0.655** (n=307, 95% Wilson [0.600, 0.706]) on Kev's
  `transfer-v4` development split, against a majority-class floor of 0.502 and
  a uniform floor of 0.386 — +5.6 SE over the stronger floor. Reweighted to
  the same source mix, Kev scores 0.835 against OpenJev's 0.727 on identical
  records. Compare each number against its own floor; the two floors here
  differ by twelve points.
- **Strong where the question is entailment, at or below floor where it is
  not.** qnli 0.950 (beating Kev's 0.846) and sciq 0.952, against
  tweet_offensive 0.625 = its floor exactly, contrastive_authorization 0.500,
  emotion 0.550 (floor 0.425), and composition_held_conditional 0.167.
- **On one source the signal is there and the decision rule throws it away.**
  The harness answers true only when entailment is the strict argmax of three
  labels, a boundary set by the checkpoint's head rather than the task. On
  contrastive_authorization that rule answers true to all 22 records and
  scores 0.500 — but `p_entailment` separates the two classes **perfectly**:
  AUC 1.000, all 11 contrast pairs ranked correctly, exact one-sided p 1.4e-6.
  Boolean AUC overall is 0.817 against 0.704 under argmax. **Read a low score
  here as "not usable through this decision rule", not "no signal".**
- **How the question is phrased moves the signal more than anything else
  measured.** A `noul` question can be rendered as the interrogative
  `instructions` or the declarative `criteria.true`. On `tweet_offensive` that
  switch takes AUC from 0.619 (p 0.114, indistinguishable from no signal) to
  **0.827** (p 0.0003); on `paws` it goes the other way, 0.803 to 0.661. One
  rule explains both: an NLI hypothesis must be declarative *and* carry the
  content being asserted. tweet_offensive's post is entirely in the premise
  and its instruction is a contentless question, so the criteria is a pure
  upgrade; paws puts the second sentence — the thing being compared — inside
  the instruction, and its criteria is generic boilerplate, so switching
  deletes the content. Neither rendering is right for every source. In
  aggregate the two shifts cancel to one task in eighty.
- **Uncalibrated, and worst just below certainty.** ECE 0.146, Brier 0.212;
  mean confidence 0.760 against accuracy 0.655. Boolean questions are much the
  worse half (ECE 0.213 against 0.089 for choice), and the 0.8-0.9 confidence
  band holds 41 tasks at 0.488 accuracy. A confidence threshold set just under "very confident"
  admits a bucket that is at chance.
- **Stable, but not discriminating.** On the composition sources it ignores
  every decision-irrelevant perturbation (10/10) and misses half the relevant
  ones (5/10). The 0.167 on composition_held_conditional is that, not a
  logical inversion.
- **No `score` primitive.** Those questions cannot be expressed at all.
- **Latency is linear in premise length** at a flat 13-14 tokens/second: a
  1000-token premise costs 75 seconds. The checkpoint was trained at
  `max_len` 1024 despite advertising 262144 positions.
- **Scores are reproducible** — bit-identical across repeated runs.
- **MMLU rerank 0.53 from the model card was not reproduced** (0.326 rendered,
  0.372 with a bare question premise; the two differ by less than one SE).

Known gaps: every threshold above is fitted in-sample, so the recovery on
contrastive_authorization is an upper bound until a threshold chosen on one
split is tested on another, and the same applies to picking a hypothesis
rendering per source.

See
[`../README.md`](../README.md)
and
[`transfer-results.json`](transfer-results.json)
for conditions, per-source figures and the measurements that were rejected.
None of this is an admission or a calibration claim.

## Held-out evaluation and sustained-clock timing

Two extra harnesses sit beside `probe.py`. Neither is part of `npm run
verify`; both need the checkpoint and take tens of minutes.

`steady.py` measures latency at sustained clock, with the warmup and drift
gate described above:

```bash
systemd-run --user --scope -q -p MemoryMax=26G -p MemorySwapMax=0 \
  .local/openjev/venv/bin/python benchmarks/inference/openjev/steady.py \
  --model .local/openjev/model/qwen3.5-4b-nli-v2 --dtype float32 \
  --thread-counts 1,2,4,8,12 --output .local/openjev/steady-fp32.json
```

It prints `VALID` or `NOT AT STEADY STATE`. Do not quote a run it rejects.

`transfer.py` scores OpenJev on Kev's held-out `transfer-v4` suite, mapping
`choice` to the card's rerank and `noul` to a single pair, skipping `score`.
State text is rendered with Kev's own `render()` so both models read the same
premise. `--plan` estimates cost without loading the checkpoint.

```bash
.local/openjev/venv/bin/python benchmarks/inference/openjev/transfer.py \
  --model .local/openjev/model/qwen3.5-4b-nli-v2 --per-source 40 --plan

systemd-run --user --scope -q -p MemoryMax=26G -p MemorySwapMax=0 \
  .local/openjev/venv/bin/python benchmarks/inference/openjev/transfer.py \
  --model .local/openjev/model/qwen3.5-4b-nli-v2 --per-source 40 --threads 2 \
  --output .local/openjev/transfer-v4.json
```

It reports two floors per source: uniform chance and majority class. Compare
each source against its own, never against another suite's.

`--noul-from-criteria` switches the `noul` hypothesis from the interrogative
`instructions` to the declarative `criteria.true`. Only `tweet_offensive` and
`paws` have a `criteria.true`; the other boolean sources fall back unchanged.
Run it before trusting any boolean result — it changed `tweet_offensive` from
no measurable signal to AUC 0.827:

```bash
... benchmarks/inference/openjev/transfer.py --only-source tweet_offensive,paws \
    --noul-from-criteria --per-source 40 --threads 2
```

`analyse.py` derives the calibration, contrast and ranking figures above from
a `transfer.py` output. It loads no model and takes seconds:

```bash
.local/openjev/venv/bin/python benchmarks/inference/openjev/analyse.py \
  --results .local/openjev/transfer-v4.json \
  --output .local/openjev/transfer-v4-analysis.json
```

It excludes `emotion` by default, for the reason above.
