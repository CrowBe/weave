# Jev model routing: implementation evidence for Weave

Research date: 2026-09-22. Read against `VISION.md`, `CONTEXT.md`,
`ARCHITECTURE.md`, `packages/gateway/src/routing.ts`, and its gateway tests.
Sources below are maintainers' repositories and documentation as available on this
date. This was a source review, not a checkout, test run, live Jev call, or
independent reproduction of the published experiments. Repository links follow
moving branches, so behavior may change.

## Finding

There are working Jev routing integrations, but the strongest published lesson
for Weave is about **separating the typed judgment from selection policy and
outcome evidence**. A Jev choice over model labels is easy to implement; the
harder parts are establishing which routed units can meet a workload's quality
bar, measuring the accepted result, and proving that Jev adds value over the
same evidence without Jev. The [TokenTrim experiment](https://github.com/TokenTrim/jev-routing-experiment#llmrouterbench--beating-the-best-single-model-on-a-modern-flagship-pool)
is especially useful here: its larger model-routing comparison found a cost and
quality gain from retrieval evidence, while its no-Jev ablation matched the
Jev-assisted result.

## Implementations examined

| Project | What it implements | Evidence level and limit |
| --- | --- | --- |
| [TypeSafeAI/typesafe-router](https://github.com/TypeSafeAI/typesafe-router#what-it-does) | A TypeScript library and Next.js lab. One Jev `choice` over supplied, closed option IDs; validation and deterministic fallback produce an effective option. Logs retain original pick, scores, threshold and fallback. The library does not execute the selected model or tool. | Runnable source and tests are described by its maintainer, but it is an independent community project hosted under the TypeSafeAI organization, not the official SDK or a production authorization system. Its default 0.75 threshold and mock transport are examples, not measured quality guarantees. [Routing policies](https://github.com/TypeSafeAI/typesafe-router#routing-policies), [scope](https://github.com/TypeSafeAI/typesafe-router#what-it-does). |
| [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router#how-it-works) | A loopback proxy for Claude Code and Codex. One decision per fresh user turn selects an abstract tier mapped to the signed-in account's model catalogue; tool-loop continuations retain the tier. Explicit user model requests win; failures keep the current model; low reported confidence prevents downgrades; unavailable tiers step upward. | Runnable CLI integration with tests and a live-test command documented by its maintainer. Its source README reports no end-to-end task-quality comparison. The native account catalogue supplies availability, but the routing policy is a tier heuristic rather than a measured per-workload quality floor. [Policy](https://github.com/gargpratyush/jev-router#routing-policy), [development](https://github.com/gargpratyush/jev-router#development). |
| [BillionsBobby/JevRouter](https://github.com/BillionsBobby/JevRouter#how-it-works) | A decision-only router for heterogeneous candidates. It preserves Jev's raw probabilities separately from availability, permissions, risk, confirmation and fallback fields; records candidate-snapshot hashes and receipts. Large candidate sets get a coarse Top-K Jev call followed by a final Jev call. | Runnable CLI/SDK/MCP/HTTP project with its own benchmark, but its reported Toolathlon/MCP-Atlas results measure ordered tool-choice prediction, **not model selection or completed task quality**. Its “two-stage” means candidate narrowing, different from Weave's can-do filter then ranking. [Decision response](https://github.com/BillionsBobby/JevRouter#decision-response), [benchmark](https://github.com/BillionsBobby/JevRouter#benchmark). |
| [TokenTrim/jev-routing-experiment](https://github.com/TokenTrim/jev-routing-experiment#how-it-works) | Research harness for Jev direct choice, Jev difficulty judgment plus retrieved per-model evidence, evidence-only ablation, and selective Jev. It freezes model pool and prompts, separates dev/eval examples, and scores selected-model answers against external benchmark labels. | The maintainer reports 5,835 held-out LLMRouterBench queries across 13 models: Jev-plus-evidence reaches 62.4% at $26.73/1k versus best single 60.3% at $31.55/1k, while evidence-only reaches the same 62.4% at $26.69/1k. This is a published experiment, **not independently reproduced here**, and the gain cannot be credited to Jev. Its smaller 100-query/three-model pilot failed to beat the cheapest and most accurate fixed model. [Results and ablation](https://github.com/TokenTrim/jev-routing-experiment#llmrouterbench--beating-the-best-single-model-on-a-modern-flagship-pool), [pilot and caveats](https://github.com/TokenTrim/jev-routing-experiment#pilot-results--routing-100-cached-routerarena-queries), [evaluation integrity](https://github.com/TokenTrim/jev-routing-experiment#evaluation-integrity). |

## Patterns that transfer to Weave

1. **Pass a closed, eligible set.** Use the configured routed-unit pool, not a
   provider's `/models` listing, as the available selection surface. Apply
   deterministic constraints (inference kind, destination, context, budget,
   current availability) before a judgment site sees candidates. The TypeSafe
   demo validates returned IDs against its offered set; JevRouter preserves
   filtered candidates and policy reasons. [TypeSafe routing contract](https://github.com/TypeSafeAI/typesafe-router#what-it-does),
   [JevRouter decision response](https://github.com/BillionsBobby/JevRouter#decision-response).
2. **Keep “can meet the task” distinct from “prefer this one.”** A hard capability
   or quality floor should not be inferred from Jev's preference probability.
   After the can-do filter, rank surviving routed units using cost, latency,
   capacity, and observed accepted outcomes. The TokenTrim ablation suggests
   empirical per-model evidence can matter more than a Jev difficulty score.
   [Experiment](https://github.com/TokenTrim/jev-routing-experiment#llmrouterbench--beating-the-best-single-model-on-a-modern-flagship-pool).
3. **Record original judgment, applied policy, and final route separately.**
   The TypeSafe lab and JevRouter both expose this distinction. Weave should
   also record the requested inference kind, pool/policy revisions, exclusion
   reasons, selected routed unit, acceptance outcome, total attempts, and
   correction/rework. Selection alone is not success evidence.
   [TypeSafe logs](https://github.com/TypeSafeAI/typesafe-router#saved-state-logs-and-tuning),
   [JevRouter dashboard](https://github.com/BillionsBobby/JevRouter#local-dashboard).
4. **Treat reported confidence as a weight until locally calibrated.** Example
   projects use numerical thresholds to trigger fallback, but none of the
   inspected model-routing implementations establishes that a universal
   threshold predicts Weave task completion. Compare Jev, deterministic
   evidence-only ranking, and a fixed strong-route baseline on held-out Weave
   workload cases. Calibrate separately for the judgment site's question and
   candidate-set shape before naming a threshold “confidence.”
   [TypeSafe example threshold](https://github.com/TypeSafeAI/typesafe-router#routing-policies),
   [TokenTrim no-Jev ablation](https://github.com/TokenTrim/jev-routing-experiment#llmrouterbench--beating-the-best-single-model-on-a-modern-flagship-pool).
5. **Preserve an explicit conservative fallback.** On invalid, unavailable or
   weakly supported judgment, choose by configured policy (or abstain when no
   routed unit clears the quality bar), and say why. The proxy project keeps
   the current tier after failure; the TypeSafe demo falls back to a configured
   model. Those are product-specific examples, not universal safe defaults.
   [Proxy policy](https://github.com/gargpratyush/jev-router#routing-policy),
   [TypeSafe policy](https://github.com/TypeSafeAI/typesafe-router#routing-policies).

## Proposed evaluation before adoption

Start with a versioned, user-configured pool and representative task families.
Build an external evidence prior plus a small Weave-specific outcome set for
each family; do not require a complete benchmark suite per routed unit. Freeze
the cases, route descriptions, candidate pool and policy before comparing:

- fixed strong routed unit;
- current deterministic gateway order;
- evidence-only can-do filter and ranking;
- the same filter and ranking with a Jev judgment at a defined site.

Measure satisfactory completion, downstream correction/rework, total spend,
latency and fallback frequency. Report each workload separately, including
cases where no routed unit clears the quality bar. Promote Jev-assisted routing
only where it improves a protected outcome against the evidence-only baseline;
otherwise retain the simpler deterministic ranking. This is a recommendation
inferred from the source review, not a result demonstrated by those projects.

## Local architectural boundary

The current [`route()` implementation](../../packages/gateway/src/routing.ts)
already filters on operation, kind, destination, declared quality, context and
worst-case affordability before ordering by observed acceptance and cost; thin
evidence retains configured order. Its `accepted` count is a narrow gateway
outcome, not proof that a software task was completed without rework. The
research supports enriching that evidence and inserting any Jev judgment at a
specific bounded site. It does not support replacing the gateway's deterministic
policy with a raw Jev choice.
