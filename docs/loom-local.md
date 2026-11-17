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
execution evidence. Runs are held in memory; evidence can be downloaded. Restart
does not recover work. Bounded call counts, per-call cost reservations, node
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

Decision routing uses `weave.routes.json` (or the example) and the existing
`weave.routes.local.json` overlay. Its configured default decision provider is
used for this experiment's sites: TypeSafe with its configured credential, or
local Amos. There is no decision-provider fallback.

For local extraction/split proposals, add these to the git-ignored `.env.local`:

```sh
LOOM_LOCAL_BASE_URL=http://127.0.0.1:8000/v1
LOOM_LOCAL_MODEL=your-installed-text-model
```

The endpoint must implement OpenAI-compatible chat completions. The workspace
does not install, download or start a model. The URL and model above are a
configuration example, not a claim that a service is installed. Configuring a
local text endpoint replaces hosted **flash** routes for this experiment.

Alternatively supply a non-training-allowed flash `generate` / `transform`
unit in the existing route document with an available adapter credential.
Supported generation adapters are `vercel-ai-gateway`, `muse-spark` and
`nous-portal`; contributor units marked training-allowed are deliberately
excluded from this submitted-text workspace. A Vercel unit uses
`AI_GATEWAY_API_KEY`. Frontier text generation requires a separately configured
**strong** unit; flash extraction never falls through to it. Missing routes
stop explicitly. CLI generation routes are not used: this experiment grants no
workspace or process effects.

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
