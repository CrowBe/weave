# Deterministic-first verification (WV-197)

Status: design note over existing contracts and behavior at `859d85e` (which
includes the requested `f47f855` baseline). This change adds no execution path,
policy, threshold, provider or package. It uses existing glossary terms and
does not change the acceptance boundary in `VISION.md`.

## Contract

**Each property is checked at the lowest layer that can establish it.
Judgment sites and the audit tier judge only the remainder.** Intelligence
proposes decomposition and routing; deterministic policy admits the proposals
and decides what their evidence permits.

For each property, before work starts:

1. Name the property, its artifact or command evidence, and the escape when
   that evidence cannot establish it. Keep separately provable properties
   separate. An acceptance line already has these fields
   ([task-acceptance.ts:177](../packages/weave/src/task-acceptance.ts#L177)).
2. Use structure first: contracts, closed types, permissions and enforced
   effects. Where structure cannot establish the property, use an existing
   deterministic check or acceptance predicate. Keep a judgment question for
   the semantic remainder. A replacement must establish the **same property**
   on the **same artifact revision**, within the declared scope.
3. Admit the evidence source independently of generation. A proposed criterion
   proof is an observation, not permission to omit D5. Code admits `check`
   only with bound checks, readable oracles, known generation write scope and
   host canonical identity proving that generation cannot write those oracles
   ([criterion-proof.ts:60](../packages/weave/src/criterion-proof.ts#L60)).
4. Record the result and its dependencies before consuming it. Missing evidence,
   unfinished checks, cancelled attempts and stale or conflicting bindings
   cannot establish completion. A completed observation supports only its own
   property and revision. A model cannot vote a required red check green.
   Checks settle only the properties their contracts establish; an audit can
   still discover a gap in those contracts or in their coverage.

This is a rule for assigning properties, not an instruction to execute every
layer in a serial pipeline. Independent observations can proceed concurrently
under existing effect locks; a dependent judgment waits for the checks whose
results can already settle its question. Admission, promotion and authority to
execute remain separate gates.

## Existing owners and the judgment that remains

| Property | Lowest existing layer and evidence | Remaining judgment |
| --- | --- | --- |
| Package dependency direction and absence of ambient clock, entropy or environment reads | Repository checks reject these source patterns in CI ([import-direction.mjs:40](../checks/import-direction.mjs#L40), [no-ambient-clock.mjs:16](../checks/no-ambient-clock.mjs#L16), [no-ambient-entropy.mjs:23](../checks/no-ambient-entropy.mjs#L23), [no-ambient-env.mjs:28](../checks/no-ambient-env.mjs#L28)). | Review can find properties the scanners do not cover; it need not decide again whether a covered source pattern is present. |
| Invocation is within its grant and has no conflicting effects | Fabric consumes a single-use grant and reserves canonical effects before execution ([host.ts:1852](../packages/agentfabric/src/host.ts#L1852), [coordinator.ts:20](../packages/agentfabric/src/coordinator.ts#L20)). | D4/D7 can identify semantic risks in disclosed input/output. Their answers cannot widen a grant or release a reservation. |
| A command has the declared exit status; named evidence contains an exact literal | The closed acceptance predicates decide from recorded command exit/output or artifact body. Missing evidence escapes; malformed predicates reject ([task-acceptance.ts:686](../packages/weave/src/task-acceptance.ts#L686), [task-acceptance.ts:762](../packages/weave/src/task-acceptance.ts#L762)). | `task.criteria` and `task.validate` ask only free-text facts. An all-predicate task makes neither call ([task-acceptance.ts:774](../packages/weave/src/task-acceptance.ts#L774)). |
| Recorded commands violate a declared task constraint | Code compares argv and the task's declaration, before deciding validation ([task-acceptance.ts:845](../packages/weave/src/task-acceptance.ts#L845)). This bounded recognition does not replace Fabric's effect enforcement. | Other facts may need task validation; the write-up is never evidence that overrides a constraint. |
| An implementation satisfies a check-proven success criterion | Host-configured `repo.test`, `repo.lint` or `repo.build`, with admitted criterion proof and every bound run green ([host.ts:1987](../packages/agentfabric/src/host.ts#L1987), [implement-step.ts:993](../packages/weave/src/implement-step.ts#L993)). | D5 asks only the `judgment` criteria, and asks none after any configured check is red. The attempt records `eval_skipped: 'check_failed'`, without inventing an eval ([implement-step.ts:1004](../packages/weave/src/implement-step.ts#L1004)). |
| Evidence establishes progress between consecutive tidy states | The progress delta decides unchanged evidence as `stalled`, only gains as `progressing`, and only losses as `regressing` ([progress.ts:64](../packages/weave/src/progress.ts#L64), [progress.ts:88](../packages/weave/src/progress.ts#L88)). | The first round, added/removed criterion ids and other undecided deltas ask D8. Both paths feed the existing stop rule and record which decided ([progress.ts:150](../packages/weave/src/progress.ts#L150)). |
| Current success evidence permits completion | Code requires green checks, criterion bindings, current evidence, and a current confident D5 pass only for judgment criteria. A current failing eval vetoes even beside a pass ([audit-loop.ts:181](../packages/weave/src/audit-loop.ts#L181)). | Strong audit discovers gaps, defects, regressions and scope creep; D6 disposes its findings. `fix_now` or `needs_human` still prevents completion ([audit-loop.ts:425](../packages/weave/src/audit-loop.ts#L425)). |
| A judgment finding recurs often enough to propose a check capability | A declared recurrence policy counts distinct executions, using kind, criterion and stable check-relevant evidence, without counting retries twice ([RECURRING-FINDINGS-CONTRACT.md:6](../packages/weave/src/RECURRING-FINDINGS-CONTRACT.md#L6)). | Semantic equivalence of opaque evidence references remains the caller's responsibility. The gap goes through ordinary crystallization; recording it generates, admits and executes nothing. |

For example, “README contains `--dry-run`” is an exact-literal predicate.
“README explains the effects of `--dry-run`” remains a free-text fact. A green
exit status proves the command exited successfully; it establishes the broader
criterion only when that check's independently governed oracle actually covers
it. Generated tests inside generation's writable workspace do not earn `check`
proof merely because they exit zero. The mixed-criterion fixtures keep D5 on
the remainder ([p8.test.ts:1319](../packages/weave/test/p8.test.ts#L1319)).
The criterion bindings and fixed host commands supply the existing map from a
property to its verifier; generation does not author a new verifier per run.
Correctness evidence does not establish performance or code quality without
separately declared measures and checks for those properties.

The implementations above cover #199–#202 and the record-only slice of #203.
#198 has a recorded decision to retain the confidence requirement, rather than
a new provider or a probability-only completion path. The repository's recorded
live run found no per-question confidence; a live-shaped D5 answer therefore
fails as `missing_confidence`. Its probability cannot substitute for confidence
([sites/CONTRACT.md:415](../packages/weave/src/sites/CONTRACT.md#L415),
[live-confidence.test.ts:68](../packages/weave/test/live-confidence.test.ts#L68)).

## Evidence belongs to the artifact being verified

Check argv is host configuration, never generated input. P8 retains argv digest,
exit, bounded output, artifact references and host invocation identity
([implement-step.ts:190](../packages/weave/src/implement-step.ts#L190)). A new
generation run has a fresh injected run identity, even when its returned text is
identical: workspace edits may differ. Checks execute again instead of replaying
the earlier green result ([implement-step.ts:955](../packages/weave/src/implement-step.ts#L955),
[p8.test.ts:762](../packages/weave/test/p8.test.ts#L762)).

The observation owner must project the admitted proof and actual check/eval
evidence into tidy state, retaining its producing audit iteration. A retry
attempt number is not an audit iteration. Retained or untagged green checks
cannot settle a check-proven criterion in a later iteration
([AUDIT-CONTRACT.md:47](../packages/weave/src/AUDIT-CONTRACT.md#L47)). Completion
also vetoes **any** red check disclosed in the current view; do not silently
discard contrary results to manufacture a green view
([audit-loop.ts:195](../packages/weave/src/audit-loop.ts#L195)).

Audit reuse requires both the tidy-state digest and captured revision to match;
live revision guards run before D6 and completion. A content change invalidates
the old verdict's applicability
([audit-loop.ts:270](../packages/weave/src/audit-loop.ts#L270),
[audit-loop.ts:402](../packages/weave/src/audit-loop.ts#L402)). This is not an
automatic Git-commit attestation: the observer supplies artifact digests,
iterations and revisions. The composition root must bind them to the real
workspace or immutable artifact it checked. Host configuration must also make
the recorded argv digest describe the command actually configured, and make
that command consult its declared oracle. Canonical resource identity is
assumed atomic; resource containment is not proven by criterion admission
([criterion-proof.ts:11](../packages/weave/src/criterion-proof.ts#L11)).

## Failure, cancellation and concurrency

**Check timeout while decomposition is still incomplete.** A proposed line or
proof does not become admitted because another branch has passed. Decomposition
itself has no check runner or timer here; when it depends on a host check, keep
that dependency unresolved until the recorded result arrives. P8 maps rejected,
failed or uncertain invocations to `passed: false`, with no invented exit zero,
then suppresses D5 for the failed attempt
([implement-step.ts:624](../packages/weave/src/implement-step.ts#L624)). A missing
command exit in task validation escapes. After a shell process with declared
writes has started, timeout is uncertainty about effects: Fabric retains the
reservation across restart until reconciliation, even if other properties are
green ([shell-uncertain.test.ts:183](../packages/agentfabric/test/shell-uncertain.test.ts#L183)).
A timeout never becomes a semantic fallback pass or permission to repeat effects.

**Cancellation after a partial deterministic pass.** Preserve completed evidence
as history, without promoting partial results to task or goal completion. P8
requests cancellation of the check in flight and records a paused attempt with
its collected checks and no D5 eval; a later generation requires fresh check
invocations and equal-scope grants
([implement-step.ts:657](../packages/weave/src/implement-step.ts#L657),
[implement-step.ts:963](../packages/weave/src/implement-step.ts#L963)). Cancellation
wins before the progress rule, so it cannot add a progress transition or a
no-progress strike ([progress.ts:145](../packages/weave/src/progress.ts#L145)).
The audit loop writes nothing after an aborted signal: its returned cancellation
is not durable. Recovery uses the last pre-abort checkpoint, and reuses only
results durably saved there. A dispatch intent without a saved audit report
pauses as `audit_unconfirmed`; only explicit resume permits another paid call
([AUDIT-CONTRACT.md:155](../packages/weave/src/AUDIT-CONTRACT.md#L155)). These are
different persistence contracts, not an assertion that all cancelled results
are checkpointed. Any uncertain effects still require Fabric reconciliation.

**Concurrent claims on the same property.** Independent read observations can
coexist. They do not acquire completion authority by arriving first or by
outvoting another result. For one criterion, every current bound check run must
be green and a current failing eval vetoes alongside a pass. Do not merge
evidence from different artifact revisions or producing iterations
([audit-loop.ts:181](../packages/weave/src/audit-loop.ts#L181)). Fabric's canonical
effect locks arbitrate conflicting execution, not the truth of property claims.
The composition root must exclusively own one implementation execution/workspace
and each journal writer, and serialize concurrent audit resumes **before**
loading observations and committing completion. `FileAttemptJournal` detects
some competing writes but is not a lock; `AuditJournal` has no compare-and-swap
([implement-step.ts:1145](../packages/weave/src/implement-step.ts#L1145),
[AUDIT-CONTRACT.md:176](../packages/weave/src/AUDIT-CONTRACT.md#L176)). Replays use
recorded results without dispatch; recovery of unfinished effects never reuses
a single-use grant ([host.test.ts:268](../packages/agentfabric/test/host.test.ts#L268)).

## Audit scope and further evidence

Keep the current strong audit and full authorized tidy state. A check-proven
criterion's truth needs no D5 vote, but discovering a missing criterion,
inadequate oracle, regression outside bound checks, or scope creep is a different
property. The audit must see existing evidence to discover those gaps. It may
question coverage and produce a finding; its `goal_met_claim` cannot replace or
overrule deterministic completion. The current request still asks for all four
finding kinds and uses `tier: 'strong', audit: true`
([audit-loop.ts:359](../packages/weave/src/audit-loop.ts#L359)). This note neither
narrows that view nor skips a round. Budget pressure pauses audit.

The remaining questions require separate contracts and evidence:

- **Audit narrowing or skipping.** Compare a declared candidate policy with the
  current strong audit on the same immutable artifacts and scenarios. Pin code,
  command/configuration, oracle and criteria revisions; rerun gates there and
  run the same scenarios on trunk as a regression lane. Reserve adversarial and
  held-out cases before comparison, including missing criteria, faulty oracles,
  scope creep, stale greens and the interruption cases above. Measure missed
  defects and unsafe completion as protected constraints, as well as total
  spend. Gauge already has governed criteria/case revisions, producers and
  comparisons; results do not promote a policy
  ([GAUGE-CONTRACT.md:98](../packages/gauge/src/GAUGE-CONTRACT.md#L98),
  [produce.ts:55](../packages/gauge/src/produce.ts#L55)). No such comparative run
  or policy promotion is claimed here.
- **Verification spend by risk.** D2's implementation tier is not a verification
  budget. A future declared reversibility/risk policy must state which remaining
  properties require which evidence, without dropping mandatory checks. Count
  failed trials, evaluation and human review; unknown cost is not zero, and
  `costed` must pass before weighing a comparison for promotion
  ([GAUGE-CONTRACT.md:306](../packages/gauge/src/GAUGE-CONTRACT.md#L306)).
- **D4/D7 pre-checks (#142).** Deterministically deciding a bounded fact can
  remove that exact question. Effect enforcement alone does not establish
  absence of prompt injection, exfiltration intent or semantic scope broadening.
  Retain remaining guard questions and their approval fallback
  ([boolean.ts:13](../packages/weave/src/sites/boolean.ts#L13),
  [sites/CONTRACT.md:451](../packages/weave/src/sites/CONTRACT.md#L451)).
- **Recurring findings (#203).** Turn a repeated, independently specified
  property into a contract and validated test corpus, observe red, prove green,
  and pass admission before execution authority. The existing coverage hook
  reports admitted-operation coverage, not that the check actually ran or
  caught the defect. Chronology and binding that hook to a governed Gauge
  result remain open ([RECURRING-FINDINGS-CONTRACT.md:25](../packages/weave/src/RECURRING-FINDINGS-CONTRACT.md#L25)).

## Verification of this note

This is a documentation-only composition of existing contracts. No clear missing
implementation invariant is claimed, and no new implementation or red/green
test is added. Existing behavioral evidence includes mixed/check-only proof
routing and red-check suppression (`p8.test.ts:1319`, `p8.test.ts:1437`),
current-iteration completion and audit recovery (`p9.test.ts:637`,
`p9.test.ts:1677`), cancelled progress (`progress.test.ts:351`), oracle isolation
(`criterion-proof.test.ts:35`), predicate validation (`task-acceptance.test.ts`),
and interrupted effects (`shell-uncertain.test.ts:183`). Run these relevant
suites, then `npm run verify` and every top-level `checks/*.mjs`; their outcomes
are repository validation, not Gauge evidence for skipping audit.

Recorded validation on this branch with Node `22.23.4`: all 357 tests in the
focused suites passed; every top-level `checks/*.mjs` exited zero; all 15
verification stages after `npm test` passed when run individually.
`npm run verify` was executed but is **not green** in this managed environment: package
tests recorded 2390 passes, 32 failures and one skip. Failures involve denied
loopback listeners (`listen EPERM`), child stdin and synchronous subprocess
operations (`spawnSync EPERM`). A temporary preload outside the repository
used `fs.writeSync` to preserve child stdout/stderr that Node stream writes lost
under the runner. It changed no check, threshold or repository source. Full
verification still requires an environment that supports those existing tests.

Motivation comes from the issue-supplied pstack sources:
[README](https://github.com/cursor/plugins/blob/main/pstack/README.md),
[encode-lessons-in-structure](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-encode-lessons-in-structure/SKILL.md),
[create-verification-skill](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md),
and [autopilot-full](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/autopilot-full.md).
Their contents were supplied in summary and were not independently fetched in
this offline task. Repository claims above cite inspected local contracts,
implementations and tests.
