# Weave

**Software that builds the capabilities it needs.**

Weave is a goal-directed runtime. It assembles explicit state, assembles the capabilities AgentFabric currently knows, submits that structure to a deterministic decision layer (Jev is the stand-in), and acts on the weighted frontier.

Generative models are used when the catalogue cannot yet advance the goal. Their output is an observation. Weave's **classifier** is the automatic trust layer AgentFabric does not claim: it checks a generated resolver against an AgentSOP document and a test corpus before Weave asks AgentFabric to crystallize.

```
AgentSOP document   →  durable semantic name
AgentFabric         →  catalogue, grants, invoke, bind resolver
Classifier          →  Weave trust layer for generated resolvers
Weave runtime       →  assemble state + capabilities → weigh → act
```

| Layer | Package | Role |
| --- | --- | --- |
| **AgentSOP** | `@weave/agentsop` | Capability documents, ResourceRefs, effects, Result codes. No Weave, no Fabric runtime. |
| **AgentFabric** | `@weave/agentfabric` | Catalogue, principals, grants, invocation, crystallization as binding. Does not schedule or classify trust. |
| **Weave** | `@weave/runtime` | `state`, `capabilities`, `classifier`, decision, policy, loop. |

A named capability may exist and still be unresolved. Crystallizing a resolver does not grant the goal principal permission to invoke it.

```
npm install
npm test
npm run typecheck
npm run demo
```
