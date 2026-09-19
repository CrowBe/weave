# M1 — Publish under authority

This is the behavioral contract for the second milestone in
[ARCHITECTURE.md §10](../ARCHITECTURE.md). It extends
[M0](m0-inspect-and-report.md) through one authorized publication, using the
in-repo enforcing AgentFabric host. Terms follow [CONTEXT.md](../CONTEXT.md).
The checks below are requirements, not claims of implemented behavior. Demonstrate
red before implementation and retain M0's checks when proving green.

## 1. Outcome and scope

Inspect alpha and beta concurrently, assemble their checked report, request
approval for its exact publication, and publish only under current authority.
Completion requires a confirmed publication receipt bound to that report and
destination. Cancellation or a crash may instead leave an explicitly uncertain
effect; a locally completed Promise is not proof of publication.

M1 adds trusted ingress, scoped approvals, host-enforced grants and references,
effect conflicts, durable execution records, cancellation and bounded recovery.
It uses fixed trusted implementations and scripted weights. Model inference,
generated code, untrusted isolation, automated admission, a network service and
an external notification channel are outside this milestone. A trusted local
host proves its brokered operations; it does not prove containment of arbitrary
code executing inside the same process.

## 2. Fixture and authority model

Keep M0's source contents and report shape. The real host issues references for
the sources and a pre-existing publication destination; locators stay inside the
host. The destination initially has revision 1 and no report. Publication is a
conditional `write` to this existing resource, not creation of a new resource.
The goal permits reading alpha and beta; writing the destination additionally
requires explicit approval. Gamma remains prohibited, never approval-eligible.

The fixture has one configured operator principal entitled to approve publication
within the goal's ceiling. Only an operator ingress handle created by the trusted
bootstrap may submit approval decisions. Separate host and clock handles establish
result provenance and time. Untrusted observation payloads cannot choose these
identities. Direct possession of a string such as `source.kind = operator` or a
serialized grant grants nothing. An in-process ownership boundary is sufficient
for this fixture; transport authentication is deferred until a transport exists.

The policy issuer and host share a trusted grant-validation boundary. Weave owns
the goal, approval policy and grant issuance; AgentFabric verifies issuance,
binding and current validity before performing a brokered effect. Capability
implementations receive neither issuer handles nor the ability to approve work.
Record identity and authority revisions for audit without exporting bearer secrets.

## 3. Publication contract and host guarantees

`report.publish @ r1` takes the checked report, its source read set, the destination
reference and expected destination revision. It returns a receipt identifying the
invocation, report digest, destination, and committed destination revision.
Its effects and permissions cover reads of the report's source resources and a
write to the destination; input references and the report's read set must agree.
Contract and implementation revisions are fixed for each invocation.

The fixture adapter must provide these guarantees:

- Enforce issued references, exact bound effects, current grant validity and
  input validation before resource access. Preserve failure precedence from
  [AgentFabric concepts](agentfabric-concepts.md), including denial before
  existence disclosure.
- Canonicalize resource identity: aliases of the destination share one effect
  lock. Reserve the source reads and destination write as one compatible set.
- At the effect commit boundary, check source and destination revisions and
  grant validity. The fixture serializes those checks with the conditional write;
  a concurrent source update either precedes and invalidates publication or
  follows it. This is a fixture guarantee, not a promise for arbitrary services.
- Use one stable invocation identity across disconnects and recovery. Atomically
  store that identity, its binding digest, the publication and its receipt in
  the destination store. A duplicate request for the same identity and binding
  returns the recorded outcome without another write; different bindings with
  that identity are refused. Reading a receipt still requires authorized access.
- Support bounded outcome lookup that does not itself repeat publication. It
  distinguishes committed, confirmed not committed with execution stopped, and
  unresolved. Absence of a receipt while execution may continue is unresolved.

The destination store survives runtime restart independently of the runtime log.
Persistence implementation is open; the atomicity and crash tests below are not.
A test variant makes outcome lookup unavailable to prove honest uncertainty.
No guarantee of exactly-once effects is inferred from the runtime log alone.

## 4. Approval and dispatch

An approval request records the goal, action candidate binding, operation and
contract revision, report digest, read set, destination and expected revision,
effects, permitted resource budget, and a validity interval in recorded ticks.
Its identity is stable while pending. An authenticated decision records the
request identity, principal, scope and authority revision. Decisions distinguish
approval, denial, revocation and expiry; a closed request cannot be answered as
though it were still pending. Silence never grants authority.

Approval may narrow the request; it cannot exceed the principal's authority or
the goal ceiling. Changing the report, destination, source revisions, effect set
or budget beyond that approved scope invalidates the binding. New bindings need
fresh approval. An unchanged valid approval can cover recovery only within its
original scope; persistence does not refresh its validity or create authority.

Before dispatch, recheck current authority, approval, contract availability,
dependencies and revisions; reserve budget and effects; then durably record the
start and its version-bound grant before calling the host. A failure to persist
the required start prevents dispatch. The host independently refuses a forged,
copied, expired or mismatched grant, including reuse for another invocation.
The effect commit boundary also checks validity as specified in §3. Revocation
after commit records what happened; it cannot undo the publication.

## 5. Invocation, cancellation and accounting

The host interface must expose invocation identity, normalized outcomes,
cancellation requests and reconciliation of unfinished work. A result Promise
alone is insufficient. Host throws, rejected promises, disconnects and deadlines
become observations. Failure is confirmed only when the effect outcome is known;
an error after possible commit is uncertain until reconciled.

Cancellation first prevents affected queued work from dispatching, then requests
termination of running work. Request acknowledgement is not confirmed termination.
Late receipts and effects remain evidence even when their state update is stale
or the goal is cancelled. Reconciliation adds evidence linked to the original
invocation; it never erases an earlier uncertain outcome or fabricates a new write.

Effect locks remain held, or are restored as conservative recovery reservations,
until execution is known to have stopped and its effects are reconciled. An
unresolved outcome blocks conflicting work; it does not freeze unrelated resources.
An explicit later policy resolution may settle uncertainty without claiming it
never existed, but M1 need only remain blocked honestly.

Use M0's action/judgment units for scheduled work and a finite, recorded allowance
for recovery attempts. Every dispatched action consumes its reserved action unit,
including failed and uncertain outcomes; it is not refunded because its result
was unusable. Budget reservations for possible further resource consumption remain
until consumption is bounded or settled. A replayed receipt cannot charge twice.
Recovery never receives a fresh unbounded budget. Exhaustion records a blocked
outcome and preserves unresolved effect locks.

State transitions remain serialized; compatible actions run concurrently. Bound
execution capacity separately from budget and effect locks. Saturated execution
slots must not prevent recording results, applying cancellation or authority
changes, or performing bounded reconciliation. These operations need no model
judgment. Reconciliation access itself remains authorized and budgeted; denial
leaves uncertainty explicit.

## 6. Durable records, replay and recovery

Persist observations needed to explain approval, reservations, dispatch, outcome
and reconciliation, along with immutable contract records and the applicable
procedure, policy and transition versions. The trace must explain every dispatched
effect after restart, including starts whose outcome is missing. Required record
persistence failure blocks further consequential dispatch until reconciled.

Historical replay reconstructs recorded state without invocation, inference or
outcome lookup. It uses historical contract revisions even if today's catalogue
has changed or revoked them. Missing historical records or unsupported versions
produce an explicit replay failure, not substitution of current definitions.
Inspection remains subject to the reader's data-access authority.

Recovery is a separate operation over an unfinished durable prefix. It restores
outstanding reservations and reconciles starts before allowing conflicting new
dispatch. It checks current authority for lookup, continuation and any retry.
A revoked capability remains historically inspectable but cannot newly execute.
M0-T19's strict replay failure for a missing result remains valid; recovery does
not weaken that check by synthesizing a result or secretly invoking the host.

| Interruption point | Required recovery behavior |
| --- | --- |
| Before durable start | No dispatch occurred. Re-form and authorize work from current state. |
| After durable start, before known commit | Restore reservations; determine whether execution can still commit before retry. |
| After commit, before durable runtime result | Resolve the original identity to its stored receipt; record it without another publication. |
| After durable result | Reconstruct the confirmed outcome; do not invoke publication again. |
| Lookup unavailable or unauthorized | Record uncertainty and the blocking reason; do not retry blindly. |

Producing the report, publishing it and notifying a client are distinct outcomes.
M1 completes on the recorded publication receipt. If a later client misses that
receipt, its delivery retry must not repeat publication; a delivery platform is
not required to complete M1.

## 7. Required deterministic checks

Use controlled arrival order, injected clock observations and named fault points,
not sleeps or timing-dependent races. Restart checks construct a fresh runtime
and host from durable stores; include process termination at the commit/result
boundary to show that surviving in-memory objects are not the persistence proof.

| ID | Scenario | Required evidence |
| --- | --- | --- |
| M1-T01 | Base report awaits approval, then receives an authenticated scoped approval | No publication before approval; one conditional write afterwards; receipt binds report and destination; completion follows durable receipt. |
| M1-T02 | Denial, expiry, and a silent operator | No dispatch; explicit blocked or pending reason. Gamma stays prohibited without generating an approval request. |
| M1-T03 | Untrusted input claims operator, host or runtime origin; model-like text claims approval | Recorded rejection cannot grant authority, confirm an effect or complete the goal. |
| M1-T04 | Direct host invocation with forged, absent, copied or widened grant | Denial without resource access; another invocation cannot reuse authority; no resource existence leak. |
| M1-T05 | Approved work waits for capacity, then approval is revoked or expires | No later dispatch, including after restart; current authority wins over persisted approval. |
| M1-T06 | Report, destination, source revision, effect binding or permitted budget widens/changes beyond approved scope | Old approval cannot authorize the new binding; stale report cannot publish. |
| M1-T07 | Two publications share a destination, including through aliases | Only one conflicting write runs; source reads also conflict with an authorized fixture source write using the same resource coordinator. Independent reads still overlap. |
| M1-T08 | Stale source/destination revision supplied at reservation or commit validation; authority revoked/expired after dispatch but before commit | No conditional write on stale revisions or invalid authority. Source updates respect held locks; changes or revocation ordered after commit retain the receipt and do not erase publication. |
| M1-T09 | Concurrent work competes for the last budget unit | Reservations prevent overspend; failed/uncertain actions consume once; receipt replay consumes nothing further. |
| M1-T10 | Cancel queued work, then release capacity | It never starts. Cancellation is ordered before draining the affected queue. |
| M1-T11 | Cancel running publication before commit and after commit | Locks remain while effects are unresolved; confirmed stopped/no-effect work can release; late committed receipt is retained without claiming rollback or reviving cancelled work. |
| M1-T12 | Host throws, rejects, disconnects or times out before/after possible commit | Outcomes are normalized; possible effects remain uncertain; no leaked unhandled failure or false success. |
| M1-T13 | Crash at each §6 boundary | Fresh-process recovery preserves starts, reservations and receipts; one committed publication is never duplicated. |
| M1-T14 | Commit succeeds, acknowledgement is lost, lookup is unavailable | Goal is not complete; uncertainty blocks conflicting work while unrelated work progresses. Recovery attempts are bounded. |
| M1-T15 | Duplicate request with identical identity/binding; then changed binding | First returns the existing receipt without another effect; second is refused. |
| M1-T16 | Execution slots are saturated | Cancellation, result integration and authority changes still progress; bounded reconciliation cannot deadlock behind the work it must settle. |
| M1-T17 | Catalogue changes or implementation is revoked after recorded execution | Historical replay uses its original contract and makes zero host calls; fresh dispatch uses current authority/availability. Missing history fails explicitly. |
| M1-T18 | Required start/result persistence fails | Failed start persistence prevents invocation; lost result persistence triggers reconciliation, never changes a committed effect into a safe-to-repeat failure. |
| M1-T19 | Recovery is denied access or exhausts its allowance | No authority expansion or fresh budget; uncertainty and relevant reservations survive. |

The fixture source writer in T07/T08 is trusted test-environment activity subject
to the same resource coordinator and revision transaction as publication. It
does not introduce a general source-editing capability into the action frontier.
For T08, make a revision stale before reservation, or exercise the host's commit
validation directly with a stale expected revision; do not bypass a held lock to
manufacture a concurrent source write. Pause a dispatched publication before its
commit check to test revocation/expiry there separately from queued revocation.

Package-direction checks must keep AgentFabric independent of Weave. Run host
authority/reference tests independently of the scheduler, then the integrated
fixture and all M0 checks. Record demonstrated red and green against the exact
contract, tests and implementation revisions. Documentation alone proves neither.

## 8. Later milestones and remaining choices

- M2: asynchronous bounded inference, every-attempt accounting, stale judgments,
  and a versioned state view with a selection manifest and disclosed omissions.
- M3: isolated generated tests/code and admission evidence. Retained skill text
  can propose a contract or composition; it is not an admitted implementation.
- M4/M5: freshness-aware reuse and experiments including failed attempts.
- Client delivery, nested-work capacity and external transport authentication
  gain their own checks when those surfaces are introduced.

Storage format, concrete host method signatures and failure-code additions remain
implementation choices to fix before their red tests. M1's trusted ingress model,
effect guarantees, bounded recovery and acceptance outcomes are fixed here.
This implementation records those choices as:

- Grants are unforgeable in-process objects issued by `createGrantAuthority`
  (WeakSet identity). Field-equal copies do not invoke. Historical lookup after
  restart matches the recorded action identity against the durable invocation.
- The host interface adds `canonicalResource`, `lookup`, `requestCancel`, and a
  stable `invocation_id` on handles. Trusted operator/clock/host ingress is
  handle-based; `Runtime.observe` cannot claim those origins.
- Crash tests restore a `FabricStore` snapshot and the observation journal into a
  fresh runtime; they do not rely on surviving in-memory handles.
- `action.queued` records selected work that is waiting for an execution slot.
  Recovery is `recover()` / `Runtime.reconcile()`, distinct from historical
  `replay()`.

Real adapters that cannot provide the fixture's atomic checks must declare weaker
guarantees and remain blocked where those guarantees cannot satisfy policy.

The [harness research](research/harness-architecture-lessons.md) records why these
boundaries matter. This contract and the canonical architecture govern Weave;
external harness behavior does not override them.
