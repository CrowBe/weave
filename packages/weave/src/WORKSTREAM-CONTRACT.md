# Workstream contract v1

Status: first slices of #26, #28 and #27. `workstream.ts`,
`operating-process.ts` and `input-route.ts` implement this contract as pure,
deterministic transitions over versioned records, and `input.route` is a
choice site under [sites/CONTRACT.md](sites/CONTRACT.md).
`test/workstream.test.ts`, `test/operating-process.test.ts` and
`test/input-route.test.ts` pin it. Nothing here is wired into the runtime
loop, persisted, or presented yet. Tapestry presents projects and
workstreams; Loom owns their meaning.

## Naming assumption

#26 calls this concept a _thread_. In this repository **Thread** already
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

| Key             | Type                                                    | Meaning                                                                                    |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `schema`        | `'workstream@1'`                                        |                                                                                            |
| `workstream_id` | id                                                      | Unique within the project                                                                  |
| `project_id`    | id                                                      | Fixed when the workstream is opened                                                        |
| `origin`        | `'operator'` \| `'route'`                               | Who opened it                                                                              |
| `opened_at`     | seq                                                     | Observation that supports opening                                                          |
| `revision`      | integer                                                 | 0 when opened, plus 1 per transition                                                       |
| `goals`         | `{ goal_id, attached_at, ended_at }[]`                  | In attachment order. `ended_at` is null while the goal is active                           |
| `inputs`        | `{ seq, route, decided_by, routed_at, target, held }[]` | Operator input observations, in increasing seq, with their placement (see `input.route@1`) |
| `artifacts`     | `{ artifact_id, revision, goal_id, evidence }[]`        | In recording order                                                                         |
| `process`       | `operating.process@1` \| null                           | The current or most recent operating process                                               |

An id is a bounded identifier: 1 to 128 characters of `[A-Za-z0-9_.:-]`,
starting with a letter or digit, with no credential prefix. A path or URL is
therefore refused. A seq is a non-negative safe integer.

## Transitions

Every transition is a pure function of one project's index of workstreams and
returns either the new index and workstream, or a refusal with a closed
reason. A refusal leaves the index unchanged. The input index is never
mutated. A transition on one workstream never changes another.

| Transition                                                  | Requires                                                                                                                            | Refusal                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| open `{ workstream_id, origin, evidence }`                  | valid ids, origin and evidence; id unused in the project                                                                            | `invalid_id`, `invalid_origin`, `invalid_evidence`, `duplicate_workstream` |
| `goal.attached { goal_id, evidence }`                       | no active goal here; goal not attached to any workstream of the project                                                             | `goal_active`, `goal_attached`                                             |
| `goal.ended { goal_id, evidence }`                          | that goal is this workstream's active goal; no work in flight (process not `running` or `waiting`)                                  | `goal_not_active`, `work_in_flight`                                        |
| `input.recorded { seq }`                                    | seq greater than every input already recorded here                                                                                  | `input_out_of_order`                                                       |
| `input.routed { seq, route, decided_by, evidence, target }` | the input is recorded here; an active goal for `steer`, `interrupt` and `queue`; for `parallel`, a target workstream in the project | `unknown_input`, `no_active_goal`, `unknown_workstream`, `invalid_event`   |
| `input.released { seq, evidence }`                          | no active goal; the input is recorded here and is the oldest held one                                                               | `goal_active`, `unknown_input`, `not_next`                                 |
| `artifact.recorded { artifact_id, revision, evidence }`     | an active goal; a revision greater than this workstream's last revision of that artifact                                            | `no_active_goal`, `stale_revision`                                         |
| `process.opened { process_id, evidence }`                   | no live process here; an id other than the current process's                                                                        | `process_live`, `duplicate_process`                                        |
| `process.transition { event }`                              | a process here; the process transition below is legal                                                                               | `no_process`, or the process refusal                                       |

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

| Key               | Type                                                     | Meaning                                           |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------- |
| `schema`          | `'operating.process@1'`                                  |                                                   |
| `process_id`      | id                                                       |                                                   |
| `workstream_id`   | id                                                       | The workstream it runs for                        |
| `state`           | state                                                    |                                                   |
| `revision`        | integer                                                  | 0 when opened, plus 1 per transition              |
| `waiting_on`      | `'approval'` \| `'capability'` \| `'dependency'` \| null | Set while waiting, kept while paused from waiting |
| `pause_requested` | seq \| null                                              | Evidence of a pending pause request               |
| `stop_requested`  | seq \| null                                              | Evidence of a stop request                        |
| `paused_from`     | `'idle'` \| `'running'` \| `'waiting'` \| null           | Where resume returns                              |
| `resume_point`    | `{ ref, digest }` \| null                                | Set when paused; kept when stopped from paused    |
| `stop_reason`     | `'requested'` \| `'failed'` \| null                      | Set when stopped                                  |
| `evidence`        | seq                                                      | Observation that supports the latest transition   |

| Event                             | From                   | To                       | Also requires                                                                        |
| --------------------------------- | ---------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `started`                         | idle                   | running                  | no pending pause or stop request; the workstream has an active goal                  |
| `waiting { on }`                  | running                | waiting                  |                                                                                      |
| `woke`                            | waiting                | running                  |                                                                                      |
| `yielded`                         | running                | idle                     |                                                                                      |
| `pause_requested`                 | idle, running, waiting | unchanged                | no pending pause request                                                             |
| `pause_withdrawn { request }`     | idle, running, waiting | unchanged                | `request` is the pending pause request's evidence                                    |
| `paused { resume_point }`         | idle, running, waiting | paused                   | a pending pause request, which this honours                                          |
| `resumed { digest }`              | paused                 | the state it paused from | the resume point's digest; no stop request; an active goal unless it returns to idle |
| `stop_requested`                  | any live state         | unchanged                | no earlier stop request                                                              |
| `stopped { reason: 'requested' }` | any live state         | stopped                  | a stop request                                                                       |
| `stopped { reason: 'failed' }`    | running, waiting       | stopped                  |                                                                                      |
| `completed`                       | idle, running          | complete                 |                                                                                      |

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

## `input.route@1`

Operator input can arrive while work runs. Loom records it on its workstream
at once (`input.recorded`, with no placement), so the conversation stays
responsive, and then decides how the input relates to that workstream's
active work. The decision and its outcome's meaning are separate: a
judgment may propose an outcome; what each outcome does is fixed here.

### Deciding

`input-route.ts` decides in this order, and the first rule that applies wins:

1. **Explicit operator direction.** The operator may name an outcome. It
   reaches Loom through trusted ingress as its own field; Loom never reads a
   direction out of the input text. A direction is decided by `operator` and
   never reaches the site. A direction that cannot apply (`steer`,
   `interrupt` or `queue` with no active goal, or a word outside the five
   outcomes) is `needs_human` with reason `invalid_direction`. It is not
   sent to the site either.
2. **No active work.** With no active goal in the workstream there is
   nothing to route across. The rule decides `conversation` with reason
   `no_active_work`.
3. **The `input.route` site.** Otherwise one choice question is asked. The
   site sees only the disclosed input text, a disclosed summary of the active
   work, and the operating process state. An accepted answer is decided by
   `site`. A fallback is `needs_human` with no outcome: the input stays
   recorded and unplaced, the work is unaffected, and the operator is asked.
   A cancellation is `paused` with no outcome.

The record is `input.route@1`, with exactly these keys in this order:
`schema`, `workstream_id`, `input_seq`, `decided_by` (`operator`, `rule` or
`site`), `outcome` (one of the five, or null), `status` (`transition`,
`needs_human` or `paused`), `reason` (`operator_direction`,
`invalid_direction`, `no_active_work`, or the site's reason), and `site`
(the `decision-site@1` observation, or null when the site was not asked).
It copies no input text and no summary. Replay rebuilds it from the
recorded site transition without a provider (`transitionRoute`).

### What each outcome does

Applying a record places the input on its workstream and makes only the
changes below, all or none. The record's own observation (`evidence`)
supports every change. A record without an outcome is refused (`no_route`).
An input that is already placed can be re-placed only by the operator
(otherwise `already_routed`), and only to a different outcome (otherwise
`unchanged`).

| Outcome        | Loom does                                                                                                                                                                                                       | Loom does not                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `conversation` | Places the input. The workstream's ordinary cycle may respond.                                                                                                                                                  | Change the goal, the process or the queue                                                                                           |
| `steer`        | Places the input for the active goal's work, which reads it at its next boundary.                                                                                                                               | Change the process, the goal's scope or its authority. A steer that would broaden scope still needs a goal revision under authority |
| `interrupt`    | Places the input. If the process is idle, running or waiting with no pending pause request, records `pause_requested`. The provider pauses at its next boundary; then Loom reconsiders the goal with the input. | Stop work. Only an explicit operator stop request ends a process                                                                    |
| `parallel`     | Opens a new workstream (origin `route`, id from the caller's injected port), records the input there as `conversation` decided by `rule`, and places it on the original workstream with that target.            | Attach a goal, open a process or grant anything in the new workstream. Work there starts only through the ordinary goal path        |
| `queue`        | Places the input as held. Once the workstream has no active goal, held inputs are offered oldest first (`nextQueued`); `input.released` marks one released.                                                     | Dispatch it, or offer it while a goal is active                                                                                     |

A routing answer is an observation. It cannot dispatch work, create a grant,
or widen disclosure. No outcome starts or resumes a process, attaches a goal
or opens a process. None of these records has a field for a grant, an
approval, a scope or a slice. The site's answer is read only through the
site's admitted choice. Every other field a provider returns is ignored.

### Correcting

The operator sees each placement and may correct it with one direction.
`correctRoute` checks that the record still describes the input's current
placement (otherwise `stale_record`). It refuses a correction to the same
outcome (`unchanged`), and a direction that cannot apply
(`invalid_direction`). Then it re-places the input as decided by
`operator`:

- A pause request that the corrected `interrupt` made and the provider has
  not yet honoured is withdrawn (`pause_withdrawn`). A pause that already
  happened stays: resuming is its own explicit decision.
- A held `queue` placement stops being held.
- A workstream that `parallel` opened stays open, with no goal and no
  process.
- Work that already read a `steer` is not rewound.

Every correction yields `input.route.correction@1`, with exactly these keys
in this order: `schema`, `workstream_id`, `input_seq`, `routed_by`,
`routed`, `corrected`, `site_answer`, `site_confidence`, `site_top_p` and
`evidence`. It holds closed-vocabulary values, numbers and ids only. It is
evaluation evidence for `input.route`: a later evaluation may read it. It
changes no threshold, trains nothing and promotes nothing.

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
- Route input that names no workstream, or choose among several
  workstreams' active work. The site judges one workstream's active work;
  `parallel` opens a new workstream and never targets an existing one.
- Reconsider an interrupted goal, read steers at a boundary, or respond to
  conversation. Those belong to the cycle that runs the goal.
- Replace `intake.classify`. It keeps its options and frozen benchmark sets.
- Run anything. There is no execution-provider seam, worker, snapshot
  store, resume-point MAC or retention rule, and no reconciliation of
  effects still in flight when work stops. Worker capacity as a scheduler
  resource is not modelled.
