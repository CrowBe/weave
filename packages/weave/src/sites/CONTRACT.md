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
Transport, persistence, full-loop integration and D3/D4/D7 implementation remain
outside this contract. ScriptedDecisionLayer remains unchanged.

## P6 boolean sites

D3 receives only the already-disclosed M6 index (id/purpose), never schemas.
Questions use ordinal ids `entry_N`; successful selection sorts descending by
probability then by original disclosed order, includes p >= .5, and caps at 8.
Any missing, malformed, uncertain, stale or unavailable required answer returns
that entire index. Unknown question ids are ignored and recorded as a count of
fixed-text observations, never their names. Empty indexes need no evaluation.

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
