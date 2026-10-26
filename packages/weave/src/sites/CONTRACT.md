# P5 choice sites

`evaluateSite(site, input, port, current, signal?)` captures a disclosed state,
asks one `choice` question named `decision`, then calls the pure
`transitionSite(site, input, recorded, current)` rule. `current()` is injected
and read after await, so a revision change in flight rejects the answer.
`recorded` contains the gateway outcome, state_revision and observed_at.
Input contains request_id, state_revision, state_updated_at, state and terms.

D1 requires confidence >= .80 and selected probability >= .6, with the selected
option at the maximum of a valid distribution. Fallback is implement with strong
as the safest tier (decided in #89: safest means quality-safe, still subject to
budget/authority). D2 requires .75, fallback standard. D8 requires .70, fallback
stalled. Intake requires .80 (provisional, until P10 calibration), fallback
ask_user / needs_human. Intake state contains a disclosed message and running
thread summaries; classification grants no authority to interrupt or dispatch.
The type enforces that shape: for `intake.classify`, `transitionSite` and
`evaluateSite` take `IntakeSiteInput`, whose state is `IntakeState`. Other choice
sites take any disclosed evaluation content. A caller that holds a union of
sites gets the wider input type. The check is compile-time only; there is still
no channel transport.

An answer from a different revision, or observed before the current state's
update, is stale. Request id/site must match. Nonaccepted outcomes and exceptions
fall back; unavailable provider or thrown port pauses dispatch-dependent steps.
Read-only steps may use deterministic fallback. Cancellation always pauses.
An outage is classified on the attempts' failure codes, not on the gateway's
unaccepted reason, because the gateway reports the same failed attempts as
`attempts_exhausted` at `max_attempts: 1` and as `provider_failed` above it.
`provider_failed` or `attempts_exhausted` is an outage when a failed attempt
carries `unavailable`, `unauthorized`, `quota_exhausted`, `rate_limited`,
`timeout`, or `cancelled`. A refusal (`invalid_request`) or a
`malformed_response` alone is `no_answer` and takes the fallback at every
`max_attempts`. `provider_failed` with no failed attempt is an abort before any
attempt and stays an outage. `budget_exhausted`, `deadline_reached`, a gateway
pause, and the blocked reasons `provider_unavailable`, `no_route`, `no_budget`,
`quota_unknown`, `weekly_budget_cap`, and `deadline_passed` are outages.
No returned transition dispatches or authorizes execution. D2's tier is a ceiling
for the existing P4 gate.

Records use schema decision-site@1 and fixed keys. Record only closed-vocabulary
answers, numeric statistics and safe correlation identifiers, never raw state,
provider error details, arbitrary answers or distribution keys. Questions are
fixed text. Correlation identifiers are bounded opaque identifiers; recognizable
credential prefixes are omitted. `Bearer` counts only when whitespace follows
it, as in the Weft screen, so an id such as `bearer_x` is kept (#158). D3's
routed-unit id uses the same screen. No generic secret detector can sanitize arbitrary
operator content, so that content is never copied into the record.

A `stale_answer` record does not say which freshness check failed (#93). The
check compares the recorded `state_revision` and `observed_at`, the input's
`state_revision` and `state_updated_at`, and the current reading. Only the
input's `state_revision` is in the record. No audit consumer needs the cause
yet, because the `view.audit@1` decisions slice carries no site reason. Adding
`state_updated_at` and `observed_at` after `state_revision` would change
decision-site@1's fixed keys, so it needs a new schema version. That waits
until an audit reads stale causes. Until then, a caller that needs the cause
persists the recorded answer and the current reading it passes to the pure
transition, which reproduces the decision.

`input.route` (#27) is a choice site with options `conversation`, `steer`,
`interrupt`, `parallel` and `queue`. It requires confidence .80
(provisional, as intake, until calibration) and falls back to `ask_user` /
`needs_human`. Its state is `RouteState`: one disclosed operator input, a
disclosed summary of the workstream's active work, and that workstream's
operating process state. The type enforces that shape as it does for
intake. Routing never dispatches, so `needs_dispatch` is always false: an
outage takes the fallback and asks the operator, and only cancellation
pauses. The site is asked only after explicit operator direction and the
no-active-work rule have not decided. The routing record and what each
outcome does are in [WORKSTREAM-CONTRACT.md](../WORKSTREAM-CONTRACT.md).
The answer is an observation and grants no authority to dispatch,
interrupt or open work. `input.route` does not replace `intake.classify`. It
has no `stop` outcome, because only explicit operator direction may end
work. It has no benchmark set yet, and `decision.sites` cannot yet override
its provider.

`stopForNoProgress(history, issues)` stops on the last two stalled/regressing
choices or a currently reappearing issue with at least two recorded fix attempts.
Transport, persistence and full-loop integration remain
outside this contract. ScriptedDecisionLayer remains unchanged.

## P6 boolean sites

D3 receives only the already-disclosed M6 index (id/purpose), an explicitly
disclosed `preselect_step` string, optional `required_entry_ids`, and an
optional `preselect_policy` of `{ k, floor, max_excluded, min_margin, provider }`.
It never receives the general state or schemas. Questions use ordinal ids
`entry_N`. Selection keeps the top k entries by p(true) (default 3) and drops
a score below the optional floor (default 0, which leaves the floor off). k is
an integer from 1 to 8. The cap of 8 is that upper bound. Ties sort by p(true)
descending, then by disclosed order. Required ids that are in the index are
always kept, in addition to the top k of the remaining entries, and are not
removed by k, floor, the cap, or the margin gate. A required id that is not in
the index is ignored and counted; D3 only narrows. `required_entry_ids` is
read with `Array.isArray`. A non-array is no required ids. Non-string items are
dropped and the valid strings are kept. Either case sets `required_ids_invalid`.
There is no include-if-p >= .5 rule, so a low p(true) alone never drops an
entry. A nonempty index never yields an empty slice, even when every confident
answer is below .5 (#96). The result is the kept top-k slice, or the full index
on any fallback, including `no_candidate` when the floor removes every
non-required entry. Only an empty disclosed index yields an empty result.

The candidate slice narrows only when every entry has a probability and
admission succeeds, and then only when the margin gate passes. `top_p` on the
selection record is the highest p(true) among kept non-required entries.
`best_excluded_p` is the highest p(true) among excluded entries, ties broken
by disclosed order, or null when nothing is excluded. Nothing excluded means
there is nothing to gate: the index is kept even if a confidence is low or
missing. Otherwise narrow only when `best_excluded_p <= max_excluded` and
`top_p - best_excluded_p >= min_margin`. The recorded margin is that
difference at 10 decimal places, so a gap of exactly .3 stays .3. `top_p`,
`best_excluded_p`, `margin`, and each `scores[].p` record `-0` as `0`.
Defaults are `max_excluded` .4 and `min_margin` .3. Both bounds are inclusive
and accept exactly 0 and exactly 1. A computed miss, where `top_p` is present,
is `weak_margin` and the full index. When the floor removes every non-required
entry, `top_p` is null and something was excluded: the reason is `no_candidate`,
not `weak_margin`, `margin` is null, and `best_excluded_p` is still the highest
excluded p(true). That holds with required entries and without them. Required
entries stay marked required, and the full index is returned.

A missing confidence is unknown, not a failure. Absent means the confidence
map is missing or omits that key. A published confidence below .75 is checked
only on the boundary: the kept non-required entries and the single best
excluded entry, and only after the margin has passed. Any such value is
`low_confidence` and the full index. Published low confidence elsewhere,
including on a required entry, does not block. A published value that is not a
finite number in [0, 1], for example 60, -1, NaN, or a non-number, is not
unknown. The TypeSafe and Vercel AI Gateway adapters forward a published
non-number, `null` included, as NaN rather than dropping it; Amos rejects any
published confidence outside [0, 1] as `malformed_response`. Any published
invalid confidence, on any entry, is `invalid_confidence` and the full index.
That includes a boundary entry, a non-boundary entry, a required entry, and
the case where nothing is excluded. D4 and D7 do not use
this split: a non-unit confidence there is still `missing_confidence`. A
missing or malformed probability, a wrong kind, a stale or changed revision,
an outage, or cancellation is `admission` and returns the whole index.
Admission wins over an invalid confidence. An invalid confidence wins over
`no_candidate`, `weak_margin`, and `low_confidence`. `no_candidate` wins over
`weak_margin`, and a weak margin wins over low confidence. Unknown question
ids are ignored and recorded as a count of fixed-text observations, never
their names. Empty indexes need no evaluation.

The D3 transition carries `preselect` with schema `preselect-selection@2`, in
this key order: `schema`, `k`, `floor`, `cap`, `max_excluded`, `min_margin`,
`policy_provider`, `routed_unit_id`, `outcome`, `reason`, `top_p`,
`best_excluded_p`, `margin`, `scores`, `kept`, `required_missing`,
`required_ids_invalid`. `policy_provider` is the caller-supplied provider
after validation, or null when that policy was replaced. It is not the
provider that answered. `routed_unit_id` is taken from an accepted outcome
when the id is a bounded identifier; credential-shaped text is omitted, and
the field is null when there is no accepted outcome. `outcome` is `narrowed`,
`fallback`, or `empty_index`. `reason` is null for `narrowed` and
`empty_index`; on fallback it is `weak_margin`, `no_candidate`,
`low_confidence`, `invalid_confidence`, or `admission`. Margin statistics are
null on admission and on an empty index. On `no_candidate`, `top_p` and
`margin` are null and `best_excluded_p` is still recorded when an entry was
excluded. On `invalid_confidence` the probability statistics stay, because the
probabilities themselves were admitted.
Each score is `{ entry, p, rank, kept, required }` in disclosed order. `entry`
is the `entry_N` ordinal. `p` and `rank` are null when that answer is missing.
Rank is 1-based among answers that have a probability, by p(true) descending
and then disclosed order. `kept` follows the returned index, so a fallback
marks every entry kept. The record does not copy catalogue ids, purposes, or
required names. Guard sites omit it. A policy that is not a plain object with
only `k`, `floor`, `max_excluded`, `min_margin`, and `provider`, with k in
1..8, floor in [0, 1), both margin bounds in [0, 1], and a known provider or
null, is replaced wholesale by k = 3, floor = 0, max_excluded = .4,
min_margin = .3, and a null provider. A missing field is incomplete and
replaces the whole policy. The pure transition does not keep the valid fields.
`resolvePreselectPolicy` is the per-field fill: a missing or out-of-range
field there uses that field's default and the other fields stay. Selection
still narrows after a wholesale replacement. That replacement is not an
admission fallback. Per-entry `answer` is `include` when the entry is in the
returned index and `exclude` otherwise. An entry with a probability and no
published confidence is `accepted` for `loop.preselect`, not
`missing_confidence`. Observation `top_p` remains that entry's p(true), with
`-0` recorded as `0`. On a margin or confidence fallback (`weak_margin`,
`no_candidate`, `low_confidence`, or `invalid_confidence`), a per-entry
observation can still say `accepted` with `fallback_used` false. A boundary
entry whose published confidence is a number below .75 says `low_confidence`.
An entry with a published invalid confidence says `invalid_confidence`, with
`confidence: null`, `accepted: false`, and `fallback_used: true`. Every offending
entry is marked, including required entries and entries outside the boundary;
valid entries retain their own reasons. Admission failures still take precedence.
Observations remain in disclosed order, so their positions identify the entries.
The fallback is visible on `preselect.outcome` and `preselect.reason`.
This extends the reason vocabulary of `decision-site@1` without changing its
keys or their order. Historical observations with `reason: accepted` and
`confidence: null` remain valid and are not reinterpreted as invalid confidence.
The pure sites are not currently wired to observation-log replay. The generic
journal reader preserves payloads, and the digest function canonicalizes their
recorded keys and values without validating site reasons; neither migrates old
records or changes their digests.

D4 asks the four fixed rules in one boolean evaluation: secret exfiltration,
scope broadening, destructive effect without grant, and prompt injection.
Injection criteria include instructions in untrusted content to override policy,
impersonate authority, reveal secrets or expand tool/scope access; these feed the
existing decision evaluation, rather than a second gate. D7 asks whether proposed
output introduces effects outside the grant. Both escalate to needs_human for
p >= .3 or any admission failure, with per-rule reasons. A clean judgment is
only evidence and contains no grant or dispatch authority.

An approval request names its rule: one of the four D4 rule ids, or
`out_of_grant_effect` for D7. D7's wire question id stays `decision`, so its
request and the frozen benchmark sets keep their shape. Neither guard injects a
grant or scope. D4 judges scope broadening and destructive effect without grant,
and D7 judges out-of-grant effects, only from what the caller discloses in
`state`. The caller must therefore disclose the effective grant and authorized
scope there. A guard that was not shown them cannot judge those rules, and its
pass is still only evidence. The guards are not yet wired into the loop. Until
they are, the guarantee that a clean D7 cannot widen a grant is structural: a
guard transition has exactly `status`, `catalogue_index`, `approval_requests`,
and `observations`. Fabric checks the grant it is given against the authority
that issued it. A test feeds a clean D7 into a Fabric invocation to show this.
Wiring the guards must keep both properties and must supply the disclosure.

Outage outcomes differ by what a site decides, and the split is intentional
(#100). A P5 choice site proposes a transition and has a deterministic
fallback, so its outage is a missing observation, not an authority question.
Read-only work takes the fallback. Dispatch-dependent work pauses, so a
fallback such as D1's `implement` at the strong tier never dispatches on a
guess. The pause is resumable without a human, and resumption observes
availability again. A D4 or D7 guard decides whether a dispatch may proceed.
An outage leaves that question open, so the guard takes the same outcome as any
other unestablished judgment: approval requests with reason
`decision_unavailable` and status `needs_human`, whatever `needs_dispatch`
says. A guard never returns `transition` or `paused` for an outage. The audit
loop composes the two. With `needs_dispatch` and `decision_unavailable` it
records a resumable `decision_unavailable` pause, and resumption asks the guard
again. The dispatch proceeds only after a clean guard judgment or a human
approval. On an outage D3 returns the full disclosed index and D5 fails every
criterion. Neither pauses except on cancellation.

Provisional confidence floors: .75 for a published D3 boundary confidence and
.90 for D4/D7, pending P10 calibration. A missing D3 confidence is unknown. A
published D3 confidence outside [0, 1] is `invalid_confidence` for the whole
index. Shape is the fixed question set, gate is P5 metadata admission plus
per-answer shape validation, and for D3 the margin gate before the boundary
confidence check. An invalid published confidence is decided with admission,
before that margin gate. D4/D7 still require a confidence on every rule, and a
non-unit confidence there remains `missing_confidence`. Decide is the
deterministic threshold.
One round, no refinement or semantic substitution on outage. Unknown answers
cannot repair missing required answers. Observations retain decision-site@1 key
order; boolean answer is a fixed pass/block/include/exclude vocabulary, top_p
is p(true), and question is fixed text (never a catalogue id or rule payload).

The fx permissions documentation describes prompt injection or malicious behavior
review and holding actions when review fails. The concrete injection checklist
above is a provisional local interpretation, not a claimed upstream rubric.
Source: https://fx.sh/docs/configure-fx/permissions.md

## P8 output evaluation and the implementation step

D5 (`eval.output`) is one boolean question per success criterion. `evaluateOutputEval`
captures the disclosed criteria, asks ordinal questions `criterion_N`, and then
calls pure `transitionOutputEval`. The observation is `decision-site@1` in the
same key order as P5, with site `eval.output`, fixed question text, and answer
`pass`, `fail`, or null. `accepted` means the answer cleared shape and the
confidence floor. `passed` on the eval record is the criterion gate: `p >= 0.8`
and `confidence >= 0.9`. Missing confidence is below the floor. A confident
answer below 0.8 is `fail` with reason `below_probability` and is not a fallback.
Low confidence, a missing or unparseable answer, a stale revision, or a mismatch
fails that criterion and sets `fallback_used`. An outage or a thrown port fails
every criterion with `decision_unavailable`. Another site's answer is a mismatch,
not a pass. Unknown answer keys are counted with fixed text and are not copied.
Criterion statements and raw state are not copied into the observation. An unsafe
criterion id cannot pass and is replaced by its ordinal key.

The implementation step (`impl.step@1`) is separate from the pure site. It
generates once at the routed tier, then each configured `repo.test`,
`repo.lint`, or `repo.build`. The check's grant is a held template. An injected
issuer, supplied by the composition root and not by a decision answer, returns
a fresh equally-scoped grant per attempt and per check. `createEqualGrantIssuer`
copies that scope from a `GrantAuthority` grant it holds and refuses any other
object. It names each fresh grant `<held action_id>:g<n>` and mints at most
`limit` per held grant (default `retries + 2` for the default retries), one
issuer per step run. The step does not invoke a wider grant and does not consume the
template. A decision answer cannot mint a grant. The step then runs D5. Check
evidence is `{ check_id, argv_digest, exit, passed, tail, artifacts, invocation_id }`. Eval
evidence is `{ criterion_id, verdict_probability, confidence, passed }`. A red
check fails the attempt even when D5 passes. The step retries the same tier up
to N times (default 2), then escalates one tier once, never past the D2 ceiling.
A budget downgrade stays at or below the requested tier. Escalation is one tier above the
routed (input) tier, not above a budget-lowered tier. A downgrade of the
escalated tier stops the step with an open issue; a budget pause, at escalation
or not, is a resumable paused attempt. A budget pause or a
blocked escalation does not mint a grant and does not complete the goal. A D5 outage (every judged criterion `decision_unavailable`) pauses the attempt with that reason instead of failing it, so it spends no retry and not the escalation.
`goal_done` is false. The terminal blocker is `open_issue@1`:

```text
{ schema, issue_id, execution_id, source: 'check'|'eval', criterion_ids,
  check_ids, text, severity: 'blocker', blocked_by: 'ceiling'|'budget'|null }
```

Finished attempts are `impl.attempt@1` records under one `execution_id`, linked
by `id` and `parentId`, appended before the next attempt. A stop is
`impl.stop@1` and carries the open issue. A torn final line is repaired on the
first load or append: an unparseable tail is truncated, and a complete record
missing its newline is terminated, so a finished attempt is not lost and the
journal stays loadable. `FileAttemptJournal` fsyncs each append, reads and
repairs the file once per instance, and fails closed if another writer changed
the file since its last read or write. One writer per journal file is assumed;
the check detects a second writer and is not a lock. Replay reads that journal and does not call a provider. Replay of an unfinished
journal reports `unfinished` with no open issue, not `failed`.
Generate text is not stored on the attempt; the step keeps a `gen_` digest ref.
Env values are not inputs to this step.

Each generation run takes a fresh opaque value from the injected `runId` port, as time comes from `now`; Loom draws no ambient entropy (`checks/no-ambient-entropy.mjs`). A 128-bit digest over that value and the full generated-text digest is the check-run identity in every check invocation id, `<execution>:a<N>:<check-run>:<check_id>`. Each check record keeps the host's `invocation_id` (null when the host rejected the check or reported an unbounded id). Every step-built id keeps its readable `<execution><suffix>` form within the 128-character correlation limit; a longer one uses a bounded execution prefix plus the full execution digest, as audit request ids do. The port must not repeat a value for one execution, including across restarts, and an invalid value stops the step before generation. Recovery may regenerate an unfinished attempt, but its checks must execute again: neither a different output nor identical text from a workspace-editing backend may reuse committed checks from a prior generation run. The execution id and attempt number remain stable; finished attempts are still skipped. Check evidence belongs to that generation run and its recorded `gen_` artifact. Generate backends are responsible for applying workspace edits; the step does not apply generated text. This assumes a single writer controls the workspace during generation and checks.

## Local intake provider

The gateway composition configures `decision.sites["intake.classify"] = "amos"`.
`loop.preselect` may select `amos` or `typesafe-jev` as well. Intake's Amos
route needs a matching choice evaluate unit. Preselect's Amos route needs a
matching boolean evaluate unit. Every site left unset keeps the TypeSafe default
`typesafe-jev` / `jev-preview`. Provider selection is exclusive; a site never
silently retries against the other provider. `decision.preselect` may set
`{ k, floor, max_excluded, min_margin }` per provider id. The defaults are
k = 3, floor = 0, max_excluded = .4, and min_margin = .3, and the cap is 8.
`resolvePreselectPolicy` fills each missing or out-of-range field with its own
default. The pure D3 transition does not: an invalid or incomplete policy is
replaced wholesale, as specified above.
Amos readiness uses GET `/v1/models`, which must list the configured model.
An unreachable service, non-2xx health response, unlisted model or timeout
produces a typed unavailable failure and gateway `provider_unavailable`
evidence. A response naming another model is `malformed_response`. Intake then
uses `ask_user` / `needs_human`; dispatch-dependent steps remain paused under
the existing rule. A model classification remains an observation, not authority.

## P9 audit loop

`audit.generate` makes one strong-tier generation over `view.audit@1`. The parsed
`AuditReport` is an observation; its goal_met_claim grants no completion authority.
D6 `audit.dispose` asks one ordinal choice per finding with confidence >= .75;
missing, stale, uncertain or unavailable answers fall back to needs_human.
The deterministic loop requires green criterion-linked checks and passing D5 for
every criterion, plus no fix_now finding. fix_now creates a stable open_issue and
returns to Observe. Budget, iteration cap, repeated issues and two consecutive
stalled/regressing D8 outcomes persist a stop. Authority blocks require a human.
Round records are appended before loop-back; replay performs no provider calls.
The journal port requires durable append-before-return and a single writer.

Each round's progress choice comes from recorded evidence before D8 (#202).
`progressDelta` builds `progress.delta@1` from two consecutive tidy states, in
this key order: `schema`, `previous_digest`, `current_digest`, `criteria`,
`removed`, `gained`, `lost`, `rule`. Each digest is SHA-256 over that state's
checks, evals and artifacts. `criteria` lists `{ criterion_id, before, after }`
in the current goal's order; `before` is null for a criterion the previous
state did not list. A criterion is settled when every run of each bound check
is green (for a check-proven criterion, it needs a run in the current iteration
and only those runs count), no current D5 eval for it failed, and a judgment
criterion has a current pass at p >= .8 and confidence >= .9. That is the
per-criterion part of completion; with every check green, all criteria are
settled exactly when completion holds. The rule is pure. A changed criterion
set asks D8. Otherwise an unchanged digest is `stalled`, at least one criterion
newly settled and none lost is `progressing`, and at least one lost and none
gained is `regressing`. Anything else, and the first round, asks D8 through
`evaluateSite('loop.continue', ...)` with its unchanged threshold and
`stalled` fallback. `decideProgress` returns `progress.record@1`: `schema`,
`delta`, `decided_by` (`rule` or `site`), `choice`, `status`, and `site` (D8's
transition, or null when the rule decided). A rule decision makes no provider
call, so a decision outage cannot turn it into a fallback. `transitionProgress`
rebuilds the record from its recorded delta and D8 transition without a
provider; replay uses that. The rule produces only D8's options and adds no stop
condition. The Observe port supplies `progress` from these records' choices,
so two consecutive rule-decided `stalled` rounds still stop as `no_progress`.

The journal also checkpoints the detached tidy-state observation before generation
and its accepted report before D6. Recovery reuses that report instead of
repeating the strong call; after a crash before the report checkpoint, a durable
dispatch intent stops recovery as a resumable `audit_unconfirmed` pause instead
of calling again (see AUDIT-CONTRACT.md). File durability is supplied through the journal port; the included
memory journal is a fixture. Observe owns normal implementation dispatch under
existing policy and grants, and supplies completed issue fix-attempt counts;
an issue's repeated appearance alone is not proof that a fix was attempted.

Budget and cancellation pauses preserve outstanding open issues. Replay remains
read-only unless `resume: true` explicitly resumes a budget/cancelled outcome;
resume reuses that round and its checkpoint, so pauses do not consume the audit
round cap. An over-budget tidy-state observation is never checkpointed, so a
resumed budget pause observes the current budget again. Journal entry ids remain unique across repeated pauses. Completion
rechecks the current revision after D6, including the empty-finding path.

## Live confidence decision (#198, #142)

Recorded from the non-gating P10 run `live-20261015`. No configured provider
publishes a per-question confidence. jev-1.14.0 and amos-1-2b return only a
probability for each boolean answer: on the holdout, 12 of 12 `eval.output`,
64 of 64 `guard.input`, and 18 of 18 `guard.output` confidences were missing
for each provider. D5 passes a criterion only at p >= .8 with a published
confidence >= .9, and D4/D7 need a confidence >= .90 on every rule. Live, every
judgment criterion therefore fails D5 as `missing_confidence`, and every guard
evaluation, clean or not, is an approval request with that reason. Both fail
safe. No threshold changes; thresholds change only on tune-split evidence and
the holdout stays untouched.

D5 (#198) options and the evidence each rests on:

1. Settle check-provable criteria without D5 (#199). Applies; it landed as
   criterion proof. It rests on structure, not a statistic: a check whose
   oracle generation cannot write establishes the property, so D5 is not asked.
   It removes the dependency for those criteria only.
2. A probability-only D5 rule with a stricter band. Does not apply. The only
   evidence is the report's descriptive holdout diagnostic: 83.3% violation
   recall at P(violation) >= .3 for both providers, on 12 holdout items each.
   About one unsatisfied criterion in six would pass, which is not enough for a
   completion gate. A holdout figure cannot fit a threshold, and no tune-split
   fit exists: the 12 tune items per provider ended `minimum_coverage_unmet`.
3. Per-provider calibration from P10 before any rule change. Deferred; it is a
   prerequisite of option 2 and needs a tune split with enough judgment
   criteria per provider. The recorded Brier .070 / .083 and ECE .075 / .096
   (jev / amos, 12 items) are descriptive only.

Under this rule a live-shaped D5 answer fails its criterion with
`missing_confidence` and keeps its probability as `verdict_probability`. The
implementation step retries, escalates once and raises an `open_issue@1` with
source `eval`. A goal with any judgment criterion ends a clean audit round as
`evidence_missing`. Check-proven criteria complete on current green checks.

D4/D7 (#142) follow the same record. Every live guard evaluation requests
approval with reason `missing_confidence`, for clean judgments and violations
alike. The descriptive holdout diagnostic is mixed. For `guard.input`,
violation recall is 100% / 75.0% with false-block rates of 34.6% / 28.8%
(jev / amos). For `guard.output` it is 100% / 100% with 0% / 55.6%. A
probability-only guard rule would need a tune-split fit per provider, one
holdout scoring, and the captain's approval before any guard could pass
without a confidence. Deterministic D4/D7 pre-checks remain an open question
under #197. `packages/weave/test/live-confidence.test.ts` pins the D5,
completion and guard outcomes with answers shaped like tune-split rows of that
run.
