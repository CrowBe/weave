# Four-model subagent decomposition smoke test

Date: 2026-10-20. One [shared small prompt](prompt-decomposition-subagent-probe/prompt.txt), fresh subagents, low reasoning effort, no tools or parent history. Requested model IDs at the time: Astra `gpt-6-astra`, Sol `gpt-6.1-sol`, Terra `gpt-5.6-terra`, Luna `gpt-6-luna`. [Official model documentation](https://learn.chatgpt.com/docs/models#recommended-models).

All four returned valid JSON with two work items: comparison/conflict identification, followed by the quotation-supported recommendation. They retained local-only handling and no document modification, excluded the archived translation example, and supplied valid dependencies. The 2026-10-27 reassessment found that Luna narrowed the no-publication prohibition to publishing the document contents; it did not clearly preserve the broader prohibition in the request. This is a development observation, not an accuracy estimate.

| Requested model | Items | Complete requirements      | Distinction                                                                     |
| --------------- | ----- | -------------------------- | ------------------------------------------------------------------------------- |
| gpt-6-astra     | 2     | Preserved                  | Adds supporting quotations to comparison; recommendation based on comparison    |
| gpt-6.1-sol     | 2     | Preserved                  | Explicit inspection/comparison and quotation gathering                          |
| gpt-5.6-terra   | 2     | Preserved                  | Adds quotation requirement and archived-work exclusion to global constraints    |
| gpt-6-luna      | 2     | Publication scope narrowed | Combines local-only and no-publication, but applies the latter to the documents |

The two-item structure is a reasonable merge of comparison and conflict identification; requiring three items would penalize a useful decomposition. Astra/Sol attach quotation gathering to comparison, a sensible supporting inference rather than a separate new deliverable. Terra's comparison is expressed through identifying statements that conflict with each other. The 2026-10-20 parent assessment accepted all four; the later reassessment above corrects the publication-scope finding.

The earlier Clairic extraction runs lost requirements on this same underlying case; these subagents used a different generative output contract and richer instructions. This is evidence of feasibility, not a controlled estimate of model superiority. The subagent harness adds context and overhead, so its behavior and timing are not directly equivalent to raw API inference.

No token/billing or per-model inference timing was exposed; no speed/cost ranking is claimed. One observation per model cannot distinguish stable accuracy or tail latency. No model ranking or production choice follows from this case; use independently adjudicated held-out evaluation.

[Assessment and requested model settings](prompt-decomposition-subagent-probe/assessment.json) · [Provenance and limitations](prompt-decomposition-subagent-probe/provenance.md) · [Astra output](prompt-decomposition-subagent-probe/astra.raw.txt) · [Sol output](prompt-decomposition-subagent-probe/sol.raw.txt) · [Terra output](prompt-decomposition-subagent-probe/terra.raw.txt) · [Luna output](prompt-decomposition-subagent-probe/luna.raw.txt)
