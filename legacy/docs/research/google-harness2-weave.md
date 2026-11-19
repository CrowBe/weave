# Google Harness² and Weave

Research date: 2026-10-19; repository comparison refreshed against `4e9ebaf` on 2026-10-27. Source and test inspection only; no runtime change or benchmark run. The paper is pinned to v1; repository guide links are mutable and were rechecked on 2026-10-27.

## Assessment

The useful contribution is a concrete candidate-generation and evidence-gathering procedure for Weave's existing optimisation lifecycle. It strengthens the case for improving operating strategies around frozen models. It does not require changing Weave's runtime identity or authority model.

Weave already defines bounded experiments, versioned baselines, protected constraints, promotion, and rollback in [VISION.md](../../VISION.md) and [GLOSSARY.md](../../GLOSSARY.md). [M5](../m5-improve-an-operating-strategy.md) implements a deliberately narrower proof: comparing framing profiles with deterministic fixture measurements. [strategy.ts](../../packages/weave/src/strategy.ts) checks required operations, quality, human corrections, improvement, and protocol amendments; [m5.test.ts](../../packages/weave/test/m5.test.ts) exercises promotion refusal, rollback, replay, and rejected core patches. Those are source/test inspections, not a fresh test run. Real candidate discovery and empirical improvement across workloads remain a further step.

## What is worth borrowing

Harness² proposes two edits with different scopes: recurring process problems and domain-specific problems. It executes candidates on the same task under matched model/environment configurations, then selectively composes supported edits and executes the composition. Contrasts are evidence about behavior, not correctness. Its library stores executable harnesses alongside an `EXPERIENCE.md` describing applicability and evidence; later tasks start from the common baseline and selectively reuse earlier components. The improvement instructions and decision rule stay fixed while the library evolves. [Paper §§2.2–2.3](https://arxiv.org/html/2610.14224v1#S2.SS2).

For Weave, the source supplies external evidence about scoped hypotheses, matched trials, composition and evidence-linked reuse. The existing [M5 contract](../m5-improve-an-operating-strategy.md) remains the authority for its narrower comparison; this note does not define a further acceptance boundary or claim general optimiser behavior.

## Evidence and limits

The paper reports up to 11.5 points on WorkBuddy-Bench, 4.5 on JobBench, and 11.8 percentage points on LAB Partial pass rate for one improvement step across four executor/harness combinations. It supplies parallel/sequential modes and a credential-free deterministic local demo. Its eight editable surfaces include guardrails, scripts, and middleware. The repository is Apache-2.0, with separate upstream dataset/dependency licenses, and identifies itself as research rather than an officially supported Google product. [Official README](https://github.com/google-research/harness2#readme).

The paper's ablation removes the library, scoped proposals, or composition and loses performance. It also documents harmful selection and shared false premises. More recursion adds inference expense; fewer executor steps are not lower total cost. Model judgments do not establish correctness or transfer, and library consolidation plus adaptive stopping remain future work. [Paper §4 and Appendices E.6–G](https://arxiv.org/html/2610.14224v1#S4).

The experiment guide, observed on 2026-10-27, specifies `k` references and, in parallel mode, `2k` candidate probes plus `k` composed executions. Thus even `k=1` entails four executor runs, before editor/reflection costs. It separates libraries by configuration and seed, preserves earlier-task ordering within domains, and notes that the seed controls task ordering rather than model sampling. [Experiment guide](https://github.com/google-research/harness2/blob/main/docs/EXPERIMENTS.md).

## Guardrails for a Weave experiment

The same guide reports an important reproduction risk: a validation Codex rollout independently downloaded its public JobBench rubric. Released executors have unrestricted networking and Codex's sandbox disabled; external network restrictions are recommended. This does **not** establish that the paper's reported runs were contaminated. It means clean reproduction needs demonstrable separation from answers and graders. [Experiment guide, Web access](https://github.com/google-research/harness2/blob/main/docs/EXPERIMENTS.md#web-access).

Start with one framing-profile experiment, not arbitrary harness mutation. Freeze independent protected cases and the quality bar before proposal/results; isolate effects and grader access; record total executor, editor, evaluation, failed-trial, and review costs. Establish provenance, licenses, exact hosted destinations, and permitted disclosure before sending task data externally. Keep deterministic permissions, AgentFabric admission, execution grants, and control-core releases outside candidate authority. Preserve a baseline when evidence is inconclusive. These boundaries follow [Weave's vision](../../VISION.md), [M5](../m5-improve-an-operating-strategy.md), and the repository's agent instructions.
