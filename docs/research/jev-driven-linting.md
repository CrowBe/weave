# Jev driven linting for Weave

Investigated 2026-10-20; repository comparison refreshed against `4e9ebaf` on 2026-10-27. This is source research and a proposed experiment, not a deployed lint step or a measured result on Weave. No dependencies, hooks, CI settings, or model routes were changed; no repository source was submitted for hosted inference.

## Recommendation

Use natural-language rules as reference material now, and consider a small **advisory semantic review** experiment next. Keep exact architectural and style requirements in deterministic checks wherever possible. Jev can supply structured observations about a bounded code subject; it cannot establish that the whole architecture complies, explain an arbitrary defect in prose, or prove that development happened test first.

Of the inspected tools, **mizchi/jev-lint** is the best starting reference for a Weave experiment: local structural selection, project rules, diff review, machine-readable findings, and recorded evaluation. This is a recommendation from the public contracts and Weave's boundaries, not a quality comparison run here.

## What exists

| Source                                                                                                        | Verified role                                                                               | Relevance                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Official TypeSafe skill](https://github.com/typesafe-ai/skills)                                              | Guidance for agents building integrations with TypeSafe's typed decision API.               | Reference context for integration work; it does not install a natural-language linter.                                                           |
| [mizchi/jev-lint](https://github.com/mizchi/jev-lint/tree/af58a3bd20693f828ff6353e3543c0ab5bb7bad4)           | Independent MIT CLI: ast-grep selects subjects and Jev evaluates project-written sentences. | Strongest fit for a deliberate advisory lint experiment.                                                                                         |
| [ckorhonen/jev-lint](https://github.com/ckorhonen/jev-lint/tree/ebefe17bde12842c5ad7bbfffc07ae92b8146feb)     | Independent agent-edit hook with repository rules and logs.                                 | Earlier feedback inside an agent session; broader automatic source disclosure and integration surface. Its README says errors let edits proceed. |
| [codegirl-007/jevlint](https://github.com/codegirl-007/jevlint/tree/86a3e9b4d998efaaa47a9177974b42ef5cd92bf5) | Independent Go CLI: Tree-sitter extracts code units; plain-language rules yield findings.   | Alternative with JSON output, changed-file checks, fixture evaluation and caching. Building requires Go, CGO and a C compiler.                   |

The three community tools are separate projects, despite the similar names. Neither a community repository nor its own performance report establishes official TypeSafe endorsement or Weave suitability. The [official coding-agent guide](https://docs.typesafe.ai/introduction/coding-agents) describes Jev as a typed decision component, rather than a coding agent or code generator.

The inspected mizchi default branch resolved to `af58a3bd20693f828ff6353e3543c0ab5bb7bad4`, package version `0.7.1`. Its [package metadata](https://github.com/mizchi/jev-lint/blob/af58a3bd20693f828ff6353e3543c0ab5bb7bad4/package.json) requires **Node >=24**, and depends on ast-grep's CLI and YAML. Weave currently declares Node >=22 and its [verification workflow](../../.github/workflows/verify.yml) uses Node 22, so adopting that inspected version needs an explicit tooling/runtime choice. Research did not install it.

## What “natural-language lint” actually means

The useful contract is a structural selector plus a narrow semantic assertion, not a broad instruction such as “follow our architecture.” A selector identifies a function, catch block, test or change; the assertion defines the property to judge. Scope and exceptions must be visible in the supplied evidence. The [rule-writing guide](https://github.com/mizchi/jev-lint/blob/af58a3bd20693f828ff6353e3543c0ab5bb7bad4/docs/writing-rules.md) describes `rule`, `subject` and `state` separately, with `paired` state adding related test excerpts. It also requires fixture expectations outside the source shown to the model.

The [question builder](https://github.com/mizchi/jev-lint/blob/af58a3bd20693f828ff6353e3543c0ab5bb7bad4/src/questions.ts) supports two verdict shapes:

- `noul`: an independent yes/no proposition returning a probability.
- `score`: an ordered rubric returning a score and distribution-derived confidence.

The builder keeps thresholds outside the model question. Optional `explain` labels produce a subsequent `choice` about why a reported finding holds. That selects from authored reasons; it does not generate a new diagnosis, patch or line-number claim.

The official [Noul contract](https://docs.typesafe.ai/primitives/noul) uses `state`, `model` and named `questions`; each question has `type: "noul"`, `instructions` and optional nested `criteria: { true, false }`. Answers return under the original question IDs with `type` and `noul`. A Noul has no separate confidence field. The [confidence documentation](https://docs.typesafe.ai/confidence) describes Choice/Score confidence as a statistic of the returned distribution and recommends validating thresholds on target-domain data. These are model signals, not proof of a correct judgment.

## Structured output that an agent can act on

The [argument parser](https://github.com/mizchi/jev-lint/blob/af58a3bd20693f828ff6353e3543c0ab5bb7bad4/src/cli/args.ts) accepts both `--format json` and its `--json` alias. The [JSON formatter source](https://github.com/mizchi/jev-lint/blob/af58a3bd20693f828ff6353e3543c0ab5bb7bad4/src/report.ts) emits:

| Level   | Fields useful to a consumer                                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report  | `findings`, `review`, `stats`, `degraded`, `silentRules`, `idleLanguages`, `ignored`, `unpaired`, `retry`, `spent`, `errors`, `elapsedMs`                                                                |
| Finding | `rule`, `severity`, `messageId`, `file`, `line`, `endLine`, `value`, `confidence`, `explanation`, `cutoff`, `margin`, `kind`, `level`, `arm`, `passes`, `message`, `commit`, `change`, `cut`, `violates` |

Some optional properties are omitted by JSON serialization when undefined; explicitly nullable properties remain null. `value` must be interpreted with `kind`: a score is not a violation probability. `passes` can record how many repeated evaluations exceeded the cutoff and their spread. `cut` records partial text coverage; `degraded` records loss of requested state. A consumer must inspect coverage and errors alongside findings.

The documented [CLI reference](https://github.com/mizchi/jev-lint/blob/af58a3bd20693f828ff6353e3543c0ab5bb7bad4/docs/reference.md) provides `review --base <ref>` for changed subjects, `--dry-run --show-subjects` for local planning, `--record` for replayable runs, and `replay` for rescoring without new inference. `--loose` lists candidates below the finding threshold separately. `commits --staged` and change subjects compare a change with repository instructions. Those are useful entry points for investigation; none was executed in this research.

## Where it fits in this repository

The terms and boundaries below come from [VISION.md](../../VISION.md), [GLOSSARY.md](../../GLOSSARY.md), current source and tests. No domain term or acceptance boundary needs to change for a development-only investigation.

| Existing requirement or candidate question                                | Best treatment                                                                                                                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime, AgentFabric and gateway import direction                         | Keep [checks/import-direction.mjs](../../checks/import-direction.mjs). Exact import relationships are deterministic.                                      |
| Runtime wall-clock access                                                 | Keep [checks/no-ambient-clock.mjs](../../checks/no-ambient-clock.mjs). Semantic review adds no authority to waive it.                                     |
| Formatting, exact naming spellings, forbidden syntax                      | Prefer compiler/static-linter/parser rules. Natural language can author the preference; routine enforcement need not call a model.                        |
| A function's name understates a visible side effect                       | Good bounded pilot candidate when the subject includes the body and relevant dependencies.                                                                |
| A test's assertions do not establish its named behavior                   | Good bounded pilot candidate; independently mutation-test the claim where feasible.                                                                       |
| Model output appears to bypass deterministic policy or an execution grant | Valuable review question, but only when the subject includes the authorization path and callers. A function-local excerpt may hide the decisive evidence. |
| AgentFabric must not acquire scheduling responsibility                    | Use import checks for structural violations; semantic responsibility drift may require cross-file review with an explicit evidence bundle.                |
| Red was demonstrated before implementation                                | Requires a run/event record bound to the revision. A final diff cannot prove event ordering.                                                              |

The root [package.json](../../package.json) currently runs the architectural checks through `npm run check` and includes them in `npm run verify`; it also exposes `npm run lint` and `npm run fmt` through Vite Plus. These are deterministic tools; the exact scripts may evolve. The [gateway evaluation contract](../../packages/gateway/src/types.ts) already supports named boolean, choice and score questions over one state. All questions in a request share one inference kind. Its [TypeSafe adapter](../../packages/gateway/src/adapters/typesafe-ai.ts) calls `https://api.typesafe.ai/v1/systemone`; [adapter tests](../../packages/gateway/test/typesafe-ai.test.ts) cover protocol and failure handling offline.

A future custom development consumer could reuse the gateway without putting linting inside the runtime or AgentFabric. This would be a development leaf under `checks/` or separate development tooling, not another runtime judgment site or a new core primitive. Reference context and a checker should use the same versioned rule specification, anchored to canonical VISION/GLOSSARY/AGENTS requirements so it cannot become a competing authority. Prose helps the implementer; model answers remain observations. Importing a linter or designing new runtime abstractions now would precede evidence of benefit. Studying the existing CLI and evaluating a narrow rule set is the smaller coherent next step.

## Evidence, limitations and cost

The upstream [deep dive](https://github.com/mizchi/jev-lint/blob/af58a3bd20693f828ff6353e3543c0ab5bb7bad4/docs/deepdive.md) distinguishes its own fixture fit from generalization. It documents contaminated source labels, hard clean cases, and retracted interpretations. Its “about one finding in five wrong” example was one round with 9 of 11 findings judged useful by the tool author on the author's own code. It is a reason to review findings, not a measured expected false-positive rate for Weave. Its batching experiments also show that changing state/grouping can change results; thresholds belong to the evaluated question and context configuration.

TypeSafe's [model table](https://docs.typesafe.ai/models), checked on 2026-10-20, then listed `jev-1.14.0` as the newest release, available October 14, and listed `jev-1.13.0` as well. The listed price then was **$0.042 per million input tokens**, with free output tokens; the listed limits were 64k tokens per request and 32k per question, with shared state counted toward both. These are historical values, not current pricing or limits. For scale only, 100,000 billed input tokens at the historical listed rate costs $0.0042; this is arithmetic, not a measured Weave run or total workflow cost. Repeats, explanation passes, retries and the coding agent's repairs add work and cost.

The official [jev-1.13 jaggedness guide](https://docs.typesafe.ai/model-jaggedness/jev-1.13) warns about literal reading, multihop indirection, irrelevant context, option-order effects and adversarial content in state. It recommends code for exact arithmetic and counting. This document explicitly concerns 1.13; no equivalent 1.14 performance conclusion follows here. Natural-language architecture preferences often require exactly the missing caller and cross-module context that makes a local question unreliable.

The [hook guide](https://github.com/mizchi/jev-lint/blob/af58a3bd20693f828ff6353e3543c0ab5bb7bad4/docs/use-hooks.md) deliberately ships nonblocking severities and lets its installed hooks proceed after request failures. The CLI distinguishes request failures with exit 3. An advisory Weave report must retain “unavailable/incomplete” instead of converting a failed service call into a clean result. Suppression, skipped subjects, a matcher that matched nothing, truncated input and context degradation likewise affect coverage. Installing a hook is a separate integration choice from keeping the rule catalogue as reference context.

## Proposed bounded pilot — not run

1. **Write the rule contract first.** Select three questions: visible hidden side effects, test-claim mismatch, and a carefully scoped authority-bypass signal. Each rule records purpose, applicable subjects, required evidence, exclusions, examples and a stable ID. Broad architecture questions that cannot fit the evidence contract stay in human/agent review.
2. **Reserve evidence before fitting.** Independently label representative Weave cases, hard valid counterexamples, missing-context cases, malicious source comments and stale check evidence. Keep calibration and protected evaluation separate; implementer-authored cases cannot be the sole evidence. Record provenance, license and the intended external destination before sending any benchmark-derived text.
3. **Demonstrate selection and detection.** Use local dry runs to establish matcher coverage. Before implementing integration code, show red with a known invalid subject or behavioral check. Separately measure whether the model detects independently labeled defects; a passing mock cannot establish that.
4. **Compare the actual choices.** Evaluate agent reference context alone, reference context plus advisory semantic findings, and applicable deterministic checks on the same frozen cases. If comparing routed units, hold subject, rule text and policy fixed. Measure per-rule precision/recall with counts, abstention/coverage, repeated-run flips, reviewer acceptance, total latency and cost.
5. **Preserve evidence identity.** Bind reports to source revision, rule revision, selected subject and state hashes, model version, settings and raw answers. A cached judgment about old code cannot establish a current result. An unjudged or degraded case must stay distinguishable from a pass.
6. **Start as an optional report.** Findings become review candidates for an operator or coding agent. They issue no execution grant, apply no patch and waive no deterministic check. Promote a rule to any blocking role only after independent evidence supports that exact scope and its failure policy is explicit.

[Issue #206](https://github.com/CrowBe/weave/issues/206) tracks an advisory pilot. A possible outcome is a small, reviewable preference catalogue with executable static checks for exact properties and optional semantic questions for the remainder. The research establishes tooling feasibility and a concrete experiment shape; it does not establish Jev's effectiveness on Weave yet.
