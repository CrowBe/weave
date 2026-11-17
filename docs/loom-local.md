# Local Loom experiment

Development branch: `rethink/loom-local`. This experiment tests the decomposition
frontier before growing Tapestry. It does not replace the existing runtime or
claim the existing goal-completion contract is implemented by a model verdict.

The operator submits text to one loopback workspace. Each task passes through
grounded extraction, a closed band decision, then capability selection, a split,
generation, or a question. Every child re-enters the same loop. Independent
children run concurrently; dependent children receive only completed dependency
results. A parent joins all children into a structured result without silently
asking a generative model to write a summary. Proposed plans require a recorded
coverage/usefulness judgment before admission. Cycles, duplicate siblings,
ancestor repetition, excessive nodes, depth and calls are refused deterministically.

Initially only the established, effect-free `text.normalize` Fabric capability is
available. Submitted text and dependency results are the complete work scope.
No shell, filesystem, publication, or capability generation is granted. Novel
text generation is an explicit band, routed separately from extraction and
decision; its result is marked as requiring review. A completed experimental run
means its admitted operations settled, not that generated prose is proven true.

The workspace starts empty. It offers input, stop, new run, results and expandable
execution evidence. Active work is held in memory; settled evidence is archived
locally and can be downloaded. Restart does not recover execution. Bounded call counts, per-call cost reservations, node
counts, a deadline and an abort signal prevent unbounded experiments. Provider
failures stop visibly; they do not trigger an implicit frontier fallback.

First checks: established operation; independent children; dependent child;
recursive child; explicit generation; invalid plan; unavailable decision provider;
budget exhaustion; cancellation. Scripted ports in tests are test doubles only,
never the workspace's live execution path.

## Run it

```sh
npm install
npm run loom:local
```

Open `http://127.0.0.1:5180`. `npm run host:workspace` starts the same host.
`LOOM_PORT` changes the loopback port. Configuration is read on startup.

## Installed local models and hosted extraction

On this machine, the first two models are downloaded and verified in the ignored
`.local/inference` directory. No system-wide installation is required.

```sh
npm run loom:models:setup   # fetch pinned runtime/weights and verify SHA-256
npm run loom:models         # keep this terminal open; Ctrl-C stops owned processes
npm run loom:models:status
```

The CPU launcher uses llama.cpp b12359, a 4K context, one slot per model, four
execution threads and six batch threads. Model revisions and hashes are pinned
in `scripts/loom-models.mjs`. Text reasoning is disabled for bounded schema work.

| Route                               | Model                                                | Local endpoint                       | Weights |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------------ | ------- |
| Text extraction and split proposals | LiquidAI/LFM3-1.7B, Q4_K_M                           | `http://127.0.0.1:8081/v1`           | 1.10 GB |
| Native decisions                    | LiquidAI/d1-2B, Q8_0                                 | `http://127.0.0.1:8082/v1/systemone` | 1.85 GB |
| Native extraction                   | Cloudflare Clairic through authenticated `cf ai run` | Cloudflare Workers AI                | Hosted  |

The worktree's ignored `.env.local` selects these routes:

```sh
LOOM_EXTRACTOR=clairic
LOOM_LOCAL_BASE_URL=http://127.0.0.1:8081/v1
LOOM_LOCAL_MODEL=lfm3-1.7b
LOOM_DECISION_BASE_URL=http://127.0.0.1:8082
LOOM_DECISION_MODEL=d1-2b
```

Clairic uses native typed text fields, not generated JSON. Exact spans and
truncation are checked before values reach Loom; guesses for null answers are
never promoted. The CLI keeps its own authentication, and request bodies use
private temporary files removed after settlement. Billing records use returned
input-token usage at $0.10 per million tokens, including repeated passes, with
zero output tokens. See [Clairic's model reference](https://developers.cloudflare.com/workers-ai/models/clairic/).

Set `LOOM_EXTRACTOR=` to use LFM3 locally for extraction as well. This is
**generative schema extraction with a grounding gate**, not native single-pass
extraction. Native d1 typed extraction is not yet supported by llama.cpp; its
Noul/Choice/Score endpoint is used for decisions. Liquid documents typed
extraction through Transformers instead. See [d1 serving support](https://docs.liquid.ai/lfm/models/d1-2b).

Without the local decision override, the existing route document and its overlay
select TypeSafe or Amos as before. There is no implicit provider fallback.
Without the local text override, explicitly configured non-training flash routes
may be used. Extraction needs an `extract` routed unit; split proposals need a
`transform` unit. Strong generation remains separately configured, and neither
local text nor Clairic silently enables a frontier route.

### Other LFM3 models

The [six-model release](https://huggingface.co/blog/LiquidAI/lfm3) also includes
LFM3-VL-2B, LFM3-Audio-2B, LFM3-Omni-2B and d1-omni-2B. These cover vision,
audio, omni generation and omni decisions. They are not installed by this first
text-workspace setup. Quantized weights are plausible within this machine's
32 GiB RAM, but codec/encoder memory, supported serving endpoints and CPU latency
still need individual checks. The gateway should preserve each model's native
operation rather than treating every model as chat completions.

### Live wiring probes

```sh
npm run loom:smoke                         # Clairic + local d1 + Fabric
npm run loom:smoke -- --all-local           # local LFM3 + local d1 + Fabric
npm run loom:smoke -- --compound            # inspect a decomposition request
```

These use only fixed synthetic text, save evidence under `.local/inference`, and
exit nonzero when the run does not complete. They are wiring probes, not a
benchmark or an estimate of model reliability. Both single-operation routes
completed `hello world` on this machine. A two-string request stopped at the
provisional decision gate before decomposition in the hybrid probe. The fully
local compound probe stopped at extraction acceptance. These are observed limitations,
not a reason to lower the gate or a claim that recursive model-driven work is
already reliable.

Start with `Normalize whitespace in "  hello    world  "`. Compound requests can
exercise split admission and recursive child execution. With only normalization
available, unsupported deterministic tasks stop rather than inventing a
capability. This small catalogue is deliberate; grow it from observed gaps.

Per run: at most 32 task nodes, depth 8, three simultaneous steps, 64 inference
calls, five minutes, and $1 of configured token-price accounting. Each in-flight
inference reserves up to $0.25 and returns unused reservation on settlement.
Prices are those in the route document, not a live billing guarantee. The
choice gate provisionally requires probability ≥ 0.70 and margin ≥ 0.15;
these are experimental thresholds, not measured calibration.

`npm run test:loom-local` runs the local loop, API and real-Fabric integration
tests without provider calls. `npm run verify` retains the repository's broader
checks. Download evidence before clearing a run or restarting the server.

## Clarification and Gauge feedback

When a decision fails its admission gate, or Loom selects `ask_human`, one
bounded flash-model call formulates a specific question from the original
request, actual available operations and decision evidence. It shares the run's
inference allowance and cancellation signal. It cannot dispatch an operation,
change a grant, select a frontier model, or turn a question into task completion.
The result stays `needs_human`. If question generation fails, both the original
stop and the failed attempt remain visible in evidence.

The workspace displays the question and accepts an answer. A reply starts a
linked attempt retaining the original request and question; it does not grant
new capabilities. Stale question identifiers are refused.

On settlement, the local host writes immutable run snapshots and validated Gauge
records to `.local/gauge/runs/`. The original input, model distributions,
extraction spans, question attempts, results, call counts and accounted costs
remain available. Gauge uses existing criteria, case sets, governed revisions,
evaluation results, info-only results and attribution records. It imports no
Loom implementation and changes no model threshold or routing preference.

The feedback checks ask whether a question was present when needed, whether a
rejected decision blocked further dispatch, and whether a question was kept
separate from completion. Passing these narrow checks does not evaluate the
usefulness of the question or correctness of the original task's output.
Diagnostic measures retain decision rejections, clarification attempts, exact
span character coverage, capability no-match observations and inference use.
Semantic extraction completeness is explicitly unassessed; span grounding does
not prove it. Root-cause attribution abstains when the existing evidence does
not establish a supported category. The original missing-question run is
retained as a failed feedback check, even when a later question is available.

The latest settled run is restored for display after a server restart, without
executing or recovering work. New run clears that display while retaining the
archives. Recording failures are shown explicitly. In-flight work is still held
in memory; this is settlement recording, not crash recovery. CLI smoke probes
write equivalent Gauge archives to `.local/gauge/smoke/`.

The composer grows from one line to a maximum of three rows, then scrolls
internally. Enter submits; Shift+Enter inserts a newline, and IME composition
is preserved. Session output is chronological in its own vertical scroll area.
New output follows the bottom until the operator scrolls up. Previous attempts
stay visible during the browser session; New run clears that view. Only the
latest settled attempt is restored after a page reload or service restart.
