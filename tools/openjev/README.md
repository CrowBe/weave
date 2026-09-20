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
  admission evidence or a calibration study.

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
uv pip sync --python .local/openjev/venv/bin/python tools/openjev/requirements.txt \
  --extra-index-url https://download.pytorch.org/whl/cpu
.local/openjev/venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("AlexWortega/openjev", revision="4b5f9a67fa2ebe77466bce0656ce350effc3148c", allow_patterns=["qwen3.5-4b-nli-v2/*", "README.md"], local_dir=".local/openjev/model")'
```

The dependency snapshot is the tested Linux CPU environment, not a universal
lockfile for other operating systems. Then run the offline experiment:

```bash
python3 -m unittest discover -s tools/openjev -p 'test_*.py'
timeout 600 .local/openjev/venv/bin/python tools/openjev/probe.py \
  --model .local/openjev/model/qwen3.5-4b-nli-v2 \
  --output .local/openjev/results.json
```

`--limit 3` provides a short first pass. `--dtype float32` is a separate
experiment with roughly twice the weight memory; do not assume it fits the
currently available RAM. The external timeout bounds the entire process;
this is not a service with a request deadline or cancellation protocol.

The full corpus was recorded before loading the checkpoint. A constant-neutral
placeholder was rejected on 8 of 12 cases (demonstrated red). The five contract
checks separately cover neutral preservation, ties, empty inputs, malformed
scores, and inference failures. Passing those checks does not imply the model
passes the semantic corpus.

The first complete offline run passed 12/12 exploratory cases, with a median
latency of 4.86 seconds per pair on the i7-1355U. See
[`docs/research/local-inference-evaluation.md`](../../docs/research/local-inference-evaluation.md)
and its raw result file for conditions and limits. This result is not an
admission or a calibration claim.
