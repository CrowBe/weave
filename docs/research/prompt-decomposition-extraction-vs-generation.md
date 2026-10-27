# Prompt decomposition: extraction versus generation

Research and exploration date: 2026-10-20. This note combines a source review and four live development probes. It is not a held-out model benchmark. No Gemma, Qwen, or frontier inference was run during this investigation.

## Recommendation

Start with one compact generative decomposition request and deterministic structural checks as the baseline. Evaluate a small local model and an inexpensive hosted model on the same independently adjudicated workload; use a strong hosted model as a reference route, not as ground truth. Clairic may earn a supporting role for source spans, requirement coverage, or context selection. Its current text/list extraction shape does not directly produce new subprompts or inferred dependency graphs.

Explicit request factoring and implied-work planning are separate evaluation families. Include a valid outcome that keeps a task whole, and clarification when evidence is insufficient. More context should mean relevant evidence plus clear source roles, not an arbitrary longer transcript. Models can omit clauses, confuse archived instructions with current ones, or invent authority. All inferred bindings remain observations. Known hard constraints remain enforced by deterministic runtime policy independently of the extracted plan.

## Live Clairic sensitivity observations

Source: [frozen inputs, raw outputs, hashes and checks](prompt-decomposition-probe/sensitivity-assessment.json) under `prompt-decomposition-probe/`; each variant has `.request.json` and `.response.json` records. [Provenance and limits](prompt-decomposition-probe/sensitivity-provenance.md). All inputs are synthetic, self-authored, and permitted for sending to Cloudflare Workers AI @cf/cloudflare/clairic. Field instructions and context were frozen before these four calls. The added context explains extraction purpose and downstream constraint inheritance; it does not add missing task facts. The prior case was already examined, so these are development probes rather than held-out evidence. Hosted checkpoint revision/cache status was not exposed or pinned.

| Variant              | Components | Quotation condition intact | No-modification condition intact | CLI wall seconds |
| -------------------- | ---------- | -------------------------- | -------------------------------- | ---------------- |
| baseline-repeat      | 3          | False                      | False                            | 0.82             |
| instructions         | 3          | False                      | False                            | 1.43             |
| context              | 3          | False                      | True                             | 0.8              |
| instructions-context | 4          | True                       | False                            | 1.02             |

The saved baseline repeat contains the same failure pattern noted in the earlier observation; the earlier raw response is not included in this bundle. Instructions alone fragmented “Compare” away from its object and omitted conflict identification. Added purpose context retained the complete no-modification constraint but still truncated the recommendation. Both changes retained the quotation phrase but split the first action into two list items and reduced the prohibition to “Do”. Every returned offset matched the input; source-span validity did not establish completeness or correctness. None produced all three complete components and the required constraints. Raw confidence is not independently calibrated for this task. Calls ran concurrently; these are single CLI wall times including network/auth/CLI overhead, not model-only latency, distributions, or evidence that one prompt variant is faster.

## Cost and latency

For a sequential first-refusal route, expected cost is C_fast + q*C_strong when q is the fallback probability, assuming one fast attempt and at most one strong attempt. Expected latency is T_fast + q*T_strong under the same simplified assumptions. These are arithmetic models, not measured results. Compare actual total cost and latency per accepted plan, including failures, repair, and downstream work; source-span extraction is not an equivalent output to a generated plan.

## Proposed evaluation

Keep separate development and protected cases before tuning. Obtain independent human/adjudicated examples from real permitted workloads plus adversarial cases; self-authored synthetic examples are not sufficient quality evidence. Use the same disclosed inputs and output contract across generative routes. Measure atomic requirement/constraint recall, spurious tasks, useful granularity, dependency and referent correctness, applicable shared context, abstention/clarification, and downstream completed outcomes with correction counts. Group by explicit versus implicit decomposition and by context length/noise. Report cold/warm full-plan p50/p95 latency and total cost per accepted plan, including repair/fallback, output tokens and downstream duplicated context. Use deterministic structural checks, independent semantic adjudication, and targeted end-to-end outcome checks. A strong model is a comparison route and may also fail.

## Fit to Weave at 2026-10-27

The [Vision](../../VISION.md) treats model output as evidence, not authority. The [glossary](../../GLOSSARY.md) defines a criterion proof as a proposal from decomposition; deterministic code admits a `check` proof only under its stated resource and grant conditions. The implementation in [criterion-proof.ts](../../packages/weave/src/criterion-proof.ts) applies those conditions. These probes do not test that implementation, establish semantic completeness, or authorize a plan. Their value is the concrete counterexample: a valid span can omit a negation that matters to the original request.

The dated candidate models and prices from the original note were not evaluated and are omitted here; check current provider documentation before designing a new comparison.
