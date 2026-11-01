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
   ([`packages/weave/src/task-acceptance.ts`](../packages/weave/src/task-acceptance.ts) `AcceptanceLine`).
2. Use structure first: contracts, closed types, permissions and enforced
   effects. Where structure cannot establish the property, use an existing
   deterministic check or acceptance predicate. Keep a judgment question for
   the semantic remainder. A replacement must establish the **same property**
   on the **same artifact revision**, within the declared scope.
3. Admit the evidence source independently of generation. A proposed criterion
   proof is an observation, not permission to omit D5. Code admits `check`
   only with bound checks, readable oracles, known generation write scope and
   host canonical identity proving that generation cannot write those oracles
   ([`packages/weave/src/criterion-proof.ts`](../packages/weave/src/criterion-proof.ts) `admitCriterionProof`).
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

| Property                                                                                | Lowest existing layer and evidence                                                                                                                                                                                                                                                                                                                                       | Remaining judgment                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package dependency direction and absence of ambient clock, entropy or environment reads | Repository checks reject these source patterns in CI ([`checks/import-direction.mjs`](../checks/import-direction.mjs) `ALLOWED`, [`checks/no-ambient-clock.mjs`](../checks/no-ambient-clock.mjs) `FORBIDDEN`, [`checks/no-ambient-entropy.mjs`](../checks/no-ambient-entropy.mjs) `FORBIDDEN`, [`checks/no-ambient-env.mjs`](../checks/no-ambient-env.mjs) `FORBIDDEN`). | Review can find properties the scanners do not cover; it need not decide again whether a covered source pattern is present.                                                                                                                                                       |
| Invocation is within its grant and has no conflicting effects                           | Fabric consumes a single-use grant and reserves canonical effects before execution ([`packages/agentfabric/src/host.ts`](../packages/agentfabric/src/host.ts) `AgentFabricHost.prepare`, [`packages/agentfabric/src/coordinator.ts`](../packages/agentfabric/src/coordinator.ts) `ResourceCoordinator.conflicts`).                                                       | D4/D7 can identify semantic risks in disclosed input/output. Their answers cannot widen a grant or release a reservation.                                                                                                                                                         |
| A command has the declared exit status; named evidence contains an exact literal        | The closed acceptance predicates decide from recorded command exit/output or artifact body. Missing evidence escapes; malformed predicates reject ([`packages/weave/src/task-acceptance.ts`](../packages/weave/src/task-acceptance.ts) `decideValidation`, [`packages/weave/src/task-acceptance.ts`](../packages/weave/src/task-acceptance.ts) `predicateVerdict`).      | `task.criteria` and `task.validate` ask only free-text facts. An all-predicate task makes neither call ([`packages/weave/src/task-acceptance.ts`](../packages/weave/src/task-acceptance.ts) `judgeCriteria`).                                                                     |
| Recorded commands violate a declared task constraint                                    | Code compares argv and the task's declaration, before deciding validation ([`packages/weave/src/task-acceptance.ts`](../packages/weave/src/task-acceptance.ts) `hardConstraints`). This bounded recognition does not replace Fabric's effect enforcement.                                                                                                                | Other facts may need task validation; the write-up is never evidence that overrides a constraint.                                                                                                                                                                                 |
| An implementation satisfies a check-proven success criterion                            | Host-configured `repo.test`, `repo.lint` or `repo.build`, with admitted criterion proof and every bound run green ([`packages/agentfabric/src/host.ts`](../packages/agentfabric/src/host.ts) `AgentFabricHost.prepareShell`, [`packages/weave/src/implement-step.ts`](../packages/weave/src/implement-step.ts) `runImplementationStep`).                                 | D5 asks only the `judgment` criteria, and asks none after any configured check is red. The attempt records `eval_skipped: 'check_failed'`, without inventing an eval ([`packages/weave/src/implement-step.ts`](../packages/weave/src/implement-step.ts) `runImplementationStep`). |
| Evidence establishes progress between consecutive tidy states                           | The progress delta decides unchanged evidence as `stalled`, only gains as `progressing`, and only losses as `regressing` ([`packages/weave/src/progress.ts`](../packages/weave/src/progress.ts) `settled`, [`packages/weave/src/progress.ts`](../packages/weave/src/progress.ts) `progressRule`).                                                                        | The first round, added/removed criterion ids and other undecided deltas ask D8. Both paths feed the existing stop rule and record which decided ([`packages/weave/src/progress.ts`](../packages/weave/src/progress.ts) `decideProgress`).                                         |
| Current success evidence permits completion                                             | Code requires green checks, criterion bindings, current evidence, and a current confident D5 pass only for judgment criteria. A current failing eval vetoes even beside a pass ([`packages/weave/src/audit-loop.ts`](../packages/weave/src/audit-loop.ts) `complete`).                                                                                                   | Strong audit discovers gaps, defects, regressions and scope creep; D6 disposes its findings. `fix_now` or `needs_human` still prevents completion ([`packages/weave/src/audit-loop.ts`](../packages/weave/src/audit-loop.ts) `runAuditLoop`).                                     |
| A judgment finding recurs often enough to propose a check capability                    | A declared recurrence policy counts distinct executions, using kind, criterion and stable check-relevant evidence, without counting retries twice ([packages/weave/src/RECURRING-FINDINGS-CONTRACT.md:6](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/src/RECURRING-FINDINGS-CONTRACT.md#L6)).                           | Semantic equivalence of opaque evidence references remains the caller's responsibility. The gap goes through ordinary crystallization; recording it generates, admits and executes nothing.                                                                                       |

For example, “README contains `--dry-run`” is an exact-literal predicate.
“README explains the effects of `--dry-run`” remains a free-text fact. A green
exit status proves the command exited successfully; it establishes the broader
criterion only when that check's independently governed oracle actually covers
it. Generated tests inside generation's writable workspace do not earn `check`
proof merely because they exit zero. The mixed-criterion fixtures keep D5 on
the remainder ([packages/weave/test/p8.test.ts:1319](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/test/p8.test.ts#L1319)).
The criterion bindings and fixed host commands supply the existing map from a
property to its verifier; generation does not author a new verifier per run.
Correctness evidence does not establish performance or code quality without
separately declared measures and checks for those properties.

The implementations above cover #199–#202 and the record-only slice of #203.
#198 has a recorded decision to retain the confidence requirement, rather than
a new provider or a probability-only completion path. The repository's recorded
live run found no per-question confidence; a live-shaped D5 answer therefore
fails as `missing_confidence`. Its probability cannot substitute for confidence
([packages/weave/src/sites/CONTRACT.md:415](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/src/sites/CONTRACT.md#L415),
[packages/weave/test/live-confidence.test.ts:68](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/test/live-confidence.test.ts#L68)).

## Evidence belongs to the artifact being verified

Check argv is host configuration, never generated input. P8 retains argv digest,
exit, bounded output, artifact references and host invocation identity
([`packages/weave/src/implement-step.ts`](../packages/weave/src/implement-step.ts) `CheckEvidence`). A new
generation run has a fresh injected run identity, even when its returned text is
identical: workspace edits may differ. Checks execute again instead of replaying
the earlier green result ([`packages/weave/src/implement-step.ts`](../packages/weave/src/implement-step.ts) `runImplementationStep`,
[packages/weave/test/p8.test.ts:762](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/test/p8.test.ts#L762)).

The observation owner must project the admitted proof and actual check/eval
evidence into tidy state, retaining its producing audit iteration. A retry
attempt number is not an audit iteration. Retained or untagged green checks
cannot settle a check-proven criterion in a later iteration
([packages/weave/src/AUDIT-CONTRACT.md:47](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/src/AUDIT-CONTRACT.md#L47)). Completion
also vetoes **any** red check disclosed in the current view; do not silently
discard contrary results to manufacture a green view
([`packages/weave/src/audit-loop.ts`](../packages/weave/src/audit-loop.ts) `complete`).

Audit reuse requires both the tidy-state digest and captured revision to match;
live revision guards run before D6 and completion. A content change invalidates
the old verdict's applicability
([`packages/weave/src/audit-loop.ts`](../packages/weave/src/audit-loop.ts) `runAuditLoop`). This is not an
automatic Git-commit attestation: the observer supplies artifact digests,
iterations and revisions. The composition root must bind them to the real
workspace or immutable artifact it checked. Host configuration must also make
the recorded argv digest describe the command actually configured, and make
that command consult its declared oracle. Canonical resource identity is
assumed atomic; resource containment is not proven by criterion admission
([packages/weave/src/criterion-proof.ts:11](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/src/criterion-proof.ts#L11)).

## Failure, cancellation and concurrency

**Check timeout while decomposition is still incomplete.** A proposed line or
proof does not become admitted because another branch has passed. Decomposition
itself has no check runner or timer here; when it depends on a host check, keep
that dependency unresolved until the recorded result arrives. P8 maps rejected,
failed or uncertain invocations to `passed: false`, with no invented exit zero,
then suppresses D5 for the failed attempt
([`packages/weave/src/implement-step.ts`](../packages/weave/src/implement-step.ts) `runChecks`). A missing
command exit in task validation escapes. After a shell process with declared
writes has started, timeout is uncertainty about effects: Fabric retains the
reservation across restart until reconciliation, even if other properties are
green ([packages/agentfabric/test/shell-uncertain.test.ts:183](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/agentfabric/test/shell-uncertain.test.ts#L183)).
A timeout never becomes a semantic fallback pass or permission to repeat effects.

**Cancellation after a partial deterministic pass.** Preserve completed evidence
as history, without promoting partial results to task or goal completion. P8
requests cancellation of the check in flight and records a paused attempt with
its collected checks and no D5 eval; a later generation requires fresh check
invocations and equal-scope grants
([`packages/weave/src/implement-step.ts`](../packages/weave/src/implement-step.ts) `runChecks`,
[`packages/weave/src/implement-step.ts`](../packages/weave/src/implement-step.ts) `runImplementationStep`). Cancellation
wins before the progress rule, so it cannot add a progress transition or a
no-progress strike ([`packages/weave/src/progress.ts`](../packages/weave/src/progress.ts) `decideProgress`).
The audit loop writes nothing after an aborted signal: its returned cancellation
is not durable. Recovery uses the last pre-abort checkpoint, and reuses only
results durably saved there. A dispatch intent without a saved audit report
pauses as `audit_unconfirmed`; only explicit resume permits another paid call
([packages/weave/src/AUDIT-CONTRACT.md:155](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/src/AUDIT-CONTRACT.md#L155)). These are
different persistence contracts, not an assertion that all cancelled results
are checkpointed. Any uncertain effects still require Fabric reconciliation.

**Concurrent claims on the same property.** Independent read observations can
coexist. They do not acquire completion authority by arriving first or by
outvoting another result. For one criterion, every current bound check run must
be green and a current failing eval vetoes alongside a pass. Do not merge
evidence from different artifact revisions or producing iterations
([`packages/weave/src/audit-loop.ts`](../packages/weave/src/audit-loop.ts) `complete`). Fabric's canonical
effect locks arbitrate conflicting execution, not the truth of property claims.
The composition root must exclusively own one implementation execution/workspace
and each journal writer, and serialize concurrent audit resumes **before**
loading observations and committing completion. `FileAttemptJournal` detects
some competing writes but is not a lock; `AuditJournal` has no compare-and-swap
([`packages/weave/src/implement-step.ts`](../packages/weave/src/implement-step.ts) `FileAttemptJournal`,
[packages/weave/src/AUDIT-CONTRACT.md:176](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/src/AUDIT-CONTRACT.md#L176)). Replays use
recorded results without dispatch; recovery of unfinished effects never reuses
a single-use grant ([packages/agentfabric/test/host.test.ts:268](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/agentfabric/test/host.test.ts#L268)).

## Audit scope and further evidence

Keep the current strong audit and full authorized tidy state. A check-proven
criterion's truth needs no D5 vote, but discovering a missing criterion,
inadequate oracle, regression outside bound checks, or scope creep is a different
property. The audit must see existing evidence to discover those gaps. It may
question coverage and produce a finding; its `goal_met_claim` cannot replace or
overrule deterministic completion. The current request still asks for all four
finding kinds and uses `tier: 'strong', audit: true`
([`packages/weave/src/audit-loop.ts`](../packages/weave/src/audit-loop.ts) `runAuditLoop`). This note neither
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
  ([packages/gauge/src/GAUGE-CONTRACT.md:98](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/gauge/src/GAUGE-CONTRACT.md#L98),
  [`packages/gauge/src/produce.ts`](../packages/gauge/src/produce.ts) `evaluate`). No such comparative run
  or policy promotion is claimed here.
- **Verification spend by risk.** D2's implementation tier is not a verification
  budget. A future declared reversibility/risk policy must state which remaining
  properties require which evidence, without dropping mandatory checks. Count
  failed trials, evaluation and human review; unknown cost is not zero, and
  `costed` must pass before weighing a comparison for promotion
  ([packages/gauge/src/GAUGE-CONTRACT.md:306](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/gauge/src/GAUGE-CONTRACT.md#L306)).
- **D4/D7 pre-checks (#142).** Deterministically deciding a bounded fact can
  remove that exact question. Effect enforcement alone does not establish
  absence of prompt injection, exfiltration intent or semantic scope broadening.
  Retain remaining guard questions and their approval fallback
  ([`packages/weave/src/sites/boolean.ts`](../packages/weave/src/sites/boolean.ts) `INPUT_RULES`,
  [packages/weave/src/sites/CONTRACT.md:451](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/src/sites/CONTRACT.md#L451)).
- **Recurring findings (#203).** Turn a repeated, independently specified
  property into a contract and validated test corpus, observe red, prove green,
  and pass admission before execution authority. The existing coverage hook
  reports admitted-operation coverage, not that the check actually ran or
  caught the defect. Chronology and binding that hook to a governed Gauge
  result remain open ([packages/weave/src/RECURRING-FINDINGS-CONTRACT.md:25](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/src/RECURRING-FINDINGS-CONTRACT.md#L25)).

## Verification of this note

This is a documentation-only composition of existing contracts. No clear missing
implementation invariant is claimed, and no new implementation or red/green
test is added. Existing behavioral evidence includes mixed/check-only proof
routing and red-check suppression ([packages/weave/test/p8.test.ts:1319](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/test/p8.test.ts#L1319), [packages/weave/test/p8.test.ts:1437](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/test/p8.test.ts#L1437)),
current-iteration completion and audit recovery ([packages/weave/test/p9.test.ts:637](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/test/p9.test.ts#L637),
[packages/weave/test/p9.test.ts:1677](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/test/p9.test.ts#L1677)), cancelled progress ([packages/weave/test/progress.test.ts:351](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/test/progress.test.ts#L351)), oracle isolation
([packages/weave/test/criterion-proof.test.ts:35](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/weave/test/criterion-proof.test.ts#L35)), predicate validation (`task-acceptance.test.ts`),
and interrupted effects ([packages/agentfabric/test/shell-uncertain.test.ts:183](https://github.com/CrowBe/weave/blob/8ce60c5abe26f3d806db152a0dcad93f9824a363/packages/agentfabric/test/shell-uncertain.test.ts#L183)). Run these relevant
suites, then `npm run verify` and every top-level `checks/*.mjs`; their outcomes
are repository validation, not Gauge evidence for skipping audit.

Motivation comes from the issue-supplied pstack sources:
[README](https://github.com/cursor/plugins/blob/main/pstack/README.md),
[encode-lessons-in-structure](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-encode-lessons-in-structure/SKILL.md),
[create-verification-skill](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md),
and [autopilot-full](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/autopilot-full.md).
Their contents were supplied in summary and were not independently fetched in
this offline task. Repository claims above cite inspected local contracts,
implementations and tests.
