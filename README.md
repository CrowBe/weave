# Weave

**Software that builds the capabilities it needs and improves how it works.**

Weave is an experimental, composable agent system. Its reference runtime, Loom, observes evolving state, weighs the actions available to it, runs independent work in parallel, and invokes generative models only when existing software cannot adequately advance the goal.

When repeated reasoning reveals a reusable capability, Weave crystallizes it through real-time TDD:

1. Identify the semantic purpose.
2. Establish a typed capability contract.
3. Generate and validate executable tests, then demonstrate red.
4. Generate one or more implementations and prove green within declared limits.
5. Admit against recorded evidence; authorize execution separately.

Weave also optimises existing capabilities and operating strategies through bounded experiments: compare a versioned candidate with a baseline, authorise promotion within a declared scope, monitor outcomes, and retain or roll back the change. Improvement includes quality, reliability, human effort, latency, and total cost; the optimiser cannot lower the success bar or expand its authority.

AgentSOP defines what a capability means and what an implementation's resolver context must look like. Fabric is the reference capability subsystem that honours those contracts and owns its capability lifecycle. Both are built as packages in this repository; the external AgentFabric repository is a conceptual reference, not a dependency. Loom uses a capability host port rather than Fabric internals, so another provider can satisfy that boundary. Fabric does not import Loom. Jev is the initial model choice for the decision layer; named judgment sites keep model choice separate from responsibility. Loom owns the loop, policy, state, and authority boundaries.

Start with:

- [VISION.md](./VISION.md) — what Weave is and what it refuses to become.
- [GLOSSARY.md](./GLOSSARY.md) — the project's ubiquitous language.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the high-level plan: layers, the cycle, state, judgment, capabilities, extension, optimisation, and vertical milestones.
- [docs/design-system.md](./docs/design-system.md) — Tapestry, the reference presentation layer. Weave is the system; Loom and Fabric are its reference runtime and capability subsystem. A plan, not a milestone.
- [docs/agentfabric-concepts.md](./docs/agentfabric-concepts.md) — which capability-system concepts carry over from the external AgentFabric, which do not, and the in-repo surface to build.
- [docs/m0-inspect-and-report.md](./docs/m0-inspect-and-report.md) — the behavioral contract and checks for the first milestone.
- [M1 — publish under authority](./docs/m1-publish-under-authority.md) — approvals,
  enforced effects, cancellation and crash recovery.
- [M2 — handle a novel request](./docs/m2-handle-a-novel-request.md) — bounded
  inference, validated proposals, state views, and stale-judgment rejection.
- [M3 — fill one capability gap](./docs/m3-fill-a-capability-gap.md) — contract,
  red, isolated green, admission, and a separate execution grant.
- [M4 — measure reuse](./docs/m4-measure-reuse.md) — cached conclusions,
  cross-goal access, and the optimisation baseline.
- [M5 — improve one operating strategy](./docs/m5-improve-an-operating-strategy.md)
  — one profile change, a protocol fixed before results, promotion, and rollback.
- [M6 — route a reconstructed view](./docs/m6-route-a-reconstructed-view.md)
  — prefix-cache routing, catalogue index and schema slices, read-set
  destinations, and one shared slice assembly.
- [M7 — decision-model loop (planned)](./docs/m7-decision-loop.md): P1 adds
  gateway tier/configuration primitives; the decision loop is not implemented.
- [H1 — bound the log](./docs/h1-bound-the-log.md) — a follow-up hardening step:
  reject oversize and duplicate observations before they are durable.
- [AGENTS.md](./AGENTS.md) — how coding agents should work in this repository.

Weave is early. The first objective is a small scenario that proves authorized concurrent execution, honest handling of stale or interrupted work, and replayable evidence. It then extends to crystallizing one capability from contract through demonstrated red, proven green, admission, and separately authorized execution, followed by a measured optimisation with scoped promotion and rollback.

## Status

M0 (inspect and report), M1 (publish under authority), M2 (handle a novel
request), M3 (recorded `text.normalize`), M4 (measure reuse), and M5 (improve
one operating strategy) are implemented. The composition is
`composition.normalize-report@1`. A cached conclusion is reused only while
its input digest, read set, contract revision, admitted implementation, and
authority scope still hold. `conclusion.policy` is the cross-goal record.
The `profile.frame@1` baseline is recorded from the repeated workload,
including the failing goal. `profile.frame.narrow@1` is promoted for that
workload only after a protocol recorded before the comparison, and only when
quality holds and human corrections do not increase. A cheaper profile that
misses the quality bar is refused. A protected-case regression selects the
baseline profile again. The earlier `report.fold` fixture in
`npm run example:crystallize` remains a separate procedure arm. M6 prices a
prefix cache at routing time, discloses the catalogue as an index and named
schemas, narrows destinations from the read set, and shares one slice
assembly across a read-only review. H1 rejects an oversize, mid-value, or
duplicate observation before it is durable, refuses a second open of the host
store, and evicts retained trace records outside the state-transition lock.
The host refuses to execute a supplied implementation, framing profiles are
versioned records, and the framing view lists the host catalogue.

`packages/agentsop` holds the contract layer, `packages/agentfabric` the enforcing
host, and `packages/weave` the runtime. `packages/gateway` supplies bounded
generation and typed evaluation through replaceable providers. `packages/tapestry`
holds the presentation core for the first workspace slice: project navigation,
the conversational surface, and a pending authority request. `packages/tapestry-web`
paints that tree. `packages/loom-binding` discloses a workspace view from recorded
Loom state and does not hand the renderer a locator or the runtime's internal
state. Requires Node 22 or later; offline entailment contract tests also require
Python 3.

```bash
npm install
npm run verify           # structural checks, build, suites, the web host, examples, and contract tests
npm run host:workspace   # read-only web workspace at http://127.0.0.1:5173
npm run lint:report      # vp lint, report only; does not fail or change files
npm run fmt:report       # vp fmt --check, report only; does not fail or change files
npm run verify:cached    # same checks as verify, replayed by Vite Task when inputs match
```

`lint:report` and `fmt:report` are report-only. They print Oxlint and Oxfmt findings and always exit successfully. They do not rewrite files and they are not part of `npm run verify`. CI runs them after verify with `continue-on-error`. Do not treat a green verify run as a clean lint or format result.

`verify:cached` runs the same `npm run verify` command through `vp run` so a repeat can be replayed from the Vite Task cache. `npm run verify` itself stays uncached, and CI uses that command.

Local inference experiments and their recorded evidence live under
[`benchmarks/inference`](./benchmarks/inference/README.md). OpenJev evaluates
the distinct `text.assess-entailment` operation. Kev 4B is available as a
bounded baseline-quality local fallback for typed evaluation, with its source,
environment and weights kept outside the checkout. See the
[Kev operating guide](./benchmarks/inference/kev/SERVICE.md) for external
service registration, privacy-only routing and fallback composition.

Use `npm run example:chatgpt-signin` to continue with ChatGPT, then `npm run example:chatgpt-probe -- --out .local/chatgpt-probe.json` to record live API evidence (create `.local/` first).

The gateway supports TypeSafe System One and a local, no-key Amos decision
adapter (`@weave/gateway/amos`). `weave.routes.example.json` retains
`typesafe-jev` / `jev-preview` as the default and overrides `intake.classify`
to Amos. `loop.preselect` may be overridden to `amos` or `typesafe-jev` when a
matching Amos boolean evaluate unit is present; the example does not override
it. `decision.preselect` sets that site's k, floor, and margin gate per
provider (default k 3, floor 0, max excluded .4, minimum margin .3). Pass the
parsed `decision` to `createInferenceGateway` and register both evaluators.
Override selection is exclusive and configuration rejects unknown providers,
unknown override sites, and an out-of-range
preselect policy. Run `npm run example:preselect` to print one D3 selection.
Pass `--provider amos` to use the local adapter. The API key stays in the
environment and is sent only as a Bearer header.

The direct TypeSafe decision model defaults to `jev-preview` (jev-1.14.0);
set the decision provider's `model` and the matching evaluate `units[].model`
in the route configuration to override it.
Choice criteria keys are shuffled per call with Fisher-Yates while retaining
key identities. `TypesafeAiOptions.shuffle` accepts an RNG or `false` to disable
shuffling. Unsupported answer types are dropped; unasked answers are ignored.
`TypesafeAiOptions.longContext?: boolean` defaults to false. When true, every
request sends `TypeSafe-Danger-Zone-Long-Context: true`, raising both context
limits to 262k tokens on `jev-1.13.0` and `jev-1.14.0`. Without it, the defaults
remain 64k per request and 32k per question. See [TypeSafe models](https://docs.typesafe.ai/models#long-context).
`TypesafeAiOptions.images?: boolean` also defaults to false. When true, every
request sends `TypeSafe-Danger-Zone-Images: true`, required for image assets
and box questions. This option only adds the header; Weave does not yet support
asset or box requests. See [TypeSafe images](https://docs.typesafe.ai/images).

The [Jev 1.14 announcement](https://typesafe.ai/blog/jev-1-14) says `jev-latest`
will move to `jev-1.14.0` about a week after 2026-10-14. TypeSafe intends to give
60 days' deprecation notice for `jev-1.13.0` and 30 days for `jev-1.14.0`.
The data-sharing opt-in announced in that blog has no documented request field.
`dataSharing?: false` defaults to false; Weave sends no data-sharing field.

The composition root resolves `AMOS_BASE_URL` with the pure helper
`resolveAmosBaseURL(process.env)` and passes it as `amosEvaluator({ baseURL })`; the default is
`http://127.0.0.1:8766`, restricted to loopback with no authentication. Register
an Amos choice routed unit with model `amos-1-2b` (amos-1-small) and destination
`amos`; the disclosed intake terms must permit that destination. The adapter
checks GET `/v1/models` before POST `/v1/systemone` and bounds HTTP calls with a
timeout. Unreachable, non-2xx health or timeout yields `provider_unavailable`;
intake falls back to `ask_user`, never TypeSafe. Raw provider text is excluded
from Amos failure records. See the [intake contract](packages/weave/src/sites/CONTRACT.md).

Run the opt-in local intake probe after building:
`AMOS_LIVE=1 node --test packages/gateway/dist/test/amos.test.js`.

### Muse Spark contributor example

`npm run example:muse-spark` reads `MODEL_API_KEY` from the environment and
makes one minimal public generation request. The `flash` implementation writers
in `weave.routes.example.json` put `muse-spark-1.3-contributor` before
`muse-spark-1.2-contributor`; callers use `max_attempts_per_route: 1` to escalate
on the primary's first refusal. The JSON price entries are **unknown, flat zero
placeholders**, not verified prices or a claim of free use. The 8192-token
context bound is a conservative local configuration, not a provider specification.

Contributor destinations may train on content. Callers must explicitly set
`terms.content_class` to `public` or `non_sensitive`; absent classification,
`sensitive`, and `private` are excluded even when the destination is listed in
terms. Private repositories and operator/captain data must never be classified
as public or non-sensitive. Before dispatch, the gateway screens content for the
repository's credential markers at token starts. A match records a non-retryable
`invalid_request` attempt with zero usage and prevents dispatch to every routed
unit at that training-allowed destination for the request. Escalation may still
send the original content to a non-training destination permitted by the request's
classification and terms. Screening does not make sensitive or private work
eligible. No reasoning parameter is sent. The declared 150 RPM / 3M TPM
limits do not proactively throttle requests: after a rate-limit refusal,
`Retry-After` wins, otherwise the gateway uses 400ms request spacing; the token
budget is metadata because a refusal does not report token consumption.
