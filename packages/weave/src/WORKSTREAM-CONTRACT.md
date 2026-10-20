# Workstream contract v1

Status: first slice of #26. `workstream.ts` implements this contract as pure,
deterministic transitions over versioned records, and
`test/workstream.test.ts` pins it. Nothing here is wired into the runtime
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

A workstream is opened by the operator (origin `operator`) or by Loom
(origin `route`), for example when it routes input to independent work.
Opening one grants nothing, attaches no goal, and starts no work.

A record is a JSON object with exactly these keys, in this order:

| Key             | Type                                             | Meaning                                                          |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `schema`        | `'workstream@1'`                                 |                                                                  |
| `workstream_id` | id                                               | Unique within the project                                        |
| `project_id`    | id                                               | Fixed when the workstream is opened                              |
| `origin`        | `'operator'` \| `'route'`                        | Who opened it                                                    |
| `opened_at`     | seq                                              | Observation that supports opening                                |
| `revision`      | integer                                          | 0 when opened, plus 1 per transition                             |
| `goals`         | `{ goal_id, attached_at, ended_at }[]`           | In attachment order. `ended_at` is null while the goal is active |
| `inputs`        | `{ seq }[]`                                      | Operator input observations, in increasing seq                   |
| `artifacts`     | `{ artifact_id, revision, goal_id, evidence }[]` | In recording order                                               |

An id is a bounded identifier: 1 to 128 characters of `[A-Za-z0-9_.:-]`,
starting with a letter or digit, with no credential prefix. A path or URL is
therefore refused. A seq is a non-negative safe integer.

## Transitions

Every transition is a pure function of one project's index of workstreams and
returns either the new index and workstream, or a refusal with a closed
reason. A refusal leaves the index unchanged. The input index is never
mutated. A transition on one workstream never changes another.

| Transition                                              | Requires                                                                                 | Refusal                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| open `{ workstream_id, origin, evidence }`              | valid ids, origin and evidence; id unused in the project                                 | `invalid_id`, `invalid_origin`, `invalid_evidence`, `duplicate_workstream` |
| `goal.attached { goal_id, evidence }`                   | no active goal here; goal not attached to any workstream of the project                  | `goal_active`, `goal_attached`                                             |
| `goal.ended { goal_id, evidence }`                      | that goal is this workstream's active goal                                               | `goal_not_active`                                                          |
| `input.recorded { seq }`                                | seq greater than every input already recorded here                                       | `input_out_of_order`                                                       |
| `artifact.recorded { artifact_id, revision, evidence }` | an active goal; a revision greater than this workstream's last revision of that artifact | `no_active_goal`, `stale_revision`                                         |

Every transition other than open also refuses `unknown_workstream`,
`invalid_id`, `invalid_evidence` and, for an event outside this table,
`invalid_event`. Replaying the same transitions from the
same index produces byte-identical records.

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
