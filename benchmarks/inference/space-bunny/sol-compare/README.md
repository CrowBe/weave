# Space Bunny Alpha versus GPT-6 Sol: text-only quality probe

Status: historical exploratory results. The runner is retired because Space
Bunny is no longer in the free-model allowlist. Cases and results are preserved;
the runner source remains in git history.

This compares answer quality on self-contained synthetic
questions, not latency, cost, tool use, creative writing, long context, or a
general intelligence score. The original 20-question Space Bunny set was not
reused: its answers had already appeared in this Codex conversation.

## Method

The first [`40 cases`](cases.json) have ten quantitative, logic, code-reading,
and evidence-reading questions each. A second, harder [`20 cases`](hard-cases.json)
has five per category. Their answer keys were frozen before inference. Arithmetic,
constraint, and code-output keys were independently checked with local scripts
or language runtimes. All content is newly authored synthetic material.

The retired `run.mjs` grouped one case from each category into each four-question
batch. Both models received the identical question prompt and had to return a
JSON object of short answers. The prompt forbade tools, files, and browsing;
the Codex event logs confirmed no tool calls. Space Bunny ran through the real Nous Portal adapter with
temperature 0 and an 8,192-token output cap. The runner checked its exact
model ID for zero input and output pricing before calling it and never
substituted a paid model. Rate-limit refusals could be retried after their
specified delay; neither finished run had a failed batch.

GPT-6 Sol ran as `gpt-6-sol` in ten plus five fresh, ephemeral, read-only Codex
CLI 0.157.0 sessions at medium reasoning effort, from an empty temporary
working directory. The CLI event logs showed zero tool calls. This measures
GPT-6 Sol **inside the Codex harness**, not a bare Responses API request; this
machine has no OpenAI API key configured. No latency comparison is made.

Raw prompts, answers, batch responses, status, and scoring are saved in
[`results.json`](results.json) and [`hard-results.json`](hard-results.json).
The cases remain inspectable; the historical scoring code is in git history.

| Category | Space Bunny | GPT-6 Sol |
| --- | ---: | ---: |
| Quantitative | 14/15 | 15/15 |
| Logic | 13/15 | 15/15 |
| Code understanding | 14/15 | 15/15 |
| Evidence reading | 15/15 | 15/15 |
| **Total** | **56/60** | **60/60** |

The initial 40 cases scored 37/40 and 40/40; the harder 20 scored 19/20 and
20/20. Every batch from both models contained parseable JSON with every
requested case ID. On this sample Space Bunny handled short evidence reading
perfectly and most arithmetic, logic, and code traces correctly. Its four
misses were:

| Case | Expected | Space Bunny | Failure |
| --- | --- | --- | --- |
| `code.alias` | `[[1, 3], [2]]` | `[1, 3]` | Lost the outer-list structure after a shallow copy. |
| `math.tank` | `17/40` | `1/2` | Miscombined three fractions. |
| `logic.switches` | `KM` | `LM` | Selected M without its required K. |
| `hard.logic.knights` | `B` | `none` | Missed the consistent truth-teller assignment. |

This is a small, self-authored, mostly short-answer sample. Sol's perfect
result creates a ceiling; four paired disagreements do not establish a stable
gap of 6.7 percentage points. The questions do not test extended coding,
fact retrieval, long-document work, nuanced writing, or tool-using agents.
Space Bunny's anonymous-preview identity also leaves training overlap unknown.
The observed strengths and errors are useful for choosing the next, more
realistic tasks, not for ranking the models broadly.
