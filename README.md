# Weave

**Software that builds the capabilities it needs.**

Weave is an experimental goal-directed runtime. It observes evolving state, weighs the actions available to it, runs independent work in parallel, and invokes generative models only when existing software cannot adequately advance the goal.

When repeated reasoning reveals a reusable capability, Weave crystallizes it through real-time TDD:

1. Identify the semantic purpose.
2. Establish a typed capability contract.
3. Generate and validate executable tests.
4. Generate one or more implementations.
5. Admit only an implementation that produces deterministic evidence of correctness.

AgentFabric provides the standard contract and lifecycle for those capabilities. It is architecturally separate but ships with Weave in the same repository and checkout. Jev is the initial fast decision layer for evaluating state, weighting actions, and classifying what is ready for capture or needs more work. Neither is the agent: the Weave runtime owns the loop, policy, state, and authority boundaries.

## Initial build

The first loop is implemented in TypeScript:

- `@weave/agentfabric` — capability contracts, test corpora, demonstrated red, proven green, and admission eligibility. It does not schedule goals.
- `@weave/runtime` — explicit state, a typed action space, heuristic weighing, deterministic policy, concurrent scheduling, and an inference router. Model output is an observation.

The proof is a `normalize_email` capability: contract → tests → red against a placeholder → green against a candidate → held-out admission → approval → parallel execution → goal completion.

```
npm install
npm test
npm run typecheck
npm run demo
```

`npm run demo` prints each cycle: action space, weights, policy rejections, and executed keys. After crystallization it still refuses to execute until approval is granted.

### What this build is not

- The heuristic decision layer is a stand-in. Jev can replace it later through the same `DecisionLayer` contract.
- Demo inference is scripted. The runtime asks for a kind of inference and routes to a binding; it does not own a vendor.
- `vm.runInNewContext` constrains generated local source; it is not a security sandbox.
- Composition of existing capabilities is preferred by the architecture but not yet implemented as a matcher.

A change still has to match [VISION.md](./VISION.md). Use [CONTEXT.md](./CONTEXT.md) for the ubiquitous language and [AGENTS.md](./AGENTS.md) for how to work in this repository.
