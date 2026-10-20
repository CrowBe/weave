# Workstream contract v1

Status: first slices of #26 and #28. `workstream.ts` and
`operating-process.ts` implement this contract as pure, deterministic
transitions over versioned records. `test/workstream.test.ts` and
`test/operating-process.test.ts` pin it. Nothing here is wired into the runtime
loop, persisted, or presented yet. Tapestry presents projects and
workstreams; Loom owns their meaning.

## Naming assumption

#26 calls this concept a *thread*. In this repository **Thread** already
means a causally related sequence of actions and observations within one
goal, and Weft's `thread_id` is bound to that meaning. The concept here is
broader: it can span goals and own artifacts and execution state. So it gets
its own name, **workstream**, and the Thread entry is not widened.

This is an assumption the captain may override. A rename changes the schema
name `workstream@1`, the module name and the glossary entry, and nothing
else. Where the operator sees the concept, Tapestry may label it however the
captain chooses.

## `workstream@1`

A workstream is an independently addressable stream of conversation and work
within one project. Its relations are fixed:

- **Project.** A project has any number of workstreams. A workstream belongs
  to one project for its whole life. The project stays the top-level unit.
  Its record and availability index are unchanged by this contract.
- **Goal.** A workstream pursues at most one active goal at a time. It keeps
  every goal it has pursued, in order, with the evidence for attaching and
  ending each one. Within a project, a goal belongs to one workstream only.
  Several workstreams can each have an active goal at once. That is how a
  project makes progress on independent work without becoming one large
  session. Each goal keeps its own Loom state, scope and authority. The
  workstream holds only the goal's id.
- **Thread.** A Thread stays inside its goal, so it stays inside one
  workstream. A workstream is not a Thread and is not a Weft `thread_id`.
- **Observations.** A workstream lists the sequence numbers of the operator
  input observations addressed to it, in log order. It copies no payload.
  Its conversation is a projection of those observations and of its goals'
  communication actions. It is not a transcript store, and it is not the
  state of the runtime.
- **Artifacts.** A workstream records the artifact revisions that its active
  goal's work produced: `{ artifact_id, revision, goal_id, evidence }`. The
  id is an opaque bounded identifier and never a locator. Within one
  workstream, recorded revisions of an artifact only increase. The record
  says where a revision was produced. It does not grant authority over the
  artifact or its resource.
- **Project resources.** A workstream has no field for resources,
  availability, slices, grants, disclosure or visibility. Availability at the
  project level does not give the workstream context (no slice is filled),
  capability access (no eligibility or grant), disclosure, or visibility in a
  workspace. A goal opened in a workstream names its own sources and
  authority.
- **Runtime state.** A workstream's execution state is its operating process
  (`operating.process@1`, below). The workstream outlives every process.

A workstream is opened by the operator (origin `operator`) or by Loom
(origin `route`), for example when it routes input to independent work.
Opening one grants nothing, attaches no goal, and starts no work.

A record is a JSON object with exactly these keys, in this order:

| Key | Type | Meaning |
| --- | --- | --- |
| `schema` | `'workstream@1'` | |
| `workstream_id` | id | Unique within the project |
| `project_id` | id | Fixed when the workstream is opened |
| `origin` | `'operator'` \| `'route'` | Who opened it |
| `opened_at` | seq | Observation that supports opening |
| `revision` | integer | 0 when opened, plus 1 per transition |
| `goals` | `{ goal_id, attached_at, ended_at }[]` | In attachment order. `ended_at` is null while the goal is active |
| `inputs` | `{ seq }[]` | Operator input observations, in increasing seq |
| `artifacts` | `{ artifact_id, revision, goal_id, evidence }[]` | In recording order |
| `process` | `operating.process@1` \| null | The current or most recent operating process |

An id is a bounded identifier: 1 to 128 characters of `[A-Za-z0-9_.:-]`,
starting with a letter or digit, with no credential prefix. A path or URL is
therefore refused. A seq is a non-negative safe integer.

## Transitions

Every transition is a pure function of one project's index of workstreams and
returns either the new index and workstream, or a refusal with a closed
reason. A refusal leaves the index unchanged. The input index is never
mutated. A transition on one workstream never changes another.

| Transition | Requires | Refusal |
| --- | --- | --- |
| open `{ workstream_id, origin, evidence }` | valid ids, origin and evidence; id unused in the project | `invalid_id`, `invalid_origin`, `invalid_evidence`, `duplicate_workstream` |
| `goal.attached { goal_id, evidence }` | no active goal here; goal not attached to any workstream of the project | `goal_active`, `goal_attached` |
| `goal.ended { goal_id, evidence }` | that goal is this workstream's active goal; no work in flight (process not `running` or `waiting`) | `goal_not_active`, `work_in_flight` |
| `input.recorded { seq }` | seq greater than every input already recorded here | `input_out_of_order` |
| `artifact.recorded { artifact_id, revision, evidence }` | an active goal; a revision greater than this workstream's last revision of that artifact | `no_active_goal`, `stale_revision` |
| `process.opened { process_id, evidence }` | no live process here; an id other than the current process's | `process_live`, `duplicate_process` |
| `process.transition { event }` | a process here; the process transition below is legal | `no_process`, or the process refusal |

Every transition other than open also refuses `unknown_workstream`,
`invalid_id`, `invalid_evidence` and, for an event outside this table,
`invalid_event`. Replaying the same transitions from the
same index produces byte-identical records.

## `operating.process@1`

An operating process is the explicit execution state of one workstream's
work. The conversation transcript is not the execution container, and
process state is never inferred from conversation. An operating process is
not an operating-system process, a sandbox or an execution tier. A provider
may back it with a worker, a container, or nothing at all while it is
paused. For example, a Monty session maps to it as idle between feeds,
running in a feed, waiting when suspended at a host call, and paused when
dumped with its worker released ([research note](../../../docs/research/monty-sandbox.md)).
This contract chooses no provider.

Loom owns every transition. A provider reports boundaries (`waiting`,
`woke`, `yielded`, `paused`, `stopped`, `completed`) as observations that
Loom admits. Requests (`pause_requested`, `pause_withdrawn`,
`stop_requested`, `resumed`) come from Loom policy, or from the operator
through trusted ingress. Tapestry renders a disclosed view of the state and
submits operator observations. It holds no process state and makes no
transition.

States: `idle`, `running`, `waiting` and `paused` are live; `complete` and
`stopped` are terminal.

| Key | Type | Meaning |
| --- | --- | --- |
| `schema` | `'operating.process@1'` | |
| `process_id` | id | |
| `workstream_id` | id | The workstream it runs for |
| `state` | state | |
| `revision` | integer | 0 when opened, plus 1 per transition |
| `waiting_on` | `'approval'` \| `'capability'` \| `'dependency'` \| null | Set while waiting, kept while paused from waiting |
| `pause_requested` | seq \| null | Evidence of a pending pause request |
| `stop_requested` | seq \| null | Evidence of a stop request |
| `paused_from` | `'idle'` \| `'running'` \| `'waiting'` \| null | Where resume returns |
| `resume_point` | `{ ref, digest }` \| null | Set when paused; kept when stopped from paused |
| `stop_reason` | `'requested'` \| `'failed'` \| null | Set when stopped |
| `evidence` | seq | Observation that supports the latest transition |

| Event | From | To | Also requires |
| --- | --- | --- | --- |
| `started` | idle | running | no pending pause or stop request; the workstream has an active goal |
| `waiting { on }` | running | waiting | |
| `woke` | waiting | running | |
| `yielded` | running | idle | |
| `pause_requested` | idle, running, waiting | unchanged | no pending pause request |
| `pause_withdrawn { request }` | idle, running, waiting | unchanged | `request` is the pending pause request's evidence |
| `paused { resume_point }` | idle, running, waiting | paused | a pending pause request, which this honours |
| `resumed { digest }` | paused | the state it paused from | the resume point's digest; no stop request; an active goal unless it returns to idle |
| `stop_requested` | any live state | unchanged | no earlier stop request |
| `stopped { reason: 'requested' }` | any live state | stopped | a stop request |
| `stopped { reason: 'failed' }` | running, waiting | stopped | |
| `completed` | idle, running | complete | |

Refusals are closed: `illegal_transition`, `terminal`, `request_pending`,
`already_requested`, `request_mismatch`, `no_pause_request`,
`no_stop_request`, `invalid_resume_point`, `resume_point_mismatch`,
`invalid_id`, `invalid_evidence`, `invalid_event`.

The rules that matter:

- **A workstream outlives every process.** It has at most one live process.
  After a process completes or stops, a new process with a new id may be
  opened. Goals, inputs and artifacts stay.
- **No process pauses or stops itself.** Pausing honours a pending pause
  request, and a requested stop needs a stop request. Only a failure ends
  work without a request. An interrupt is a pause request; it is honoured at
  the provider's next boundary, not by tearing work down.
- **Pause keeps enough to inspect and resume.** `paused` carries a resume
  point: an opaque `ref` (bounded identifier) under Loom's custody and the
  SHA-256 `digest` (64 lowercase hex) of what it names. `resumed` must
  present the same digest; otherwise it is refused and the process stays
  paused. The record carries no provider type or content. A stopped process
  keeps its resume point for inspection, and it cannot resume.
- **Resume renews nothing.** The record has no grant, approval, reservation
  or budget, and resuming creates none. Work that continues rechecks current
  authority at dispatch, as recovery does.
- **Work runs only under an active goal.** `started`, and `resumed` into
  running or waiting, need the workstream's active goal. A goal cannot end
  while work is running or waiting.
- **A pending request blocks new work.** `started` is refused while a pause
  or stop request is pending.
- **Input stays available.** Recording operator input is legal in every
  process state and leaves the process unchanged.
- **Processes are independent.** A transition on one workstream's process
  never changes another's.

## What this slice does not do

- Wire workstreams into the runtime loop, the observation log or replay. The
  runtime's goal state is unchanged.
- Persist records, or present them. Tapestry's component vocabulary does not
  change.
- Close or archive a workstream.
- Decide whether one artifact may have a single owning workstream. Two
  workstreams may each record revisions of the same artifact. Concurrent
  writes stay a matter for effect locks.
- Move the project record. The reference binding keeps its availability
  index.
- Run anything. There is no execution-provider seam, worker, snapshot
  store, resume-point MAC or retention rule, and no reconciliation of
  effects still in flight when work stops. Worker capacity as a scheduler
  resource is not modelled.
