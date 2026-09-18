# Weave

**Software that builds the capabilities it needs.**

Weave is an experimental goal-directed runtime. It observes evolving state, weighs the actions available to it, runs independent work in parallel, and invokes generative models only when existing software cannot adequately advance the goal.

When repeated reasoning reveals a reusable capability, Weave crystallizes it through real-time TDD:

1. Identify the semantic purpose.
2. Establish a typed capability contract.
3. Generate and validate executable tests.
4. Generate one or more implementations.
5. Admit only an implementation that produces deterministic evidence of correctness.

AgentSOP defines what a capability means and what a resolver must look like. AgentFabric is the runtime that honours those contracts and owns the capability lifecycle. Both are packages in this repository, kept behind a package boundary: Weave reaches AgentFabric through a capability host port rather than depending on its internals, and neither package imports the loop. Jev is the initial fast decision layer for evaluating state, weighting actions, and classifying what is ready for capture or needs more work. Neither is the agent: the Weave runtime owns the loop, policy, state, and authority boundaries.

The project is currently at the architecture and vocabulary stage. Start with:

- [VISION.md](./VISION.md) — what Weave is and what it refuses to become.
- [CONTEXT.md](./CONTEXT.md) — the project's ubiquitous language.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the high-level plan: layers, the cycle, state, judgment, capabilities, extension, and milestones.
- [AGENTS.md](./AGENTS.md) — how coding agents should work in this repository.

Weave is early. The first objective is to prove a minimal loop that can observe state, weigh a typed action frontier, execute safe actions, and crystallize one capability from contract through red-green validation.
