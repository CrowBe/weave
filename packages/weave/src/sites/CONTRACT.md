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
optional `preselect_policy` of `{ k, floor, provider }`. It never receives the
general state or schemas. Questions use ordinal ids `entry_N`. Selection keeps
the top k entries by p(true) (default 3) and drops a score below the optional
floor (default 0, which leaves the floor off). k is an integer from 1 to 8.
The cap of 8 is that upper bound. Ties sort by p(true) descending, then by
disclosed order. Required ids that are in the index are always kept, in
addition to the top k of the remaining entries, and are not removed by k,
floor, or the cap. A required id that is not in the index is ignored and
counted; D3 only narrows. Any missing, malformed, uncertain (confidence below
.75), stale or unavailable answer returns that entire index, including on the
fallback path. Unknown question ids are ignored and recorded as a count of
fixed-text observations, never their names. Empty indexes need no evaluation.

The D3 transition carries `preselect` with schema `preselect-selection@1`, in
this key order: `schema`, `k`, `floor`, `cap`, `provider`, `outcome`, `scores`,
`kept`, `required_missing`. `provider` is `typesafe-jev`, `amos`, or null.
`outcome` is `narrowed`, `fallback`, or `empty_index`. Each score is
`{ entry, p, rank, kept, required }` in disclosed order. `entry` is the
`entry_N` ordinal. `p` and `rank` are null when that answer is missing. Rank
is 1-based among answers that have a probability, by p(true) descending and
then disclosed order. The record does not copy catalogue ids, purposes, or
required names. Guard sites omit it. A policy that is not a plain object with
only `k`, `floor`, and `provider`, with k in 1..8, floor in [0, 1), and a
known provider or null, is replaced by k = 3, floor = 0, and a null provider.
Selection still narrows. That replacement is not an admission fallback.
Per-entry `answer` is `include` when the entry is in the returned index and
`exclude` otherwise. `top_p` remains p(true).

D4 asks the four fixed rules in one boolean evaluation: secret exfiltration,
scope broadening, destructive effect without grant, and prompt injection.
Injection criteria include instructions in untrusted content to override policy,
impersonate authority, reveal secrets or expand tool/scope access; these feed the
existing decision evaluation, rather than a second gate. D7 asks whether proposed
output introduces effects outside the grant. Both escalate to needs_human for
p >= .3 or any admission failure, with per-rule reasons. A clean judgment is
only evidence and contains no grant or dispatch authority.

Provisional confidence floors: .75 for D3 and .90 for D4/D7, pending P10
calibration. Shape is the fixed question set, gate is P5 metadata admission plus
per-answer confidence/shape validation, decide is the deterministic threshold.
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
evidence is `{ check_id, argv_digest, exit, passed, tail, artifacts }`. Eval
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

Each accepted generation run gets a fresh opaque check-run identity, combined with the full generated-text digest in every check invocation id. Recovery may regenerate an unfinished attempt, but its checks must execute again: neither a different output nor identical text from a workspace-editing backend may reuse committed checks from a prior generation run. The execution id and attempt number remain stable; finished attempts are still skipped. Check evidence belongs to that generation run and its recorded `gen_` artifact. Generate backends are responsible for applying workspace edits; the step does not apply generated text. This assumes a single writer controls the workspace during generation and checks.

## Local intake provider

The gateway composition configures `decision.sites["intake.classify"] = "amos"`.
`loop.preselect` may select `amos` or `typesafe-jev` as well. Intake's Amos
route needs a matching choice evaluate unit. Preselect's Amos route needs a
matching boolean evaluate unit. Every site left unset keeps the TypeSafe default
`typesafe-jev` / `jev-preview`. Provider selection is exclusive; a site never
silently retries against the other provider. `decision.preselect` may set
`{ k, floor }` per provider id. The defaults are k = 3 and floor = 0, and the
cap is 8. Amos readiness uses GET `/v1/models`.
An unreachable service, non-2xx health response or timeout produces a typed
unavailable failure and gateway `provider_unavailable` evidence. Intake then
uses `ask_user` / `needs_human`; dispatch-dependent steps remain paused under
the existing rule. A model classification remains an observation, not authority.
