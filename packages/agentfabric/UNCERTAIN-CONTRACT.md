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

For shell operations, a successful process spawn establishes that execution
started. A subsequent timeout, cancellation (including an abort), or signal kill
with declared writes settles uncertain, persists the same durable marker, and
retains the entire reservation until `reconcile()`. The recorded reasons are
`timeout`, `cancelled`, and `killed`. Without declared writes,
these interruptions remain stopped and release their reservation. Cancellation
before spawn and genuine spawn failures also remain stopped, including when an
immediately expiring timer races a spawn failure or trace recording subsequently
fails. A trace fault cannot invalidate observed evidence that execution never
began.

Execution and host bookkeeping faults, including snapshotting after the run,
artifact issuance, and trace recording, use `execution_fault`, never
`spawn_failed`. Pre-start CLI bridge rejections (including start persistence
failure and an unavailable implementation) also use `spawn_failed`, since no
execution began. A trace fault while recording an observed timeout, cancellation,
or kill retains that interruption's reason. In shell execution, `spawn_failed`
describes only a genuine failure to spawn. The existing conservative exception remains: a fault
while taking the initial snapshot before spawn settles uncertain with declared
writes and retains the reservation, even though no process has started. Shell
traces distinguish `timeout`, `cancelled`, `killed`, and `execution_fault`;
durable invocation outcomes carry the uncertainty reasons and replay them after
restart. A crash before or during the marker append recovers from the durable
start as uncertain; a complete marker also preserves the specific reason.
The `shell.run@1` contract revision is `r2`, as are its repo-derived contracts.
Traces, failed outcomes and new uncertain outcomes share the `SHELL_FAILURES`
vocabulary. Stored `r1` admissions and outcomes, including old `shell_*`
uncertainty reasons, remain readable and replay without rewriting evidence.

Uncertainty retains the entire reservation when any declared effect is create,
write, append or delete. With only read/discover effects, or no effects, it
releases immediately. Recovery reconstructs the same reservation independently
of whether the implementation is currently installed. Old records remain
readable; interrupted old records also require reconciliation.

For a legacy invocation without a saved reservation, recovery uses its saved
`implementation_id` to find the stored admission for that operation and binds
the effects from that admission's contract revision. It never substitutes the
newest live or historical contract. Multiple matching admissions must agree on
contract revision and effects; otherwise that evidence is ambiguous.
Missing implementation identity, admission, unambiguous revision/effects,
or usable selectors leaves the invocation uncertain with an unscoped block on
that operation until reconciliation. Saved canonical reservations remain the
preferred recovery evidence, independent of installed contracts.

Recovered reservations are cumulative, even when legacy interrupted invocations
conflict. Construction retains every hold and treats each invocation as uncertain;
reconciling one owner cannot release another owner's hold. If an old record has
neither stored scopes nor a usable effect contract, construction still succeeds.
This includes legacy interrupted built-in `shell.run@1` and `report.publish`
records: a built-in's current contract is not recovery evidence. They block the
whole operation until each invocation is reconciled.
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

Legacy revision assumption: matching admissions identify one contract revision
and effect declaration. Legacy invocation records have no separate contract
revision field; ambiguous admissions provide no usable recovery evidence.

## CLI generation recovery (Firstmate option B)

CLI generation retains its declared workspace write. `createGrantedCliSpawn`
uses the host's CLI generation entry point and host-owned invocation identities,
which remain distinct across bridge instances and avoid recorded identities
after restart. The validated durable
start record includes `cli_generation`, with `cwd_ref` and `before_snapshot`.
After spawn, a validated, immutable positive `pgid` is appended before subsequent
bookkeeping; missing pgid is unknown, never gone. The host captures a bounded
content digest asynchronously before execution while holding the workspace
reservation. It includes hidden entries, arbitrary nesting, file bytes, size,
mode, entry type and symlink targets. Device, inode, ownership and timestamps
only detect races within one inspection; they do not affect equality across
inspections. Symlinks are recorded, never followed. `.git` directories exclude
only objects and logs; refs, config, hooks and other Git state remain included.
A `.git` file (gitdir indirection, including worktrees and submodules) makes the
snapshot unavailable (`null`), because the referenced Git state is not inspected.
Files are hashed in chunks with a default total content limit of
64 MiB and 10,000 entries (including directories and symlinks). Exceeding either
limit, special files, or failed inspection records `null`, which cannot authorize
automatic reconciliation. Large repositories exceeding 10,000 entries or 64 MiB
therefore need operator reconciliation with `--force-with-evidence` and nonempty
`--evidence` to release their hold. Snapshot evidence cannot be replaced by result,
uncertainty, or reconciliation mutations. The pgid is recorded once and cannot
subsequently be replaced. Failed pgid persistence leaves execution uncertain;
missing process evidence prevents automatic release.

The spawn result and gateway adapter return explicit `uncertain` status with
`invocation_id` and reason. The gateway records that disposition and stops without
retry or fallback, including when cancellation races process settlement. A new
generation rejected by an uncertain reservation returns a nonretryable
`workspace_held` failure with `held_by` naming the uncertain invocation. A conflict
with active execution is `effect_conflict`. Neither is a spawn failure.

On host construction, after recovering reservations, the host inspects each
uncertain CLI generation. Only a saved process group confirmed gone
(`process.kill(-pgid, 0)` throws an error with code `ESRCH`) together with equality with its saved
snapshot reconciles
as `not_committed` through the ordinary validated durable gate, then releases the
hold. A changed workspace remains uncertain and is surfaced as `workspace_changed`.
Missing or incomplete snapshot evidence is `snapshot_unavailable`; other check
or persistence failure is `check_failed`. Construction continues and retains the hold in all these cases.
Live or uninspectable groups remain held with `process_group_alive` or
`process_group_unknown`. The same check runs immediately after an in-process
termination settles uncertain, before returning its result; a safe unchanged
workspace is released without restarting. The returned result is a
failed interruption with its original `cancelled` or `timeout` reason when the
durable reconciliation confirms `not_committed`. Failed reconciliation retains
the uncertain result and hold.
It never infers `committed`. All inspection is in Fabric's host layer; gateway
and Loom remain pure. Keep the host journal outside the inspected directory if
automatic equality reconciliation is desired: journal appends are also changes.

The trusted operator uses `host.listUncertainCliGenerations()` and
`host.reconcileCliGeneration(id, resolution)`. These APIs disclose reference,
invocation identity, reason and startup-check status, not argv, prompts,
environment values or locators. They use the same append-before-release gate as
`reconcile`: failed persistence, lost locks and reentrant reconciliation retain
state and holds. Reconciliation racing a new generation cannot release an active
generation's hold. Legacy `shell-cli:` records are also listed and can be
reconciled, but without saved snapshot evidence require operator resolution.

The local operator command uses these exported host functions:

```sh
node --experimental-strip-types examples/cli-generations.ts --store /path/to/fabric.jsonl list
node --experimental-strip-types examples/cli-generations.ts --store /path/to/fabric.jsonl reconcile --invocation shell-cli:0 --resolution not_committed --evidence 'inspected workspace; no committed writes'
```

For `committed`, supply `--output` as JSON as well as evidence. Close the running
generation host before opening the same store in this separate command; its
single-writer lock remains enforced. Opening performs the safe startup check,
and the command reports if it already reconciled the requested invocation. A
conflicting requested resolution fails with a nonzero exit and a clear message.
`not_committed` refuses a live or unknown group unless the operator explicitly
supplies `--force-with-evidence` and nonempty `--evidence`; this override records
the evidence through the same durable gate. An operation blocked by legacy
reconciliation surfaces `workspace_held` with a reconciliation hint.

Assumptions: no concurrent external writers during inspection; descendants do
not escape the recorded process group or write through symlinks outside the
declared workspace. ESRCH-based automatic reconciliation assumes descendants
stay in that process group; descendants that escape with `setsid` are not
covered by the process-group probe. Excluded Git internals are outside the equality evidence.
Process group identifiers can be reused, so a live reused group conservatively
retains the hold. Pending snapshot inspection retains its invocation identity and
reservation; duplicate identities are rejected. Cancellation is also retained for
allocated CLI identities and placeholders while awaiting recovery or an uncertain
startup check. Before preparation, a retained cancellation returns `cancelled`
without spawning, writing an invocation record, or acquiring a workspace
reservation. Only after all of preparation's pre-consumption checks (input
validation, issued-grant validity, operation, contract revision, permissions,
effects and process effects coverage, recovered-effect-scope reconciliation,
resolved status, shell input preparation, and resource existence and kind checks,
including `cwd_ref`) does it consume the single-use grant through
`GrantAuthority.markInvoked` before releasing the identity reservation. Failed
checks return the same rejection as preparation without consuming the grant,
spawning, or retaining an identity or workspace reservation.
Reusing a consumed grant is denied, including after reopening the host/store with
the same authority; a fresh grant for a new id can run. Grant issuance and
consumption currently live in the in-process authority,
not the Fabric journal, matching ordinary grant use. Consumption survives reopening
only with the same authority: a new authority does not recognize a prior grant
object or its serialized copy. An authority that persists grant use must persist cancellation
consumption through the same gate. A refused consumption returns `DENIED` with
the reason (revoked, not issued or already used); a thrown consumption error is
surfaced. Neither path spawns or retains a reservation.
A cancellation for an id with an existing durable record is not
retained as pending: it marks that record `cancel_requested` (unless already
reconciled), and the invocation continues to prepare/replay. After preparation
it seeds the ordinary pre-start cancellation path,
which settles stopped and releases its reservation without an uncertain marker.
Completion, rejection and startup failure clear the placeholder, identity
reservation and pending cancellation; later reuse cannot inherit that request.
Unknown-id cancellation keeps its existing acknowledgement behavior and retains
no request for future execution. Hosts await `cliRecoveryReady` to inspect completed startup
checks; the CLI bridge and operator command do so automatically. Snapshot equality
proves only absence of retained changes in the declared workspace; it cannot establish
arbitrary external outcomes. Unsupported snapshots and changed workspaces always
require trusted operator evidence. Operators must not treat cancellation alone
as evidence that a workspace change was not committed.

Loom's implementation step records the invocation id on an uncertain attempt and
remains paused with uncertainty until its composition-root `lookupReconciliation`
port observes that invocation's resolution. Missing, failed or unresolved lookups
do not finish the step or repeat generation. `not_committed` is recorded as a
resumable paused attempt and consumes no retry or escalation. A `committed`
lookup supplies the corresponding gateway generation outcome: the step uses it
for the normal checks and output evaluation without repeating generation.
Resolution is appended as attempt evidence, preserving the original uncertain
record; replay uses that evidence without calling the lookup port.
