# Operator design system

This is a plan for the project workspace: the shell, the theme, and the
component vocabulary. It is not a milestone, and it does not change an
acceptance boundary in [VISION.md](../VISION.md). The workspace is an adapter
over runtime state. Conversation remains evidence. Responding remains an
action.

Terms live in [CONTEXT.md](../CONTEXT.md). This document uses them.

Two sentences hold the plan:

> Predictable navigation, adaptive attention.

> Weave starts as the simplest interface appropriate to the interaction and
> surfaces richer controls, work, artifacts, and observability as they become
> useful.

Selective context for a model and selective complexity for the operator are
the same rule. Attaching a resource makes it available. Availability does not
fill a state view, and it does not put the resource on screen.

## Assumptions

The repository cannot yet verify these. They bound the first cut:

- One runtime, one operator, one project, and at most one workspace.
- A project may contain many goals over time. At most one goal is open.
- The runtime can expose an in-process read port that reports a new state
  revision and renders `view.workspace@1`. The port carries no observation
  payloads and does not submit them.
- Local configuration names a principal the runtime is already configured to
  accept. The record itself grants nothing.
- Web is the first renderer. The vocabulary does not depend on that fact.

## Decision

Setup is a deterministic terminal surface. It writes local configuration and
requests no inference.

A workspace then attaches to a project. That attachment is a session. A fresh
session paints navigation and a conversational surface in the main region.
The drawer is collapsed. Observability components stay reachable from
navigation and stay off the main surface.

There is no mode. The same shell is the workspace while the operator is
talking, implementing, or reading evidence. What changes is which component
occupies `main.primary` and whether `right.drawer` is open.

Occupancy of a region follows one precedence:

1. An operator pin.
2. An operator placement.
3. A blocking authority request, in the cut-through, unless the operator has
   placed that request.
4. An admitted arrangement.
5. The default tree.

`workspace.arrange` may choose, for a contested adaptive region that no pin
or placement holds, one component id from that region's offer. It sends one
evaluation request of kind `choice` and role `working`. The answer becomes an
arrangement only at the state revision it evaluated, against the session's
vocabulary and theme, and only within the arrangement allowance. Navigation,
the cut-through, pins, and placements are settled before the request.

An unusable, stale, rejected, or superseded answer leaves the last admitted
arrangement, or the default tree, in place. The workspace is never blank.

Pins and placements last for the session. The next session starts clear.
They are not project policy.

No model writes components, token values, markup, or coordinates. The
vocabulary grows by a trusted revision of the vocabulary record.

## 1. Why workspace state stays off the observation log

`weights.recorded` is accepted only when its `state_revision` equals the
current revision. A gateway weigh binds that field to the sequence of its
`inference.requested` record. An accepted observation appended while the call
is in flight rejects the weights.

A placement, a pin, or an arrangement written into the observation log would
be such an observation. It would also move the M4 and M5 cost baselines. The
workspace therefore keeps a session record. The record cites goal revisions
and does not advance them.

## 2. Project and boot

A project lists attachments by kind and name: repository, document, artifact,
capability, history. Each attachment is a resource reference plus a label.
The list is availability. It does not issue a grant, disclose a body, or
surface a component. Cross-goal access to retained evidence still requires
the policy that already governs durable knowledge.

The setup surface is a fixed sequence:

1. Operator principal.
2. Project, new or existing.
3. Theme selection from the shipped theme records. Each candidate is previewed
   by resolving the shell through that record.
4. Arrangement allowance, per-key request cap, and the destinations permitted
   to `workspace.arrange`. An empty destination list disables the site.
5. Validation, then the local-configuration record.

Until a theme is selected, setup renders with `theme.weave-default@1`. Setup
requests no inference and writes nothing to the observation log. Setup does
not open a goal.

A workspace boots when local configuration validates, a project is selected,
a runtime is running and supplies the read port, and no other session is
attached. An open goal is not required. Boot appends `attached` to the session
record and paints the default tree. The arrangement cycle starts after that
paint, and only once a goal revision exists to bind to.

Ending a session detaches the workspace. It does not complete, pause, or
cancel a goal, release a reservation, or write to the observation log. Goal
closure leaves the session up and returns attention toward the conversational
surface, unless the operator has pinned something else. Recovery does not
restore a session.

## 3. Theme

Components name token roles. A theme record supplies every role in
`tokens@1`. One theme resolves every paint in a session. A judgment neither
sees nor sets it. Changing theme means detaching, running setup, and
attaching again.

Color never carries meaning alone. Every status role has a text mark, so a
monochrome renderer loses nothing.

Token roles are the specification. A renderer binds each role to its medium.
The theme record may carry an optional binding. The vocabulary never reads
the binding.

### Token roles `tokens@1`

| Group | Roles | Rule |
| --- | --- | --- |
| Color, base | `canvas`, `surface`, `surface-raised`, `border`, `text`, `text-muted`, `focus` | |
| Color, provenance | `provenance-operator`, `provenance-runtime`, `provenance-host`, `provenance-clock`, `provenance-judgment`, `provenance-untrusted` | Judgment and gateway share `provenance-judgment`. Test and unrecognized provenance use `provenance-untrusted`. Model-derived values use `provenance-judgment`. |
| Color, eligibility | `eligibility-allowed`, `eligibility-approval`, `eligibility-prohibited` | |
| Color, action | `action-pending`, `action-running`, `action-succeeded`, `action-failed`, `action-uncertain`, `action-cancelled` | `action-failed` and `action-uncertain` are distinct values. |
| Color, validation | `validation-accepted`, `validation-rejected`, `validation-unknown` | `validation-accepted` and `validation-rejected` are distinct values. |
| Color, condition | `condition-empty`, `condition-omitted`, `condition-stale`, `condition-exhausted` | |
| Color, decision | `decision-request`, `decision-approve`, `decision-deny` | Only cut-through components may reference these. `decision-approve` and `decision-deny` are distinct values. |
| Type | `title`, `heading`, `body`, `label`, `id`, `numeric` | Weight, emphasis, fixed width, tabular figures. Family and size are renderer bindings. |
| Space | `space.0` through `space.5` | Integer multiples of `space.unit`. |
| Density | `density.comfort` (`comfortable` or `compact`), `density.list-rows`, `density.gutter` | Density changes spacing and list length. It is not a product mode. |
| Elevation | `elevation.base`, `elevation.raised`, `elevation.overlay` | `overlay` is the cut-through. A pin cannot cover it. |
| Marks | one text mark per status role | Examples: `mark.uncertain`, `mark.stale`, `mark.rejected`, `mark.omitted`. |

`density.comfort` replaces the earlier `density.mode` name so a token is not
read as a chat, code, research, or agent mode.

### Theme record

The values below illustrate the record. They are not a brand palette.

```text
id:       theme.weave-default
version:  1
roles:    tokens@1
color:    each tokens@1 color role → { ansi: 0–15 | null, srgb: string | null }
type:     heading { weight: bold }, id { fixed_width: true }, numeric { tabular: true }
space:    { unit: 1, scale: [0, 1, 2, 3, 4, 6] }
density:  { comfort: comfortable, list_rows: 12, gutter: 2 }
elevation:{ base: 0, raised: 1, overlay: 2 }
mark:     { uncertain: "?", stale: "~", rejected: "x", omitted: "-" }
digest:   canonical digest of this record
```

`theme.weave-daylight@1` is the same shape with a light canvas and
`density.comfort: compact`. Setup rejects a record that omits a role, omits a
mark for a status role, or gives one value to a pair that must differ. A
missing media binding is valid. A renderer that needs a binding it does not
have refuses to paint, and names the missing role.

A conformance check on the surface package confirms that components reference
role names from `tokens@1` only, contain no literal color or type values, and
use `decision-*` roles only on cut-through components. The check covers
trusted source. It does not inspect model output. The check also rejects
toolkit names in the vocabulary: DOM, CSS, React, and pixel coordinates.

A session fixes one theme reference: id, version, and digest. Every component
tree and every arrangement cites it. Arrangement validation rejects a
mismatch. The arrange view, the request, the answer, and the arrangement
contain no token names and no token values.

### Interaction states

States are semantic. A renderer maps them. The vocabulary does not name the
mapping.

| State | Meaning |
| --- | --- |
| `rest`, `focus`, `pressed`, `disabled` | Pointer and keyboard affordance of a control. |
| `pinned`, `placed` | The operator holds this component in this region for the session. |
| `collapsed`, `expanded` | A region or a nav group is folded or open. Operator collapse is session state. |
| `cut-through` | A blocking request is showing in the cut-through. |
| `empty`, `withheld`, `stale`, `exhausted` | No rows, an omitted slice, a lagging revision, or a spent arrangement allowance. |

Focus does not move onto an approve or deny control when a request appears.
The cut-through shows the request. Navigation shows a count.

## 4. Shell

The vocabulary version fixes the regions and their order:

1. `nav`. Deterministic. Project name, attachment index (names and kinds),
   the open goal when one exists, a count of pending authority requests, and
   an entry for each observability component. Arrangement cannot write `nav`.
   The operator may collapse it. Collapse is session state.
2. `main.primary`. Adaptive. The centre of attention.
3. `main.bottom`. Adaptive. A secondary strip. Empty unless something useful
   is there.
4. `right.drawer`. Adaptive and optional. Companion region. `collapsed` is a
   real occupant.
5. `cut-through`. Blocking. One component per pending approval or requested
   admission, in request order, until the operator places that item or decides
   it.

A renderer lays these regions out for its medium. It may put `nav` on the
left and `right.drawer` on the right. It may not invent a region, reorder the
reading order, cover the cut-through, or accept a coordinate as a placement.

The shell also carries indicators: session id, project id, goal id when a
goal is open, painted revision (and the current revision when they differ),
theme reference, arrangement status, and arrangement allowance remaining.
Those indicators are not components and are not questions.

### What a fresh session paints

`nav` and `conversation.thread` in `main.primary`. `main.bottom` empty.
`right.drawer` collapsed. No frontier table, ledger, or evidence trace.

### What changes as work appears

The default tree is a pure function. Predicates are data on the vocabulary,
evaluated against the workspace view:

| Predicate | Holds when |
| --- | --- |
| `blocking` | a pending approval or a requested admission is unplaced |
| `work.active` | an action is pending, running, or uncertain |
| `artifact.current` | the artifacts slice is disclosed and non-empty |
| `research.active` | crystallization or notices are non-empty, and `work.active` is false |
| `conversation.leads` | none of the above |

When `conversation.leads`, `main.primary` is `conversation.thread` and the
drawer is collapsed.

When `work.active` or `artifact.current`, `main.primary` takes the first
applicable work component in vocabulary order, and `conversation.thread`
moves to `right.drawer` unless the operator has pinned or placed it.

When `research.active`, `main.primary` takes the first applicable research
component, and the conversational surface moves to the drawer on the same
rule.

When the predicates clear, the default returns the conversational surface to
`main.primary`, unless a pin or placement says otherwise.

Observability components (`frontier.table`, `evidence.trace`,
`inference.ledger`, `budget.meter`, `cycle.outcome`) are absent from this
default. Navigation can place one into `main.primary`. That placement is
operator-owned for the session.

### Precedence in one region

For each region, the first matching rule wins:

1. A pin targeting that region.
2. A placement targeting that region, including an operator collapse of the
   drawer or of navigation.
3. For `cut-through` only: each unplaced blocking component, in request order.
4. An admitted arrangement whose key matches.
5. The default tree.

A pin on `main.primary` does not dismiss a blocking request. The request
stays in the cut-through. The cut-through is not a pin target for any other
component. The operator may place a specific blocking component into
`main.primary`, `main.bottom`, or `right.drawer`. That placement removes it
from the cut-through and holds until the operator moves it or decides it.
The placement does not decide the request.

Arrangement cannot assign `nav` or `cut-through`. A component appears in at
most one region.

### Paint conditions

| Condition | Where | What is shown |
| --- | --- | --- |
| No applicable component, or no rows | the region | the region's fixed empty text, role `condition-empty`. A collapsed drawer shows nothing. |
| A slice omitted by disclosure | the component | `Withheld: <slice> (<reason>)`, role `condition-omitted`. An omission is not an empty list. |
| Painted revision older than current | shell indicator | both revisions, role `condition-stale` |
| A weight's revision differs from the candidate revision | `frontier.table` | the weight, marked stale, with site and revision |
| No arrangement for the current key | arrangement indicator | `default` |
| Request in flight, superseded, unaccepted, blocked, or rejected | arrangement indicator | the status and reason; the tree stays as it was |
| Allowance exhausted, or the site disabled | arrangement indicator | `exhausted` or `disabled`; pins, placements, cut-through, and the default tree hold |
| Session ended | the workspace | the last paint, static, with the reason; ingress is closed |

## 5. Workspace view

`view.workspace@1` is a state view for the operator principal, rendered from
one slice assembly at one revision. Policy may omit any slice. The manifest
records each omission and its reason. With no open goal, goal slices are
omitted and the conversational surface still paints.

| Slice | Contents drawn from current state |
| --- | --- |
| `goal` | id, purpose, status, success evidence |
| `authority` | read and write resource ids |
| `budget` | budget lines and the recovery allowance |
| `approvals` | approval records |
| `admission` | the admission request, green evidence, and held-out report counts and failure codes |
| `cycle` | the latest cycle outcome and not-selected reasons |
| `candidates` | the latest cycle's candidates, eligibility, weights, and the weights' revision |
| `actions` | action records |
| `artifacts` | report and publication identity, revision, and body only when policy discloses it |
| `notices` | `admission.decided`, `implementation.revoked`, and `evidence.invalidated`, with validation status |
| `crystallization` | crystallization state, without held-out case ids |
| `inferences` | goal inference records: site, role, kind, status, attempts, spent; no view content |
| `observations` | the most recent N observations: sequence, type, provenance, validation, cause; truncation disclosed |
| `availability` | project attachment names and kinds. No bodies. |

`inferences`, `crystallization`, report, and publication already exist on
`State`. `availability` is project state, outside the goal fold. The other
slices are selections over state the runtime already folds. The renderer does
not exist yet.

The arrange view is a further reduction, specified in §7. It is not this view.

## 6. Component vocabulary `vocabulary.workspace@1`

A component is trusted presentation code. It declares the slices it binds, the
operator observation types it may submit, the regions that may hold it, and
its interaction states. It has no AgentSOP contract, no admission, and no
grant. Nothing in the declaration names a renderer.

| Component | May occupy | Binds | Applies when | May submit |
| --- | --- | --- | --- | --- |
| `project.index@1` | `nav` | `availability` | always | a session-record selection, not an observation |
| `conversation.thread@1` | `main.primary`, `main.bottom`, `right.drawer` | `observations` | always | `operator.input` (planned; no runtime transition yet) |
| `goal.status@1` | `nav` | `goal`, `authority`, `notices` | a goal is open | |
| `approval.pending@1` | `cut-through`, and adaptive regions only by operator placement | `approvals` | one instance per pending request | `approval.decided` (`approved` or `denied`) |
| `admission.pending@1` | `cut-through`, and adaptive regions only by operator placement | `admission` | one instance per requested admission | `admission.decided` (`admitted`) |
| `work.actions@1` | `main.primary`, `main.bottom` | `actions` | `actions` is non-empty | `action.cancel_requested` |
| `editor@1` | `main.primary`, `main.bottom` | `artifacts` | `artifacts` is disclosed and non-empty | a correction, only as an existing observation or a granted write |
| `crystallization.progress@1` | `main.primary`, `main.bottom` | `crystallization` | crystallization is non-empty | |
| `notice.list@1` | `main.primary`, `main.bottom`, `right.drawer` | `notices` | `notices` is non-empty | |
| `frontier.table@1` | adaptive regions, by nav placement or arrangement | `candidates`, `cycle` | `candidates` is non-empty | |
| `evidence.trace@1` | adaptive regions, by nav placement or arrangement | `observations` | `observations` is non-empty | |
| `inference.ledger@1` | adaptive regions, by nav placement or arrangement | `inferences` | `inferences` is non-empty | |
| `budget.meter@1` | adaptive regions, by nav placement or arrangement | `budget` | a goal is open | |
| `cycle.outcome@1` | adaptive regions, by nav placement or arrangement | `cycle`, `actions` | a goal is open | |

`collapsed` is an occupant of `right.drawer` and of `nav`, not a component.

Each component that submits an observation receives a submit port narrowed to
its declared payload types. Submissions go through the trusted ingress handle
held by surface bootstrap. The runtime validates them with the rules it
already has. The component shows the recorded validation result. A decision
control paints the recorded status from a later workspace view. It does not
paint a decision before that view arrives.

`operator.input` is the planned observation for the conversational surface.
The payload is not in the runtime. Until it exists, the component renders
disclosed observations and the submit control stays disabled. Text in that
component does not authorize, complete, or dispatch anything.

`editor@1` is the one opener for every artifact. It invokes the
`artifact.present` capability specified in §6.1. Arrangement chooses the
editor. It does not choose a viewer.

What each component shows:

- `project.index` shows attachment labels and kinds. Selecting one writes
  active selection on the session record. Selection does not disclose a body
  to a model and does not grant use of a capability.
- `conversation.thread` shows disclosed operator observations in sequence,
  with provenance and validation. It does not present that sequence as the
  goal or as the action frontier.
- `goal.status` shows the authorized goal, status (`active`, `complete`, or
  `missed`), success evidence, and a notice count, in the density of `nav`.
  A framing proposal is not shown as the goal.
- `budget.meter` shows limit, reserved, and spent for each goal budget line,
  and the recovery allowance. The arrangement allowance stays on the shell
  indicator.
- `cycle.outcome` shows `dispatched`, `waiting`, `blocked` with its recorded
  reason, or `complete`, plus unreconciled uncertain actions and recovery
  exhaustion. The recorded reason is the text.
- `approval.pending` shows operation, contract revision, destination, effects,
  expected revision, reservation, validity in ticks, binding and report
  digests, and the request sequence. It shows no weight, no recommendation,
  and no pre-selected decision. One control covers one request.
- `admission.pending` shows operation, contract and corpus revisions,
  implementation id and source digest, whether red was demonstrated, green
  status, and held-out counts and failure codes. It shows no held-out inputs,
  expected outputs, or case ids. It always shows the sentence "Admission does
  not grant execution."
- `work.actions` shows action state, operation, reservation, whether a grant
  is present, cancel-requested, and reconciliation. An uncertain outcome stays
  uncertain. A requested cancellation stays requested until the action record
  says otherwise.
- `editor` shows the artifact's identity, kind, and revision, and paints the
  presentation returned by `artifact.present`. A withheld body is an omission,
  not an empty artifact, and the capability is not invoked.
- `notice.list` shows the fact, sequence, provenance, and validation status.
  A rejected notice is labeled rejected. A notice is not a grant and not
  dispatched work.
- `crystallization.progress` shows search, contract, corpus, red,
  implementation ids and digests, green, whether the held-out split is spent,
  admission, and revocation. It shows no held-out case ids or bodies.
- `frontier.table` shows operation, eligibility and any prohibition reason,
  weight with site and revision, and whether the candidate was selected or why
  not. A prohibited candidate is not actionable. A weight is not authority.
  There is no dispatch control.
- `evidence.trace` shows type, provenance, validation, and cause, plus a
  per-type summary of ids. Payload bodies of rejected or unknown-type
  observations stay hidden.
- `inference.ledger` shows site, role, kind, evaluated revision, status,
  reason, attempt count, routed unit ids, and spent. Model output is not
  shown as fact.

Still outside this vocabulary: approval revocation, admission denial,
capability revocation, evidence invalidation, and an experiment panel.
Admission denial has a payload value and no runtime path. This plan does not
add those paths.

Navigation always reaches the observability components. Opening one from
`nav` writes a placement. Arrangement cannot clear it. The next session does
not keep it.

### 6.1 Editor

Any artifact an action emits, and any document the project makes available,
opens in `editor@1`. The project index is the navigator the operator sees:
names, kinds, and resource references. Locators stay in the host. Source and
an agent-written document are the same operation.

The editor calls the capability host with `artifact.present`. The contract is
one operation for every kind:

```text
artifact.present
  input:   kind, revision, body
  output:  presentation { blocks, diagnostics }
  effects: none
```

The body is already disclosed by the workspace view, so the viewer does not
read storage and does not receive a locator. A withheld body is shown as an
omission. The capability is not called.

Kind selects an admitted implementation. The plain-text implementation
accepts every kind and is the baseline. A richer implementation accepts the
kinds it declares and returns the same output shape, with whatever structure
or diagnostics that kind warrants: typo spans, lint, a language diagnostic.
Those checks are fields of the presentation, or capabilities named in
`depends_on`, invoked under the same authority rules as any other
composition. They are not a second editor and not a branch in the shell.

The output names blocks, spans, and diagnostics. It carries no token values
and no toolkit types. The editor paints it with the session theme.

An operator correction is an existing observation type or a write under a
grant the runtime already issued. Keystrokes do not write by themselves.

Which implementations ship, and which checker capabilities they depend on,
can wait. The contract does not. A new kind is a new implementation of
`artifact.present`, admitted like any other capability.

### Default tree

`defaultTree(view, vocabulary, session)` is pure. It takes no clock and no
random source. Ties break in vocabulary order. Pins and placements are
applied by the precedence in §4 before this function fills what remains.

- `nav` holds `project.index` and, when a goal is open, `goal.status`.
- `cut-through` holds one instance per unplaced blocking request, in request
  order.
- Remaining adaptive regions follow the predicates in §4.
- A region with no occupant shows its empty state, or `collapsed` when that
  is the drawer's default.

## 7. `workspace.arrange`

A region is contested when it is adaptive, no pin or placement holds it, and
at least two offered components apply. A request is formed only when at least
one region is contested and a goal revision exists. `nav` and `cut-through`
are not questions. Blocking components are not criteria.

```text
EvaluationRequest
  request_id:  arr:<session>:<n>
  site:        workspace.arrange
  role:        working
  kind:        choice
  state:       arrange view, profile profile.workspace-arrange@1
  questions:   one choice per contested region
               instructions and criteria texts come from the vocabulary
               criteria are the component ids offered for that region
               right.drawer may also offer collapsed
  terms:       destinations from local configuration
               deadline from an injected clock reading plus the configured bound
               cost_ceiling equal to the reserved cost
               max_attempts from local configuration
  accept:      each choice names a criterion of its own question
               no component id is chosen twice
```

The gateway checks answer shape. The `accept` function checks criterion
membership and uniqueness.

The arrange view is a reduction of the workspace view at the same revision.
It contains goal status, the predicates of §4, whether any candidate exists,
whether any action is running, uncertain, or failed, whether any notice
exists, the crystallization stage, whether any observation was rejected,
whether any inference is unaccepted or in flight, which regions are already
pinned or placed (ids only), and one budget bucket per line (`available`,
`low`, or `exhausted`, thresholds fixed in the vocabulary).

The arrange view withholds `approvals` and `admission` (`protected`), the goal
purpose and every observation payload (`free_text`), and resource ids,
principal ids, digests, the theme, attachment bodies, and counts. It
withholds any slice the workspace view already omitted. Answer probabilities
are stored on the session record for later evaluation. They are not weights.

The arrangement allowance is separate from the goal budget. Spend is
operator-surface cost. It does not move goal budget lines or the M4 and M5
baselines. The allowance is finite. Exhaustion leaves pins, placements,
cut-through, and the default tree in place.

The arrangement key digests the vocabulary version, the arrange-profile
version, the arrange-view content, and the session's pins and placements. An
operator pin changes the key and drops that region out of later questions.

### Validation

A proposal is admitted whole or rejected whole. A rejection stays in the
session record with its reason.

1. The request is in the session record, was reserved, and the gateway outcome
   is `accepted`.
2. The current goal revision equals the revision the request evaluated.
   Otherwise the reason is `stale`. With no open goal, no request is formed.
3. The vocabulary reference and the theme reference equal the session's.
4. The shape is closed: contested adaptive-region ids mapped to component ids
   or, for the drawer, `collapsed`. No `nav`. No `cut-through`. No pinned or
   placed region. No extra field.
5. Each component id is a criterion of that region's question, and no id is
   repeated.
6. Every slice each chosen component binds is disclosed in the current
   workspace view.
7. The arrangement key recomputed now equals the key stored with the request.

Content on screen always comes from the current workspace view. An admitted
arrangement chooses which component an unclaimed adaptive region shows.
Cut-through is recomputed on every paint.

A key change marks the arrangement `invalidated`. The default tree paints the
unclaimed regions until a new arrangement is admitted.

## 8. Arrangement cycle

```text
paint → observe view → reserve → evaluate → record → validate → paint
  ↑                                                              |
  └──────────── next state revision reported by the read port ───┘
```

On every revision the read port reports, the surface renders the workspace
view and paints. Pins, placements, and cut-through are applied first. An
unclaimed adaptive region shows the admitted arrangement when its key
matches, and the default tree otherwise. Painting does not wait on judgment.
Operator navigation does not wait on judgment.

A request is formed when a goal is open, destinations are configured, the
allowance covers one reservation, the key differs from the admitted
arrangement, no request is in flight, this key is under its request cap, and
at least one region is contested.

Reserve writes the request, the key, the evaluated revision, the questions,
and the reservation to the session record before the call. If that write
fails, there is no call.

`gateway.evaluate` runs asynchronously. Runtime transitions, operator
submissions, placements, and pins do not wait on it. If the goal revision
advances, or the operator pins or places a contested region, while the
request is in flight, the surface aborts it and records `superseded`. Spent
attempts stay charged.

The gateway outcome is then written: status, reason, attempts, and spent.
Spend is charged once. The rest of the reservation is released. An `accepted`
outcome runs the checks in §7. Any other result leaves the tree unchanged and
shows its reason on the arrangement indicator.

On detach or runtime stop, the surface aborts an in-flight request, appends
`detached`, and paints the closing view. Goals, the project, and the
observation log stay as they were.

## 9. Renderers

The specification is the vocabulary, the token roles, the regions, the
interaction states, and the precedence in §4. A renderer maps those to a
medium. It does not add a component id, a region, or a token role.

The first renderer is web. It binds token roles to its own values and regions
to its own layout. That binding lives with the renderer, not in
`vocabulary.workspace@1`.

A later native renderer, including Omarchy surfaces and launchers, consumes
the same specification. This plan does not design that renderer.

## 10. Ownership

A future `packages/surface` owns the setup surface, local configuration, the
project record, `tokens@1`, the theme records, the shell, the components,
`vocabulary.workspace@1`, the default tree, arrange-view reduction, request
formation, arrangement validation, the session record, and painting.

It may depend on Weave view and ingress types and on the gateway's request,
outcome, and `InferenceGateway` types. Those are supplied at bootstrap.
`packages/weave` gains the `view.workspace@1` renderer and the read port. It
does not learn regions, tokens, vocabulary, placements, or sessions, and it
does not put `workspace.arrange` on the action frontier.

`packages/gateway` is unchanged. `workspace.arrange` is a judgment-site
string. Routing evidence accrues per site. Jev, or any other routed unit that
answers `choice`, may serve it.

AgentSOP and AgentFabric import nothing from the surface package. Shell
components are not capabilities. Viewers are implementations of
`artifact.present`, owned by AgentFabric and invoked through the capability
host supplied at bootstrap. The surface package may depend on AgentSOP
contract types. It does not import the host's internals.

When the package exists, `checks/import-direction.mjs` allows `surface` to
depend on `weave`, `gateway`, and `agentsop`, and forbids `weave`, `gateway`,
`agentsop`, and `agentfabric` from depending on `surface`.

This plan does not choose a component toolkit, add a dependency, open a
network protocol, generate component source, implement an Omarchy renderer,
or edit `VISION.md`.

## 11. Open questions

1. **Strict revision equality.** If observations arrive faster than a `choice`
   call returns, every answer is `stale` and the default tree holds. Admitting
   on arrange-view digest equality would diverge from `weights.recorded` and
   needs its own decision.
2. **Evaluation labels.** Nothing yet labels a `workspace.arrange` answer as
   right or wrong. Until labels exist, no route earns evidence, and routing
   stays on a conservative configured route. Operator corrections of an
   arrangement are placements, and they are a possible future label source.
3. **`operator.input`.** The conversational surface needs this observation.
   Its payload, what transitions it may support, and how it relates to
   `goal.opened` are not specified. Until they are, the submit control stays
   disabled.
4. **Project persistence.** Where the project record and its attachments live,
   and whether an attachment of a repository is a resource reference the host
   already knows how to mint.
5. **Artifact slice and viewer implementations.** `report` and `publication`
   exist on `State`. The `artifacts` slice's exact fields, and when a body is
   disclosable, are not fixed. Which implementations of `artifact.present`
   ship beyond plain text, and which checker capabilities they depend on, are
   not fixed either. The plain-text implementation still presents a disclosed
   body.
6. **Renderer bindings.** Web is first. Which token bindings that renderer
   must supply, and how a missing binding fails, are open. Omarchy is a later
   renderer of this specification, not part of this plan.
7. **Arrangement allowance across sessions.** Whether one operator has a
   ceiling that spans sessions.
8. **Citing the painted revision on `approval.decided`.** That would change
   the M1 payload. This plan does not.
9. **Admission denial.** Whether the runtime grows a path so
   `admission.pending` can submit `denied`.
10. **More than one session, project, or operator.** That waits on the
    external authority channel left open in
    [ARCHITECTURE.md](../ARCHITECTURE.md) §11.
