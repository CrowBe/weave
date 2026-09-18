# OpenClaw and Hermes: operational lessons for Weave

Research date: 2026-09-18. Read against `VISION.md`, `CONTEXT.md`, and
`ARCHITECTURE.md`. External findings below are verified against current first-party
documentation, not a checkout or runtime test. URLs are live documentation rather
than pinned releases; implementation parity and historical versions remain unverified.

## Conclusion

Keep Weave's architecture. Borrow operational contracts and failure scenarios from
these systems, especially around durable input, execution ownership, cancellation,
recovery, bounded context, and delivery. Their model/tool loops and writable skills
are not substitutes for Weave's action frontier or AgentFabric admission.

Most of the important invariants already appear in Weave's architecture. The useful
next step is to turn them into M1 acceptance cases, not add a general gateway,
multi-agent framework, memory platform, or plugin ecosystem ahead of the slices.

## Findings and recommendations

### 1. Persisting intent is different from replaying authority

**Verified external behavior.** OpenClaw documents accepted user input being stored
before acknowledgement. Its in-memory queue is not replayed after restart; input
durability does not preserve execution permission. Recovery uses retained receipts,
current authentication and fresh admission; consumed input is not resubmitted merely
because output persistence failed. Terminal PTYs do not survive the gateway process.
Sources: [command queue](https://docs.openclaw.ai/concepts/queue#input-durability),
[restart recovery](https://docs.openclaw.ai/gateway/restart-recovery).

**Recommendation for M1.** Distinguish observation acceptance, action start, external
effect outcome, and result delivery. Retain stable invocation identity and reconcile
unknown outcomes before retrying. Test crashes before dispatch, after effect commit
but before result recording, and after result recording but before delivery. A
persisted action candidate must still pass current authority and read-set checks.
This concretizes ARCHITECTURE sections 2 and 5; it does not require adopting OpenClaw's
storage layout or resume rules.

### 2. Serialize state ownership, not all useful work

**Verified external behavior.** OpenClaw uses a session lane plus bounded global
lanes. Runtime switches use the same session lane to avoid competing execution.
Steering leaves already-running tools in flight, and queued cancellation has its
own ownership and identity checks. Its background scheduler does not occupy the
capacity needed by the child it awaits.
Source: [command queue](https://docs.openclaw.ai/concepts/queue).

**Recommendation for M1.** Give state transitions a clear owner/atomic boundary,
while allowing compatible actions to execute concurrently under effect locks.
Reserve capacity for cancellation, result recording, and reconciliation even when
execution slots are saturated. Test cancellation racing with queued dispatch and
late results, and ensure waiting parents cannot exhaust child execution capacity.
Do not import session-wide serialization as the scheduler: that conflicts with
Weave's arrival-driven action frontier.

### 3. Execution completion and delivery completion are different

**Verified external behavior.** OpenClaw tracks subagent completion delivery and
distinguishes a result queued for delivery from a delivered result. Restart recovery
can continue an admitted parent completion without rerunning the child, while
retaining the original completion identity.
Sources: [subagent command](https://docs.openclaw.ai/tools/subagents/slash-command),
[restart recovery](https://docs.openclaw.ai/gateway/restart-recovery).

**Recommendation.** When the report acquires an external delivery surface, keep
report production and delivery as separate actions/outcomes. An unavailable UI or
lost acknowledgement must not rerun publication. Use the capability's actual
idempotency/reconciliation guarantee; never infer exactly-once delivery from a
durable local log alone.

### 4. Treat context as a bounded rendering, with explicit freshness

**Verified external behavior.** Hermes stores session metadata and message history
in SQLite, including compression lineage. Memory is a bounded curated store,
injected as a frozen session-start snapshot to preserve prefix caching; writes
persist immediately but do not replace that snapshot mid-session. Oversized writes
fail instead of silently removing entries. Skills load in stages: catalog, document,
then individual reference file.
Sources: [sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions),
[memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory),
[skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills#progressive-disclosure).

**Recommendation for M2/M4.** Keep recorded observations, state, and state views
distinct. Start with one deterministic context profile carrying a manifest,
revisions, budget and disclosed omissions. Fetch details only when needed. Measure
context cost without sacrificing freshness: stable prefixes can be cached, but
changed authority and relevant dependencies must invalidate decisions. Memory
summaries remain evidence, not silently promoted facts or permissions. The existing
Slice, Read set, Cached conclusion and Durable knowledge terms already cover this.

### 5. Learn reusable procedures without confusing them with admitted software

**Verified external behavior.** Hermes supports agent-authored skill documents and
`/learn` from supplied material, with progressive loading of references. Its skill
mechanism is a knowledge-document workflow; its agent loop assembles prompts,
dispatches tools and handles compression and provider fallback.
Sources: [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills),
[agent loop](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop).

**Recommendation for M3–M5.** Capture repeatable procedures and failure knowledge
early, but classify them honestly. A useful skill may supply a proposed composition,
contract or optimisation candidate; it is not admission evidence. Crystallization
still requires validated corpus, observed red, deterministic green, containment and
separate execution authority. Track unsuccessful attempts as well as successful
traces so the optimiser does not learn only from survivors.

### 6. Copy concrete trust boundaries, not another product's trust assumptions

**Verified external behavior.** OpenClaw explicitly assumes a trusted operator/team
per gateway rather than hostile tenancy. Hermes separates command approval from
container isolation and warns that command-pattern matching is not OS containment.
Its documented default smart approval uses an auxiliary model to classify command
risk; unattended dangerous-command prompts default to denial.
Sources: [OpenClaw security](https://docs.openclaw.ai/gateway/security),
[Hermes security](https://hermes-agent.nousresearch.com/docs/user-guide/security).

**Recommendation for M1/M3.** Preserve deterministic policy and an enforcing host.
A model risk assessment can be an observation, never permission to bypass a hard
boundary. Test approval identity, scope, expiry and revocation against exact bound
effects. Inspect actual host filesystem/network/credential constraints before
running untrusted code. Copying a command denylist or a "sandboxed" backend label
would not establish Weave's declared-effect guarantee.

## Suggested next contract additions

Before M1 implementation, include deterministic failing checks for:

1. Effect committed, acknowledgement lost: recovery reports uncertainty or reconciles;
   it never silently duplicates publication.
2. Approval revoked while queued: dispatch is denied, even after restart.
3. Cancellation during effect: reservations remain until outcome reconciliation;
   late evidence remains recorded.
4. Full execution capacity: control-plane cancellation/results still progress.
5. Produced report, failed delivery: retry delivery without repeating production or
   publication effects.

For M2, prove a bounded state view can disclose truncation and detect invalidated
dependencies before using a model judgment. For M3, explicitly demonstrate that a
learned procedure is still unadmitted. None of these findings demands a vision change.
