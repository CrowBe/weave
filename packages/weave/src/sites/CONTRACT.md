# P5 choice sites

`evaluateSite(site, input, port, current, signal?)` captures a disclosed state,
asks one `choice` question named `decision`, then calls the pure
`transitionSite(site, input, recorded, current)` rule. `current()` is injected
and read after await, so a revision change in flight rejects the answer.
`recorded` contains the gateway outcome, state_revision and observed_at.
Input contains request_id, state_revision, state_updated_at, state and terms.

D1 requires confidence >= .80 and selected probability >= .6, with the selected
option at the maximum of a valid distribution. Fallback is implement with strong
as the safest tier (provisional interpretation: quality safest, still subject to
budget/authority). D2 requires .75, fallback standard. D8 requires .70, fallback
stalled. Intake requires .80 (provisional, until P10 calibration), fallback
ask_user / needs_human. Intake state contains a disclosed message and running
thread summaries; classification grants no authority to interrupt or dispatch.

An answer from a different revision, or observed before the current state's
update, is stale. Request id/site must match. Nonaccepted outcomes and exceptions
fall back; unavailable provider or thrown port pauses dispatch-dependent steps.
Read-only steps may use deterministic fallback. Cancellation always pauses.
No returned transition dispatches or authorizes execution. D2's tier is a ceiling
for the existing P4 gate.

Records use schema decision-site@1 and fixed keys. Record only closed-vocabulary
answers, numeric statistics and safe correlation identifiers, never raw state,
provider error details, arbitrary answers or distribution keys. Questions are
fixed text. Correlation identifiers are bounded opaque identifiers; recognizable
credential prefixes are omitted. No generic secret detector can sanitize arbitrary
operator content, so that content is never copied into the record.

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
unknown. Any published invalid confidence, on any entry, is `invalid_confidence`
and the full index. That includes a boundary entry, a non-boundary entry, a
required entry, and the case where nothing is excluded. D4 and D7 do not use
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
object. The step does not invoke a wider grant and does not consume the
template. A decision answer cannot mint a grant. The step then runs D5. Check
evidence is `{ check_id, argv_digest, exit, passed, tail, artifacts, invocation_id }`. Eval
evidence is `{ criterion_id, verdict_probability, confidence, passed }`. A red
check fails the attempt even when D5 passes. The step retries the same tier up
to N times (default 2), then escalates one tier once, never past the D2 ceiling.
A budget downgrade stays at or below the requested tier. A budget pause or a
blocked escalation does not mint a grant and does not complete the goal.
`goal_done` is false. The terminal blocker is `open_issue@1`:

```text
{ schema, issue_id, execution_id, source: 'check'|'eval', criterion_ids,
  check_ids, text, severity: 'blocker', blocked_by: 'ceiling'|'budget'|null }
```

Finished attempts are `impl.attempt@1` records under one `execution_id`, linked
by `id` and `parentId`, appended before the next attempt. A stop is
`impl.stop@1` and carries the open issue. A torn final line is repaired on
load and append: an unparseable tail is truncated, and a complete record
missing its newline is terminated, so a finished attempt is not lost and the
journal stays loadable. Replay reads that journal and does not call a provider.
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
Amos readiness uses GET `/v1/models`.
An unreachable service, non-2xx health response or timeout produces a typed
unavailable failure and gateway `provider_unavailable` evidence. Intake then
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
