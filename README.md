# Weave

**Software that builds the capabilities it needs.**

Weave is a minimally functional harness around an AgentSOP catalogue. Given a goal, it identifies capability gaps, constructs candidates with generative inference, checks them deterministically, evaluates the evidence with a typed decision layer, and crystallizes only what passes those gates.

Generative models are used when the catalogue cannot yet advance the goal. Their output is an observation. Jev-style evaluation weighs actions and judges check evidence; it does not generate resolvers and cannot waive a failed check.

```
AgentSOP document   →  durable semantic name
AgentFabric         →  catalogue, grants, invoke, bind resolver
Checks              →  deterministic red / green / held-out evidence
Decision layer      →  weigh actions; evaluate check evidence
Weave runtime       →  assemble state + capabilities → weigh → act
```

| Layer | Package | Role |
| --- | --- | --- |
| **AgentSOP** | `@weave/agentsop` | Capability documents, ResourceRefs, effects, Result codes. No Weave, no Fabric runtime. |
| **AgentFabric** | `@weave/agentfabric` | Catalogue, principals, grants, invocation, crystallization as binding. Does not schedule, check, or evaluate trust. |
| **Weave** | `@weave/runtime` | `state`, `capabilities`, `checks`, decision, policy, loop. |

Expansion gates stay separate: **identify → construct → check → evaluate → crystallize → grant**. A named capability may exist and still be unresolved. Crystallizing a resolver does not grant the goal principal permission to invoke it.

```
npm install
npm test
npm run typecheck
npm run demo
```
