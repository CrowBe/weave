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
When reached through `decideIntake`, intake is asked only after typed extraction
and its fidelity gate; grounded hints may accompany the original, which remains
authoritative.
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
for the existing P4 gate. `decideDispatch` composes intake, D1 and D2; it may
present a dispatch intent only after an accepted observation, and only through
the injected idempotent dispatch port. The intent is checkpointed before the
call. An unconfirmed intent is returned as paused and is not re-presented
without an explicit resume; cancellation appends nothing; a stale or mismatched
answer pauses. The outcome table is now `decide1.rules@1` (below). A mapped receipt yields a
`dispatch.decision@3` entry, and fresh site observations become Weft judgment
records followed by one `dispatch.decided` after the final append. The
composition never writes `routed_input@1`.

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

## WV-S1 P4a Decide-1 rule table

`decideBand(inputs)` is pure deterministic policy over named judgments and code
facts. The frozen `decide1.rules@1` table has 15 ids; its first matching row
returns the rule id and coarse band. It imports no dispatch, site or gateway code. It asks
no new question and changes no `SITE_POLICY` threshold, fallback or request.
`decideDispatch` validates stored stages through P3a's live pure transitions,
then adapts them with `decide1Inputs` and builds the plan through an exhaustive
rule-id switch. Invalid inputs and impossible stage sets throw before a claim;
they never become an operator ask.

| Rule                  | Condition, in precedence order                              | Band           | Outcome                                     |
| --------------------- | ----------------------------------------------------------- | -------------- | ------------------------------------------- |
| `hold.admission`      | First asked stage with `stale_answer` / `mismatched_answer` | withheld       | Terminal pause at that stage                |
| `hold.outage`         | First asked stage with `decision_unavailable`               | withheld       | Resumable pause at that stage               |
| `hold.paused`         | First remaining paused stage                                | withheld       | Pause with its reason                       |
| `ask.intake`          | Intake needs human                                          | `ask_human`    | Intake ask, no intent                       |
| `ask.irreversible`    | Intake stop                                                 | `ask_human`    | Rule ask / irreversible                     |
| `ask.thread_target`   | Thread relation with no or ambiguous target                 | `ask_human`    | Rule ask / target reason                    |
| `act.thread`          | Thread relation with resolved target                        | `tool_call`    | Intake thread intent                        |
| `ask.triage`          | D1 needs human                                              | `ask_human`    | D1 ask, no intent                           |
| `act.capability`      | D1 accepted capability                                      | `tool_call`    | Capability intent                           |
| `act.done_check`      | D1 accepted done check                                      | `tool_call`    | Done-check intent                           |
| `act.decline`         | D1 accepted out of scope                                    | `tool_call`    | Decline intent                              |
| `gen.triage_fallback` | D1 transition, nonaccepted implement                        | `escalate_gen` | Implement strong/strong, triage fallback    |
| `gen.route`           | D2 transition, accepted tier                                | `escalate_gen` | Implement at that tier                      |
| `ask.route`           | D2 needs human                                              | `ask_human`    | D2 ask, no intent                           |
| `gen.route_fallback`  | D2 transition, nonaccepted                                  | `escalate_gen` | Implement standard/standard, route fallback |

Origin failures (`invalid_extract`, `extract_missing`) at D1 or D2 retain
`needs_human`, the stage choice and reason, and form no intent through
`ask.triage` or `ask.route` (D-ENG-049). Every `gen.*` row requires the
stage status to be `transition`; reversible answer fallbacks still generate.

`tool_call` is a deterministic act without generation; `escalate_gen` is a
generative implementation step; `ask_human` asks. `spawn_subtasks` remains in
the closed band vocabulary but no P4a row returns it. The plan builder rejects
it with `spawn_subtasks needs a sealed parent frame (D-ENG-044, P5)`: P4a forms
no child plan or spawn intent.

A hold row resolves its withheld band from its stage choice: intake ask/stop
and D1 needs-human withhold `ask_human`; thread relations and D1 capability,
done-check or decline withhold `tool_call`; D1 implement and D2 tiers withhold
`escalate_gen`. Merged P3a also admits stale-state pauses between stages: an
accepted intake new-thread choice then withholds `escalate_gen`. Count asks by
`status = needs_human` and escalations by `band = escalate_gen` together with
`status = dispatched`, never by band alone.

`dispatch.decision@3` carries `rule_table` and `decide1` after `reason`, and
`dispatch.checkpoint@2` stores the stages and shadow round described in P4b below.
The read partition contains judgments in stage order
(`intake.confidence`, `intake.top_p`, then D1 and D2), every available probability,
and 14 code facts in fixed order: intake decided-by, choice, status, reason,
accepted; thread target; D1 choice, status, reason, accepted; D2 equivalents.
P4b appends five shadow facts and isolated shadow judgments to the trace below.
Unasked loop stages have null facts; extraction-only intake has no judgments.
Names are unique bounded codes, probabilities are unit values, fact values are
finite scalars or screened correlation ids, and each list has at most 64 items.
The deciding rule and band are journaled alongside the table version; loaded
decisions from another table version are refused. Receipt mapping changes
status and reason, never the rule or band.

A composition freshness gate may stop before the next site has a record. Its
trace projects `stale_answer` / paused onto the last recorded stage's code
facts, preserving all underlying stage observations. Pre-ask cancellation has
an unjournaled ask-user / paused / cancelled trace with no judgments; intake's
unasked decided-by fact remains null. Cancellation appends and emits nothing.
These boundary traces are pure projections of the checkpoint and the explicit
code-gate reason, rather than a reinterpretation of a site answer.

After each successful append, fresh judgments precede one `dispatch.decided`.
The pure builder mirrors the journal trace, includes tier only for implement
and dispatch reference only for an intent, links only this call's judgments,
and cites every used stage request as inference-request evidence. Reused
stages are evidence without invented judgment links. Invalid derived ids omit
the projection without truncation or changing the decision. Sequences advance
synchronously per port before delivery. Replay, a losing compare-and-set, and
cancellation emit nothing; a failing sink cannot change the decision.

Merged P3a's single-use attempts, `present()` compare-and-set and settlement
precedence are preserved: elapsed time cannot retire an attempt, unresolved
settlements remain nonterminal `dispatch_unconfirmed`, and only an append
winner emits. A same-id concurrent loser reports the journal's owner without
appending a second entry. Durable-journal follow-up #397 remains separate.

## WV-S1 P4b Decide-1 shadow judgments

D-ENG-047 §1 supersedes the P4 split's proposed new rows: P4b asks and records
four isolated boolean judgments without changing dispatch gating. D-ENG-050
accepts the questions below as provisional, requires no sampling and permits
the single Weft contract clarification. `decide1.rules@1`, all 15 row ids,
their precedence and bands stay unchanged. Its read set remains exactly the
14 code facts and stage judgments listed in P4a above. No row returns
`spawn_subtasks`; `planFor` still requires a sealed parent frame (D-ENG-044).

| Judgment            | Fixed question (`decide1-shadow@1`)                                                         |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `clarify`           | Does this request need clarification that only the requester can give before work starts?   |
| `multi_deliverable` | Does this request ask for more than one separate deliverable?                               |
| `reads_before_gen`  | Must existing files or artifacts be read before anything can be generated for this request? |
| `veto_bare_gen`     | Would one generation call, without prior reads or decomposition, likely fail this request?  |

`askShadow` captures D1's disclosed `{ request, context }` and terms before
awaiting, then starts four concurrent `evaluate` calls through the injected
port. Each request has its own `decide1.<judgment>` site and
`<decision_id>:shadow.<judgment>` request id, role `working`, kind `boolean`,
tier `decision`, and only one `decision` question containing that judgment's
text. The state is byte-identical to D1's disclosed state. The shadow sites
use the default decision provider and add no extraction or model-site policy.
Changing a question requires a new observation schema version.

Only `act.capability`, `act.done_check`, `act.decline`, `gen.triage_fallback`,
`gen.route` and `gen.route_fallback` are eligible. The shadow round starts
after all consequential intake/D1/D2 asks and pure plan resolution, before
the existing stale gate and claim. A final hold or ask and `act.thread` ask
no shadow judgment. An eligible decision pays four decision-tier calls and
one concurrent round trip, with zero added generation calls. Each request
retains the decision's deadline, cost ceiling and maximum attempts; no timer
or elapsed-time retirement is added (D-ENG-048).

`transitionShadow` first applies admission in the existing order: cancellation,
staleness, mismatched identity, then decision unavailability. A thrown or null
outcome, a gateway pause or budget outage is `decision_unavailable`. Other
nonaccepted outcomes are `no_answer`. An accepted answer with the wrong kind,
a missing `decision` or a non-unit probability is `invalid_answer`; otherwise
it is `answered`. Unit confidence is retained when published, otherwise null.
Each failure affects only its own observation. An already-aborted signal asks
nothing and produces four cancelled observations.

`decide1-shadow@1` has exactly these ordered keys: `schema`, `site`, `question`,
`request_id`, `state_revision`, `probability`, `confidence`, `reason`,
`provider_request_id`. Its closed reasons are `answered`, `no_answer`,
`invalid_answer`, `stale_answer`, `mismatched_answer`, `decision_unavailable`
and `cancelled`. Probability and confidence are null unless answered. The
record contains fixed policy text and screened ids, never disclosed content,
provider text or error text. It has no threshold, acceptance, status or
fallback and grants no Dispatch authority.

`Decide1Inputs.shadow` is a separate partition. `decideBand` validates read
followed by shadow, with unique names across each combined list, at most 64
judgments and 64 facts, and the same code, unit-probability and scalar/id
screens. It constructs both row maps and the stage-set map from the read
partition only. The trace concatenates read then shadow in input order.
Without a shadow partition its trace equals P4a's. Even probabilities of one
cannot ask, spawn, block a dispatch or change a rule, band or Dispatch intent.

Every dispatch trace has 19 facts: the 14 read facts, then `residual_ambiguity`,
`clarify.reason`, `multi_deliverable.reason`, `reads_before_gen.reason`,
`veto_bare_gen.reason`. Residual ambiguity is the final D1 extract's count,
including the second attempt after re-extraction: zero for a grounded intent,
one for an ungrounded or empty intent, or null when D1 has no extract. It is
also shadow. Each reason fact is null when unasked, `unrecorded` when the
round was marked asked but no result was journaled, `untrusted` for an invalid
stored observation, or that observation's reason. Non-null shadow statistics
follow the stage judgments in judgment order as `<judgment>` probability,
then `<judgment>.confidence`. At most 14 judgments are present.

`dispatch.checkpoint@2` has ordered keys `schema`, `decision_id`,
`state_revision`, `state_updated_at`, `asks`, `intake`, `triage`, `route`,
`shadow`, `intent`. Its `asks` keys are `intake`, `triage`, `route`, `shadow`;
the last is zero or one. D1 and D2 store whole `loop.decision@1` records with
their extracts and site transitions. `shadow` is null or four observations
in judgment order. `dispatch.decision@3` has ordered keys `schema`,
`decision_id`, `entry`, `state_revision`, `decided_by`, `choice`, `status`,
`reason`, `rule_table`, `decide1`, `intent`, `receipt`, `intake`, `triage`,
`route`, `shadow`. Its rule table remains `decide1.rules@1`. Foreign decision
or checkpoint schemas and foreign table versions throw without compatibility
conversion.

The journal checkpoints `asks.shadow = 1` before requesting anything and
checkpoints all four results in one write after all settle. Neither resume,
replay nor unconfirmed-intent recovery re-asks a marked round. A failed
counter write propagates before any ask; a failed results write propagates
before claim. A lost round remains `unrecorded` and dispatch can proceed.
An abort during the asks passes the caller's signal, returns the existing
paused/cancelled result and writes no shadow results, decision or Weft record.
A moved state records stale shadow answers and the unchanged pre-claim stale
gate withholds dispatch. The recomputed plan must retain the original rule,
band and intent before claim, otherwise code throws
`decide1: shadow input moved the plan`.

Replay re-derives each consequential `loop.decision@1` through
`transitionLoopDecision` using its stored extracts and requires a fixed point
for the whole record. The final extract's residual count must equal its slot
list length, and that list must equal required schema slots whose statuses
are not grounded, in schema order. Invalid consequential evidence throws
before claim. Shadow trust instead checks structure without throwing: exact
keys, schema, indexed site and question, request id, revision, closed reason,
unit answered probability and optional unit confidence, null statistics
otherwise and screened provider id.
An invalid observation is dropped as `untrusted`; a shadow value that is not
an array of four makes all four untrusted. Returned decisions and Weft evidence
copy only trusted shadow observations, so dropped data cannot copy text or
suppress a valid trace. Shadow failures never gate dispatch.

`dispatch.decided` mirrors the combined trace and cites shadow request ids as
`inference_request` evidence after the stage requests. No shadow observation
emits a `judgment` record or receives a `caused_by` link: it has no policy
acceptance to report. The existing all-or-nothing correlation screen and
per-port sequence counter still apply. Claim binds the winner's checkpoint,
including its own shadow. Same-id callers may each ask one round under P3a's
pre-claim journal semantics; only the claim winner dispatches and appends.
P4b adds no journal method; #397 remains separate.

The provisional simulation floors near .35 are hypotheses for Gauge in P6:
`clarify` may later route requester-only ambiguity to `ask_human`, while
`multi_deliverable`, `reads_before_gen` and `veto_bare_gen` may later prefer
spawn to bare generation or premature capability dispatch. P4b fits no
threshold and encodes none. Promotion requires a fitted threshold, a row
change and a table bump as separate reviewable steps. D-ENG-030 still bounds
asks to irreversible work below confidence or ambiguity only the operator
can resolve; P5 still owns spawn and sealed parent frames.

## WV-S1 P2a typed extraction before intake

`decideIntake(ask, port, now, signal?)` first asks the gateway for an
`extract@1` answer, gates it against the original message, and only then asks
`intake.classify`. Extraction uses the existing generation kind `extract` at
tier `flash`; it names no provider and adds no gateway kind. The extract request
and the site request are sequential because the site depends on the hints.
Separate `decideIntake` calls share no state and may run concurrently.

An extraction schema declares span and choice slots only. There is no list kind,
so an open path or target list cannot be extracted. The intake schema
`intake.message@1` has a required `thread_ref` choice over the disclosed
`running_threads[].thread_id` values that pass `correlation()`, plus `none`, and
an optional `request` span. Thread ids that fail the correlation screen are not
options and are never recorded. A choice option set that is empty, a list kind,
or an option that fails the correlation screen is a static programmer error and
throws when the schema is built.

`parseExtract` rejects any answer whose object keys differ from the schema, whose
slot objects have extra or missing keys, or whose values are neither strings nor
null, with reason `invalid_extract`; it is also the gateway `accept`. The
deterministic `gateExtract` assigns one status per slot. A span is `grounded`
only when a non-empty value occurs verbatim in the original; null is `empty` and
anything else is `ungrounded`. A choice is `grounded` when its value is an
option and it is `none` or its non-empty cue occurs verbatim. A null value with
a grounded cue is `unresolved`, null with no cue is `empty`, a non-option is
`out_of_set`, and a non-`none` option without a grounded cue is `ungrounded`.
No admitted answer is `unread`. Matching is an exact UTF-16 substring
(`indexOf`); there is no trimming, case folding or Unicode normalization, and
the empty string is never grounded.

The `extract@1` record is `{ schema, site, extract_schema, request_id, attempt,
state_revision, verdict, reason, slots, residual_ambiguity,
provider_request_id }` in that key order. `value` is recorded only for a grounded
choice and is always null for a span; `span` is the first verbatim occurrence's
`[start, end]` offsets, or null. `residual_ambiguity` lists required slots whose
final status is not `grounded`, in schema order. A grounded answer yields
`use_hints`; an `ungrounded` or `out_of_set` answer re-extracts once and then
falls back to `original_only`; no admitted answer or a mismatched request/site
does the same. An extract outage, including a thrown port, budget, deadline or
`no_route`, is `original_only` with no reprompt and never pauses, whatever
`needs_dispatch` says. A revision change after an attempt stops as
`needs_human` / `stale_answer`, and cancellation stops as `paused` / `cancelled`;
neither asks the site.

The site always receives the original `message` and `running_threads`
unchanged. It receives `hints` only on `use_hints`, and hints contain only
grounded values. On `original_only` the site state is byte-identical to the
direct `evaluateSite` state. When the final verdict is `use_hints`, `thread_ref`
is `unresolved`, and at least two threads are running, the decision is
`decided_by: 'extract'`, `choice: 'ask_user'`, `status: 'needs_human'`, reason
`ambiguous_reference`, and the site is not asked. With fewer than two threads
the site decides from the original and the residual ambiguity stays on the
record. Extract failure never pauses dispatch-dependent work; the site's own
outage still follows the existing rule. The decision record is
`{ schema, request_id, decided_by, choice, status, reason, extract, site }` in
that key order, holds one or two extract observations in attempt order, and
carries no grant, scope or dispatch field.

`transitionIntake(ask, recorded, current)` rebuilds the same record from
`{ extracts, site }` recorded outcomes with no port. Replay throws on more than
two recorded extracts or a duplicated attempt, so it cannot invent one. Records
copy no message text, extracted text, provider text or thread summaries; ids
pass `correlation()` and credential-shaped ids are omitted.

## WV-S1 P2b typed-state origin before every site

Every `SiteInput` declares an `origin`. Free-text sites (`intake.classify`,
`input.route`, `loop.triage`, `loop.route`) require `{ kind: 'model', extract }`,
where `extract` is an `extract@1` observation for that exact site, input
revision and request. The extract's `request_id` must be the input's
`request_id`, or that id with intake's `:x<attempt>` suffix for its own
`attempt`; a record that belongs to another request is never reused, even at
the same site and revision. Structural sites require
`{ kind: 'structural', source }`:
`progress.delta@1` for `loop.continue`, `audit.findings` for `audit.dispose`,
and `criteria` for `eval.output`. `modelOrigin`, `structuralOrigin` and
`originReason` are the small constructors and validator.

A missing model record is `extract_missing`; a non-model, wrong-site,
foreign-request, malformed or revision-mismatched record is `invalid_extract`;
a structural site
with the wrong source is `structural_origin_missing`. Each fails before the
provider call. The observation records `answer: null`, `confidence: null`,
`top_p: null`, `accepted: false`, `fallback_used: true`, and status
`needs_human` (cancellation still pauses). Composition roots that already hold
the structural evidence may supply the origin (`decideProgress`,
`evaluateAuditDispose`, `evaluateOutputEval`); a caller-supplied origin is never
replaced. The pure replays `transitionAuditDispose` and `transitionOutputEval`
apply the same default to an input without an origin, so a recorded answer
replays as it was decided live; a supplied wrong or `null` origin fails closed in
both. `decideIntake` supplies the final gated extract record. `decideRoute`
accepts a gated `extract` on `RouteAsk`; without it, routing across active work
fails closed and asks the operator.

The model-extract schemas are `input.route@1`, `loop.triage@1` and
`loop.route@1`, each a required verbatim `intent` span. They add no new gateway
kind: extraction still uses `extract` generation at tier `flash`, and the
fidelity gate is unchanged.

`checks/extract-before-site.mjs` is the source-shape guard: a runtime call that
names a free-text site must show a model origin, and one that names a structural
site must show a structural origin. The runtime validator remains authoritative;
the check catches a missing call-site origin before tests run.

## WV-S1 P2c extract-composed decisions for loop.triage and loop.route

`decideTriage(ask, port, now, signal?)` and `decideLoopRoute(ask, port, now,
signal?)` mirror `decideIntake` for D1 and D2. They capture the disclosed state
before the first await, run `attemptExtract` once with `loop.triage@1` or
`loop.route@1`, re-extract at most once with fixed feedback when the first
extract says `re_extract`, then ask the choice site through `evaluateSite` with
`modelOrigin(finalExtract)`. The original state is the canonical JSON of the
disclosed state, and the extract prompt carries that same state. Extract
requests use `<request_id>:x1` and `<request_id>:x2`; the site request keeps the
caller's `request_id`. The extract generation site is `loop.triage.extract` or
`loop.route.extract`.

The site is never asked with a missing, non-final, cancelled or foreign extract.
A missing final extract is `extract_missing`; a wrong schema, wrong site, wrong
revision, foreign request id or remaining `re_extract` verdict is
`invalid_extract`; cancellation is `paused` / `cancelled`. Those paths fail
closed with no provider choice call, as the runtime origin gate already does for
a direct `evaluateSite`. An unfaithful second attempt becomes `original_only`
and still asks the site from the unchanged original, as intake does.

The returned `loop.decision@1` record is `{ schema, request_id, extracts, site }`
in that key order. `extracts` holds one or two text-free `extract@1`
observations in attempt order; `site` is the full `SiteTransition`, including
its `decision-site@1` observation. Records copy no disclosed state, extracted
text, provider text or credential-shaped ids. `transitionTriage` and
`transitionLoopRoute` rebuild the record without a port from recorded extract
observations or recorded extract outcomes and an optional recorded site answer
or transition, and fail closed the same way. They throw above two extracts, on a
non-consecutive attempt, or when a second extract lacks the live `re_extract`
precondition, so replay cannot invent an attempt. A recorded site transition is
reused only when its `decision-site@1` observation is fresh against `current`
and matches the requested site, request, revision and fixed question. The one
exception is a validated cancellation, which is preserved even when the state
has moved because cancellation always pauses. An
accepted observation must also carry an option answer, reason `accepted`,
`fallback_used: false`, confidence at or above the site floor, the triage
selected probability at or above .6, no tier, and the status its answer implies.
A fallback must use the site's fallback choice, the tier `strong` for triage and
null otherwise, and the status implied by its reason: cancellation always
pauses, a dispatch-dependent outage pauses, and a read-only outage keeps the
fallback status. Otherwise replay rebuilds the transition without trusting the
record, so a stale record follows the same `stale_answer` path as a recorded
answer and a malformed or foreign record fails closed as `needs_human`.

`decideLoopRoute` is separate from `decideRoute` (`input.route`); the latter's
contract and name are unchanged. Neither loop composition dispatches, grants
authority or edits the P2b origin schema. Provider independence is preserved:
both use only the injected `generate` and `evaluate` ports and the injected
`now`.

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
before that margin gate. D4/D7 keep the .90 floor on a published confidence; a
published non-unit (out of [0, 1]) confidence there remains
`missing_confidence`. An absent confidence on D4/D7 now decides through the
fitted probability-only band: p >= .5 for `guard.input` and p >= .4 for
`guard.output` is a `violation` (`block`), otherwise `accepted` (`pass`); a
clean rule still passes on the site transition and a violation still asks for
approval before the effect runs. An absent confidence with a missing or
malformed probability remains `missing_confidence`. Decide is the
deterministic threshold. See "Fitted probability-only band (#142, #198, #383)"
below for the fit.
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

Each generation run takes a fresh opaque value from the injected `runId` port, as time comes from `now`; Loom draws no ambient entropy (`checks/no-ambient-entropy.mjs`). A 128-bit digest over that value and the full generated-text digest is the check-run identity in every check invocation id, `<execution>:a<N>:<check-run>:<check_id>`. Each check record keeps the host's `invocation_id` (null when the host rejected the check or reported an unbounded id). Every step-built id keeps its readable `<execution><suffix>` form within the 128-character correlation limit; a longer one uses a bounded execution prefix plus the full execution digest, as audit request ids do. The port must not repeat a value for one execution, including across restarts, and an invalid value stops the step before generation. Checks request `reject_existing` from the capability host: if a value repeats and recreates a recorded or active invocation id, the host must reject it rather than replay an earlier result. The rejected check fails closed. Hosts implementing this interface must honor that option; normal invocations retain their replay semantics. Recovery may regenerate an unfinished attempt, but its checks must execute again: neither a different output nor identical text from a workspace-editing backend may reuse committed checks from a prior generation run. The execution id and attempt number remain stable; finished attempts are still skipped. Check evidence belongs to that generation run and its recorded `gen_` artifact. Generate backends are responsible for applying workspace edits; the step does not apply generated text. This assumes a single writer controls the workspace during generation and checks.

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
condition.

The audit loop decides each round's progress itself, after the cancellation,
budget, authority and decision-outage stops and before the no-progress stop
and the audit call. The previous tidy state is the previous round's
checkpointed observation; the first round has none and asks D8. D8 is asked
with the request id `<execution>:r<round>[:e<entry>]:progress`, discloses
`{ audit: <tidy state> }`, and never pauses on an outage (`needs_dispatch`
false), so an outage takes the `stalled` fallback. The record is checkpointed
with the round's capture, so recovery reuses it instead of asking D8 again,
and it is stored as the round's `progress` (null when none was decided,
absent on legacy rounds). A legacy capture that holds an unconfirmed dispatch
and no record pauses as `audit_unconfirmed` without asking D8, so recovery
spends nothing first. The no-progress history is the choices recorded on
earlier rounds that returned to Observe, plus this round's; the Observe port
no longer supplies it. Two consecutive rule-decided `stalled` rounds therefore
stop as `no_progress`, while a decision outage cannot turn a round the rule
decides into a fallback.

Cancellation is checked before the rule decides (#244). An aborted signal
skips the rule: `decideProgress` takes D8's path, which makes no call and
records a `paused` cancellation, and `transitionProgress` keeps a cancelled D8
transition over the rule on replay. The loop records no progress for a
cancelled round, so it counts toward no history.

The equal-digest shortcut compares evidence only. When the criterion ids are
unchanged but a criterion is re-bound (different `check_ids` or `proof`) and
the checks, evals and artifacts are identical, the rule still answers
`stalled`. This errs conservative: re-binding a criterion without new evidence
is not progress, and the next round with new evidence decides again (#244).

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
2. A probability-only D5 rule with a stricter band. Applies from the tune fit
   recorded below (5 Nov 2026). At the time of this record it did not: the only
   evidence was the report's descriptive holdout diagnostic (83.3% violation
   recall at P(violation) >= .3 for both providers, on 12 holdout items each;
   about one unsatisfied criterion in six would pass), a holdout figure cannot
   fit a threshold, and no tune-split fit existed yet: the 12 tune items per
   provider ended `minimum_coverage_unmet` because the tune split came from the
   same confidence-less providers.
3. Per-provider calibration from P10 before any rule change. Deferred; it is a
   prerequisite of option 2 and needs a tune split with enough judgment
   criteria per provider. The recorded Brier .070 / .083 and ECE .075 / .096
   (jev / amos, 12 items) are descriptive only.

Under this rule a live-shaped D5 answer fails its criterion with
`missing_confidence` and keeps its probability as `verdict_probability`. The
implementation step retries, escalates once and raises an `open_issue@1` with
source `eval`. A goal with any judgment criterion ends a clean audit round as
`evidence_missing`. Check-proven criteria complete on current green checks.

D4/D7 (#142) follow the same record. At the time of this record every live
guard evaluation requested approval with reason `missing_confidence`, for clean
judgments and violations alike. The descriptive holdout diagnostic is mixed.
For `guard.input`, violation recall is 100% / 75.0% with false-block rates of
34.6% / 28.8% (jev / amos). For `guard.output` it is 100% / 100% with 0% /
55.6%. A probability-only guard rule would need a tune-split fit per provider,
one holdout scoring, and the captain's approval before any guard could pass
without a confidence. Deterministic D4/D7 pre-checks remain an open question
under #197. `packages/weave/test/live-confidence.test.ts` pinned that record.

## Fitted probability-only band (#142, #198, #383)

Recorded 5 Nov 2026 from the `live-20261015` tune split (the tune evidence of
#327). The confidence gates are unchanged: a published confidence still needs

> = .90 on D4/D7 and >= .90 per D5 criterion, and a published invalid confidence
> still fails closed. Only the absent-confidence path changes, and only when the
> answer carries a valid probability:

- D4 `guard.input` and D7 `guard.output`: P(violation) = p. p >= .5
  (`guard.input`) or p >= .4 (`guard.output`) is a `violation` — the
  observation says `block` and the transition still requests approval. Below
  the cutoff the observation is a clean `pass` and the transition proceeds
  without an approval request.
- D5 `eval.output`: P(violation) = 1 - P(satisfied). P(violation) >= .5 blocks:
  the criterion fails as `below_probability` (not `missing_confidence`) with
  verdict_probability. Below it the criterion passes at any p; published
  confidence floors are untouched.
- Missing confidence together with a missing or malformed probability, and
  invalid or missing confidence from any other unreadable shape, remains
  `missing_confidence` fail-safe on D4/D7/D5.

Fit, on the pooled tune-split rows of `typesafe-jev` and `amos-small` (one
terminal call per binding; P(violation) as above): the candidate cutoffs swept
block thresholds above the descriptive .3 and required at least a 25% relative
reduction in false-block rate versus .3, then maximised violation recall and
preferred the cutoff nearest .5 among ties. That selects `guard.input` .5
(violation recall .9167, false-block rate .2115, n = 128 questions),
`guard.output` .4 (recall 1.0, false-block .1111, n = 36), and `eval.output`
.5 (recall .9167, false-block 0, n = 24). All clear the .5 tune coverage floor.
The holdout was not read for the fit; the committed holdout report is
evaluation-only evidence re-rendered under the resulting thresholds.
`packages/weave/test/live-confidence.test.ts` pins the new D5, completion and
guard outcomes with answers shaped like tune-split rows of that run.
