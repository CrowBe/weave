# Weave

**Software that builds the capabilities it needs and improves how it works.**

Weave is an experimental goal-directed runtime. It observes evolving state, weighs the actions available to it, runs independent work in parallel, and invokes generative models only when existing software cannot adequately advance the goal.

When repeated reasoning reveals a reusable capability, Weave crystallizes it through real-time TDD:

1. Identify the semantic purpose.
2. Establish a typed capability contract.
3. Generate and validate executable tests, then demonstrate red.
4. Generate one or more implementations and prove green within declared limits.
5. Admit against recorded evidence; authorize execution separately.

Weave also optimises existing capabilities and operating strategies through bounded experiments: compare a versioned candidate with a baseline, authorise promotion within a declared scope, monitor outcomes, and retain or roll back the change. Improvement includes quality, reliability, human effort, latency, and total cost; the optimiser cannot lower the success bar or expand its authority.

AgentSOP defines what a capability means and what an implementation's resolver context must look like. AgentFabric is the capability host that honours those contracts and owns the capability lifecycle. Both are built as packages in this repository — the external AgentFabric repository is a conceptual reference, not a dependency — and kept behind a package boundary: Weave reaches AgentFabric through a capability host port rather than depending on its internals, and neither package imports the loop. Jev is the initial model choice for the decision layer; named judgment sites keep model choice separate from responsibility. Weave owns the loop, policy, state, and authority boundaries.

Start with:

- [VISION.md](./VISION.md) — what Weave is and what it refuses to become.
- [CONTEXT.md](./CONTEXT.md) — the project's ubiquitous language.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the high-level plan: layers, the cycle, state, judgment, capabilities, extension, optimisation, and vertical milestones.
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
- [H1 — bound the log](./docs/h1-bound-the-log.md) — a follow-up hardening step:
  reject oversize and duplicate observations before they are durable.
- [AGENTS.md](./AGENTS.md) — how coding agents should work in this repository.

Weave is early. The first objective is a small scenario that proves authorized concurrent execution, honest handling of stale or interrupted work, and replayable evidence. It then extends to crystallizing one capability from contract through demonstrated red, proven green, admission, and separately authorized execution, followed by a measured optimisation with scoped promotion and rollback.

## Status

M0 (inspect and report), M1 (publish under authority), and M2 (handle a novel
request) are implemented. M3's recorded `text.normalize` composition
(`composition.normalize-report@1`) is implemented and its checks are green.
The earlier `report.fold` fixture in `npm run example:crystallize` remains a
separate procedure arm. M4's fixture facts are fixed in
[M4 §7](./docs/m4-measure-reuse.md). M4-T01 passes. M4-T02 through M4-T06 still
fail their assertions: cached conclusions, `conclusion.policy`, retained
replacement implementations, and the baseline are not implemented. Those
failures are the expected gap, so they do not fail `npm test`. A check that
starts passing fails the suite until that expectation is removed. M5, M6, and
the H1 log bound have behavioral contracts and are not implemented. The host refuses to
execute a supplied implementation, framing profiles are versioned records, and
the framing view lists the host catalogue.

`packages/agentsop` holds the contract layer, `packages/agentfabric` the enforcing
host, and `packages/weave` the runtime. `packages/gateway` supplies bounded
generation and typed evaluation through replaceable providers. Requires Node
22 or later; offline entailment contract tests also require Python 3.

```bash
npm install
npm run verify   # structural checks, build, runtime and gateway suites, examples, Jev benchmarks, and entailment and decision contract tests
```

Local inference experiments and their recorded evidence live under
[`benchmarks/inference`](./benchmarks/inference/README.md). OpenJev evaluates
the distinct `text.assess-entailment` operation. Kev 4B is available as a
bounded baseline-quality local fallback for typed evaluation, with its source,
environment and weights kept outside the checkout. See the
[Kev operating guide](./benchmarks/inference/kev/SERVICE.md) for external
service registration, privacy-only routing and fallback composition.
