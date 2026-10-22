# Uncertain invocation recovery (WV-035, WV-035b, DEC-015)

An invocation that may have produced effects is never inferred stopped from a
missing result. Start records retain canonical effect scopes before execution.
An uncertain result, including a failed result write, attempts a validated,
journalled uncertain mutation. If that append fails, the settled in-memory entry
remains authoritative for this host; recovery treats the interrupted start as
uncertain. Neither case permits repeating the invocation id.

When an admitted implementation or shell operation throws synchronously, rejects
asynchronously, or returns a malformed outcome, declared writes mean the outcome
is uncertain: execution may already have produced effects. The host attempts the
same durable uncertain marker and retains the entire reservation until
reconciliation. An explicit, valid failed outcome keeps its existing stopped
semantics. With no declared writes, implementation faults and malformed outcomes
still settle stopped and release the reservation. Cancellation racing a fault
records the cancellation request but cannot turn uncertainty into stopped or
settle the invocation twice. Re-invoking an uncertain id, including after restart,
replays the outcome without running the implementation again.

Uncertainty retains the entire reservation when any declared effect is create,
write, append or delete. With only read/discover effects, or no effects, it
releases immediately. Recovery reconstructs the same reservation independently
of whether the implementation is currently installed. Old records remain
readable; interrupted old records also require reconciliation.

Recovered reservations are cumulative, even when legacy interrupted invocations
conflict. Construction retains every hold and treats each invocation as uncertain;
reconciling one owner cannot release another owner's hold. If an old record has
neither stored scopes nor a usable effect contract, construction still succeeds.
New invocations of that operation are blocked until all such records are
reconciled, including when the contract is installed later. Other operations
remain available. Recovery attempts to persist uncertainty, but a failed marker
write cannot prevent construction or release its protection.

The trusted host owner calls `reconcile(id, resolution)`. This is a control-plane
API, unavailable to resolver contexts, and does not grant execution authority.
Resolution is either `{ resolution: 'committed', evidence: string, output }` or
`{ resolution: 'not_committed', evidence: string }`. Evidence must be nonempty;
committed output must be JSON-persistable. A validated reconciliation mutation
records evidence and a terminal outcome before releasing reservations and
removing the retained in-memory entry. Unknown ids, active runs, invalid
resolutions and repeated reconciliation are refused without changing state.
Failed writes leave uncertainty and reservations intact. A committed journal
append remains authoritative even if later compaction fails.

Lookup continues to use AgentSOP's `unresolved` status for uncertainty. A durable
publication receipt may reconcile automatically through the same durable gate.
A legacy `stopped` record with a durable publication receipt resolves as committed
on lookup: the receipt is authoritative evidence of publication, and does not
require the uncertainty-only reconciliation transition. Once an invocation result
is durably committed, a later result-write failure settles as committed and
releases its reservation; it cannot downgrade that evidence to uncertainty.
Cancellation requests do not resolve uncertainty or undo a reconciliation. The
API is synchronous, so cancellation requested before reconciliation begins is
retained; cancellation during reconciliation cannot overwrite the terminal
resolution or cancel recording an observed fact. Re-invocation only
replays an uncertain or reconciled outcome and never renews a single-use grant.
The invocation id belongs to its recorded action: prepare, like lookup, refuses a
grant naming another action before replay, receipt reconciliation, or consuming
the grant.

Assumption: evidence and committed output supplied by the trusted host owner
accurately describe the external outcome; Fabric validates and records them but
does not independently inspect arbitrary external systems.
