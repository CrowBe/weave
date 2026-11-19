# Clairic launch: prompting guidance and task fit

Checked 2026-10-20. Historical primary-source scan; provider documentation may have changed. No model calls were made by this research task.

## Finding

The sources support trying a more specific extraction schema. They do not establish that more instructions turn Clairic into a planner. For producing fresh, scoped subprompts and dependencies, a generative model remains the better contract fit. The subagent smoke results are development observations, not a comparative accuracy or cost result.

## Published guidance

Cloudflare's [extraction-model design guide](https://developers.cloudflare.com/workers-ai/concepts/extraction-models/#design-extraction-tasks) recommends descriptive field names, instructions explaining the exact value sought, types and constraints appropriate to the application, and task-relevant information in the state. Its examples specify inclusions such as tax and shipping in an invoice total. It explicitly distinguishes extraction from open-ended generation. Missing scalar values return null, while a list can be empty. Type validity does not establish correctness, and uncertainty metadata does not replace application checks.

The [launch article](https://blog.cloudflare.com/clairic-extraction-model/#how-a-request-works) uses short instructions for separate named fields. Its list example extracts individual damage descriptions, while scalar fields separately recover identifiers, dates and amounts. Text answers are source spans. The example workflow extracts facts, chooses among known resolutions, then uses an LLM to write. The preview section warns that dependent computation is difficult in a single pass without a scratchpad; that is relevant caution, not direct evidence about task decomposition. The article provides no decomposition evaluation or validated recipe for preserving complex instruction clauses.

The [model reference](https://developers.cloudflare.com/workers-ai/models/clairic/) confirms `state` plus typed `fields`, including text and list values. Its documented examples do not demonstrate nested task objects, generated dependency graphs or rewritten subprompts. The [release changelog](https://developers.cloudflare.com/changelog/post/2026-10-19-clairic-workers-ai/) describes lists as matching values returned in source order, and confidence/null metadata as signals for review. Neither supplies a prompting benchmark for this workload.

## Candidate adjustment: inference, not an official recipe

Use independent questions rather than one broad request to decompose everything:

- `requested_actions`: list of source action clauses.
- `final_deliverable`: scalar text identifying the complete final-output clause.
- `evidence_requirement`: scalar text identifying required supporting evidence.
- `prohibited_actions`: list of complete prohibitions, retaining negation.
- `data_handling_constraints`: list of complete data-handling clauses.

This separates locating a clause from inventing a work plan. Scalar fields may recover complete clauses that list extraction fragments. It remains a hypothesis; adding many fields can also add ambiguity and schema cost. General few-shot or chain-of-thought advice from text-generation documentation should not be presented as tested Clairic guidance.

## Follow-up observation supplied by the parent task

The parent ran that narrower schema against the unchanged development input. It recovered all three full action spans and the quotation requirement as a scalar. However, `prohibited_actions` returned `do not publish externally`, `Do`, and `modify either document`: the document-modification prohibition still lost its negation. The request and response are retained in [prompt-decomposition-field-probe](prompt-decomposition-field-probe/). This shows meaningful schema sensitivity and an unresolved completeness problem on one already-inspected case. It is not held-out evidence or a general model ranking.

## Surrounding discussion coverage

Searches targeted Cloudflare's X account, Clairic on X generally, and the credited authors Alex Reneau, Michelle Chen and Kevin Flansburg. No indexed primary X post with additional prompting guidance was retrieved. Author pages confirmed the launch credit but did not expose relevant discussion. The article mentions a live demo, but the accessible text did not provide a retrievable demo/source link. This is a retrieval limitation; it does not establish that posts, replies or a demo do not exist.

## Recommendation

Evaluate a generative decomposition baseline and retain Clairic as a candidate for bounded fact/span extraction. Before adopting either, evaluate independently adjudicated unseen requests, especially negation, exceptions, shared constraints, distractors, indirect references and tasks that should stay whole. Measure accepted plans and downstream success, then cost and latency. Clairic could earn a role extracting dates, identifiers, amounts and source evidence from documents even if it never earns the planning role. Do not let its extracted constraints replace the authoritative request or deterministic policy.
