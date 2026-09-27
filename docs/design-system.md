# Operator design system

This is a plan for the operator surfaces, the theme, and the dashboard
component vocabulary. It is not a milestone, and it does not change an
acceptance boundary in [VISION.md](../VISION.md). Conversation remains one
interface. These surfaces are adapters over runtime state.

Terms live in [CONTEXT.md](../CONTEXT.md). This document uses them.

## Assumptions

The repository cannot yet verify these. They bound the first cut:

- One runtime, one open goal, one operator, and at most one dashboard.
- The runtime can expose an in-process read port that reports a new state
  revision and renders `view.dashboard@1`. The port carries no observation
  payloads and does not submit them.
- Local configuration names a principal the runtime is already configured to
  accept. The record itself grants nothing.

## Decision

Setup is a deterministic terminal surface. Once local configuration validates
and a goal is open on a running runtime, one dashboard attaches. That
attachment is a session.

The dashboard paints fixed chrome resolved through one theme record. Regions
inside the chrome hold components from a closed vocabulary. Protected regions
are filled by deterministic rules on every paint. Variable regions hold one
component each.

The judgment site `dashboard.arrange` may choose, for a contested variable
region, one component id from that region's offer. It sends one evaluation
request of kind `choice` and role `working`. The answer is an observation of
the session, not of the goal. It becomes an arrangement only at the state
revision it evaluated, against the session's vocabulary and theme, and only
within the arrangement allowance.

An unusable, stale, rejected, or superseded answer leaves the last admitted
arrangement, or the default tree, in place. The dashboard is never blank.

No model writes components, token values, or markup. The vocabulary grows by a
trusted revision of the vocabulary record.

## 1. Why arrangements stay off the observation log

`weights.recorded` is accepted only when its `state_revision` equals the
current revision. A gateway weigh binds that field to the sequence of its
`inference.requested` record. An accepted observation appended while the call
is in flight rejects the weights.

An arrangement written into the observation log would be such an observation.
It would also move the M4 and M5 cost baselines. The dashboard therefore keeps
a session record. The record cites goal revisions and never advances them.
Presentation work cannot make a goal judgment stale.

## 2. Boot

The setup surface is a fixed sequence:

1. Operator principal.
2. Theme selection from the shipped theme records. Each candidate is previewed
   by resolving the chrome through that record.
3. Arrangement allowance, per-key request cap, and the destinations permitted
   to `dashboard.arrange`. An empty destination list disables the site.
4. Validation, then the local-configuration record.

Until a theme is selected, setup renders with `theme.weave-default@1`. Setup
requests no inference and writes nothing to the observation log.

A dashboard boots only when local configuration validates, a runtime is
running and supplies the read port, `state.goal` exists with status `active`,
and no other session is attached. Boot appends `attached` to the session
record, renders the dashboard view, and paints the default tree. The
arrangement cycle starts after that paint.

Without an open goal, no session begins. Ending a session detaches the
surface. It does not complete, pause, or cancel the goal, release a
reservation, or write to the observation log. Recovery does not restore a
session.

## 3. Theme

Components name token roles. A theme record supplies every role in
`tokens@1`. One theme resolves every paint in a session. A judgment neither
sees nor sets it. Changing theme means detaching, running setup, and
attaching again.

Color never carries meaning alone. Every status role has a text mark, so a
monochrome terminal loses nothing.

### Token roles `tokens@1`

| Group | Roles | Rule |
| --- | --- | --- |
| Color, base | `canvas`, `surface`, `surface-raised`, `border`, `text`, `text-muted`, `focus` | |
| Color, provenance | `provenance-operator`, `provenance-runtime`, `provenance-host`, `provenance-clock`, `provenance-judgment`, `provenance-untrusted` | Judgment and gateway share `provenance-judgment`. Test and unrecognized provenance use `provenance-untrusted`. Model-derived values use `provenance-judgment`. |
| Color, eligibility | `eligibility-allowed`, `eligibility-approval`, `eligibility-prohibited` | |
| Color, action | `action-pending`, `action-running`, `action-succeeded`, `action-failed`, `action-uncertain`, `action-cancelled` | `action-failed` and `action-uncertain` are distinct values. |
| Color, validation | `validation-accepted`, `validation-rejected`, `validation-unknown` | `validation-accepted` and `validation-rejected` are distinct values. |
| Color, condition | `condition-empty`, `condition-omitted`, `condition-stale`, `condition-exhausted` | |
| Color, decision | `decision-request`, `decision-approve`, `decision-deny` | Only the protected `decisions` region may reference these. `decision-approve` and `decision-deny` are distinct values. |
| Type | `title`, `heading`, `body`, `label`, `id`, `numeric` | Weight, emphasis, fixed width, tabular figures. Family and size belong to a graphical renderer, which this plan does not choose. |
| Space | `space.0` through `space.5` | Integer multiples of `space.unit`. A renderer maps one unit to one terminal cell or one fixed length. |
| Density | `density.mode` (`comfortable` or `compact`), `density.list-rows`, `density.gutter` | Density changes spacing and list length only. |
| Elevation | `elevation.base`, `elevation.raised`, `elevation.overlay` | `overlay` is reserved for confirming a decision. Nothing overlays a protected region. |
| Marks | one text mark per status role | Examples: `mark.uncertain`, `mark.stale`, `mark.rejected`, `mark.omitted`. |

### Theme record

The values below illustrate the record. They are not a brand palette. `srgb`
stays null until a graphical renderer exists.

```text
id:       theme.weave-default
version:  1
roles:    tokens@1
color:    each tokens@1 color role → { ansi: 0–15, srgb: null }
type:     heading { weight: bold }, id { fixed_width: true }, numeric { tabular: true }
space:    { unit: 1, scale: [0, 1, 2, 3, 4, 6] }
density:  { mode: comfortable, list_rows: 12, gutter: 2 }
elevation:{ base: 0, raised: 1, overlay: 2 }
mark:     { uncertain: "?", stale: "~", rejected: "x", omitted: "-" }
digest:   canonical digest of this record
```

`theme.weave-daylight@1` is the same shape with a light canvas and
`density.mode: compact`. Setup rejects a record that omits a role, omits a
mark for a status role, or gives one value to a pair that must differ.

A conformance check on the surface package confirms that components reference
role names from `tokens@1` only, contain no literal color or type values, and
use `decision-*` roles only in `decisions`. The check covers trusted source.
It does not inspect model output.

A session fixes one theme reference: id, version, and digest. Every component
tree and every arrangement cites it. Arrangement validation rejects a
mismatch. The arrange view, the request, the answer, and the arrangement
contain no token names and no token values.

## 4. Chrome

Reading and focus order is fixed by the vocabulary version:

1. Header, owned by chrome: session id, goal id, painted revision (and the
   current revision when they differ), theme reference, arrangement indicator,
   and arrangement allowance remaining.
2. Region `status`, protected.
3. Region `decisions`, protected.
4. Regions `primary`, `secondary`, and `detail`, variable.
5. Key legend, owned by chrome.

A renderer may place the variable regions side by side. It may not reorder
regions, cover a protected region, scroll a protected region away behind
variable content, or shrink a protected region below its minimum extent.

When a decision request arrives, chrome shows an indicator. Focus does not
move onto an approve or deny control.

The operator's "frame" is this chrome. *Frame* stays with framing:
`profile.frame@1`, the `goal.frame` site, and the `framing` role.

### Regions

| Region | Kind | Holds | Minimum extent |
| --- | --- | --- | --- |
| `status` | protected | `goal.status`, `budget.meter`, `cycle.outcome` | one line per component |
| `decisions` | protected | one `approval.pending` per pending approval, then one `admission.pending` per requested admission, in request order | one line per request up to `density.list-rows`, then a total count; never zero lines while a request is pending |
| `primary` | variable | offer: `frontier.table`, `work.actions` | fixed by the vocabulary |
| `secondary` | variable | offer: `notice.list`, `crystallization.progress` | fixed by the vocabulary |
| `detail` | variable | offer: `evidence.trace`, `inference.ledger` | fixed by the vocabulary |

Offers do not overlap. Each `choice` question is independent, a component
appears at most once, and a region keeps one purpose. A new offer is a
vocabulary revision.

Every fact that needs the operator has a count in a protected region. An
arrangement chooses which detail a variable region shows. It cannot remove
that count.

### Paint conditions

| Condition | Where | What is shown |
| --- | --- | --- |
| No applicable component, or no rows | the region | the region's fixed empty text, role `condition-empty` |
| A slice omitted by disclosure | the component | `Withheld: <slice> (<reason>)`, role `condition-omitted`. An omission is not an empty list. |
| Painted revision older than current | header | both revisions, role `condition-stale` |
| A weight's revision differs from the candidate revision | `frontier.table` | the weight, marked stale, with site and revision |
| No arrangement for the current key | arrangement indicator | `default` |
| Request in flight, superseded, unaccepted, blocked, or rejected | arrangement indicator | the status and reason; the tree stays as it was |
| Allowance exhausted, or the site disabled | arrangement indicator | `exhausted` or `disabled`; the default tree holds for the rest of the session |
| Session ended | the dashboard | the last paint, static, with the reason; ingress is closed |

## 5. Dashboard view

`view.dashboard@1` is a state view for the operator principal, rendered from
one slice assembly at one revision. Policy may omit any slice. The manifest
records each omission and its reason.

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
| `notices` | `admission.decided`, `implementation.revoked`, and `evidence.invalidated`, with validation status |
| `crystallization` | crystallization state, without held-out case ids |
| `inferences` | goal inference records: site, role, kind, status, attempts, spent; no view content |
| `observations` | the most recent N observations: sequence, type, provenance, validation, cause; truncation disclosed |

`inferences` and `crystallization` already exist on `State`. The other slices
are selections over state the runtime already folds. The renderer does not
exist yet.

## 6. Component vocabulary `vocabulary.dashboard@1`

A component is trusted presentation code. It declares the slices it binds, the
operator observation types it may submit, and the regions that may hold it.
It has no AgentSOP contract, no admission, and no grant.

| Component | Region | Binds | Shown when | May submit |
| --- | --- | --- | --- | --- |
| `goal.status@1` | `status` | `goal`, `authority`, `notices` | always | |
| `budget.meter@1` | `status` | `budget` | always | |
| `cycle.outcome@1` | `status` | `cycle`, `actions` | always | |
| `approval.pending@1` | `decisions` | `approvals` | one instance per pending request | `approval.decided` (`approved` or `denied`) |
| `admission.pending@1` | `decisions` | `admission` | one instance per requested admission | `admission.decided` (`admitted`) |
| `frontier.table@1` | `primary` | `candidates`, `cycle` | `candidates` is non-empty | |
| `work.actions@1` | `primary` | `actions` | `actions` is non-empty | `action.cancel_requested` |
| `notice.list@1` | `secondary` | `notices` | `notices` is non-empty | |
| `crystallization.progress@1` | `secondary` | `crystallization` | crystallization is non-empty | |
| `evidence.trace@1` | `detail` | `observations` | `observations` is non-empty | |
| `inference.ledger@1` | `detail` | `inferences` | `inferences` is non-empty | |

Each component receives a submit port narrowed to its declared payload types.
Submissions go through the trusted ingress handle held by surface bootstrap.
The runtime validates them with the rules it already has. The component shows
the recorded validation result. A decision control paints the recorded status
from a later dashboard view. It does not paint a decision before that view
arrives.

What each component shows:

- `goal.status` shows the authorized goal, status (`active`, `complete`, or
  `missed`), success evidence, authority resource ids, and a notice count. A
  framing proposal is not shown as the goal.
- `budget.meter` shows limit, reserved, and spent for each goal budget line,
  and the recovery allowance. The arrangement allowance stays in the header.
- `cycle.outcome` shows `dispatched`, `waiting`, `blocked` with its recorded
  reason, or `complete`, plus unreconciled uncertain actions and recovery
  exhaustion. The recorded reason is the text. A model does not replace it.
- `approval.pending` shows operation, contract revision, destination, effects,
  expected revision, reservation, validity in ticks, binding and report
  digests, and the request sequence. It shows no weight, no recommendation,
  and no pre-selected decision. One control covers one request.
- `admission.pending` shows operation, contract and corpus revisions,
  implementation id and source digest, whether red was demonstrated, green
  status, and held-out counts and failure codes. It shows no held-out inputs,
  expected outputs, or case ids. It always shows the sentence "Admission does
  not grant execution."
- `frontier.table` shows operation, eligibility and any prohibition reason,
  weight with site and revision, and whether the candidate was selected or why
  not. A prohibited candidate is not actionable. A weight is not authority.
  There is no dispatch control: dispatch has no operator observation.
- `work.actions` shows action state, operation, reservation, whether a grant
  is present, cancel-requested, and reconciliation. An uncertain outcome stays
  uncertain. A requested cancellation stays requested until the action record
  says otherwise.
- `notice.list` shows the fact, sequence, provenance, and validation status.
  A rejected notice is labeled rejected. A notice is not a grant and not
  dispatched work.
- `crystallization.progress` shows search, contract, corpus, red,
  implementation ids and digests, green, whether the held-out split is spent,
  admission, and revocation. It shows no held-out case ids or bodies.
- `evidence.trace` shows type, provenance, validation, and cause, plus a
  per-type summary of ids. Payload bodies of rejected or unknown-type
  observations stay hidden.
- `inference.ledger` shows site, role, kind, evaluated revision, status,
  reason, attempt count, routed unit ids, and spent. Model output is not
  shown as fact.

Outside this vocabulary, for a later revision: approval revocation, admission
denial, capability revocation, evidence invalidation, clarification,
operator-to-goal communication, an experiment panel, and an artifact viewer.
Clarification and communication have no operator observation type. Admission
denial has a payload value and no runtime path. The first vocabulary does not
invent those paths.

### Default tree

`defaultTree(view, vocabulary)` is a pure function of the dashboard view and
the vocabulary. It takes no clock and no random source. Ties break in
vocabulary order.

- `status` holds its three components.
- `decisions` holds one instance per pending request, in request order.
- A variable region holds the first offered component whose slices are
  disclosed and whose applicability slice is non-empty. Otherwise the region
  shows its empty state.

Applicability is data on the vocabulary, evaluated against the view manifest.

## 7. `dashboard.arrange`

A variable region is contested when both offered components apply. A request
is formed only when at least one region is contested. Protected regions are
filled before the request and are not questions.

```text
EvaluationRequest
  request_id:  arr:<session>:<n>
  site:        dashboard.arrange
  role:        working
  kind:        choice
  state:       arrange view, profile profile.dashboard-arrange@1
  questions:   one choice per contested region
               instructions and criteria texts come from the vocabulary
               criteria are the component ids offered for that region
  terms:       destinations from local configuration
               deadline from an injected clock reading plus the configured bound
               cost_ceiling equal to the reserved cost
               max_attempts from local configuration
  accept:      each choice names a criterion of its own question
```

The gateway checks answer shape. The `accept` function also checks that the
choice is one of the question's criteria.

The arrange view is a reduction of the dashboard view at the same revision.
It contains goal status, cycle outcome, whether any candidate exists, whether
any action is running, uncertain, or failed, whether any notice exists, the
crystallization stage, whether any observation was rejected, whether any
inference is unaccepted or in flight, and one budget bucket per line
(`available`, `low`, or `exhausted`, thresholds fixed in the vocabulary).

The arrange view withholds `approvals` and `admission` (`protected`), the goal
purpose and every observation payload (`free_text`), and resource ids,
principal ids, digests, the theme, and counts. It withholds any slice the
dashboard view already omitted. Answer probabilities are stored on the session
record for later evaluation. They are not weights.

The arrangement allowance is separate from the goal budget. Spend is operator-
surface cost. It does not move goal budget lines or the M4 and M5 baselines.
The allowance is finite. Exhaustion leaves the default tree in place.

### Validation

A proposal is admitted whole or rejected whole. A rejection stays in the
session record with its reason.

1. The request is in the session record, was reserved, and the gateway outcome
   is `accepted`.
2. The current goal revision equals the revision the request evaluated.
   Otherwise the reason is `stale`.
3. The vocabulary reference and the theme reference equal the session's.
4. The shape is closed: contested variable-region ids mapped to component ids.
   No protected region. No extra field.
5. Each component id is a criterion of that region's question.
6. Every slice the chosen component binds is disclosed in the current
   dashboard view.
7. The arrangement key recomputed from the current view equals the key stored
   with the request.

The key is a digest of the vocabulary version, the arrange-profile version,
and the arrange-view content. Content on screen always comes from the current
dashboard view. An admitted arrangement chooses which component a variable
region shows. Protected regions are recomputed on every paint and never come
from an arrangement.

A key change marks the arrangement `invalidated`. The default tree paints
until a new arrangement is admitted.

## 8. Arrangement cycle

```text
paint → observe view → reserve → evaluate → record → validate → paint
  ↑                                                              |
  └──────────── next state revision reported by the read port ───┘
```

On every revision the read port reports, the surface renders the dashboard
view and paints. Protected regions come from the rules. A variable region
shows the admitted arrangement when its key matches, and the default tree
otherwise. Painting does not wait on judgment.

A request is formed when the goal is open, destinations are configured, the
allowance covers one reservation, the key differs from the admitted
arrangement, no request is in flight, this key is under its request cap, and
at least one region is contested.

Reserve writes the request, the key, the evaluated revision, the questions,
and the reservation to the session record before the call. If that write
fails, there is no call.

`gateway.evaluate` runs asynchronously. Runtime transitions and operator
submissions do not wait on it. If the goal revision advances while the request
is in flight, the surface aborts it and records `superseded`. Spent attempts
stay charged.

The gateway outcome is then written: status, reason, attempts, and spent.
Spend is charged once. The rest of the reservation is released. An `accepted`
outcome runs the checks in §7. Any other result leaves the tree unchanged and
shows its reason on the arrangement indicator.

On detach, goal closure, or runtime stop, the surface aborts an in-flight
request, appends `detached`, and paints the closing view. The goal and the
observation log stay as they were.

## 9. Ownership

A future `packages/surface` owns the setup surface, local configuration,
`tokens@1`, the theme records, chrome, the components,
`vocabulary.dashboard@1`, the default tree, arrange-view reduction, request
formation, arrangement validation, the session record, and painting.

It may depend on Weave view and ingress types and on the gateway's request,
outcome, and `InferenceGateway` types. Those are supplied at bootstrap.
`packages/weave` gains the `view.dashboard@1` renderer and the read port. It
does not learn regions, tokens, vocabulary, or sessions, and it does not put
`dashboard.arrange` on the action frontier.

`packages/gateway` is unchanged. `dashboard.arrange` is a judgment-site string.
Routing evidence accrues per site. Jev, or any other routed unit that answers
`choice`, may serve it.

AgentSOP and AgentFabric import nothing from the surface package. Components
are not registered as capabilities.

When the package exists, `checks/import-direction.mjs` allows `surface` to
depend on `weave` and `gateway`, and forbids `weave`, `gateway`, `agentsop`,
and `agentfabric` from depending on `surface`.

This plan does not choose a UI toolkit, add a dependency, open a network
protocol, generate component source, or edit `VISION.md`.

## 10. Open questions

1. **Strict revision equality.** If observations arrive faster than a `choice`
   call returns, every answer is `stale` and the default tree holds. Admitting
   on arrange-view digest equality would diverge from `weights.recorded` and
   needs its own decision.
2. **Evaluation labels.** Nothing yet labels a `dashboard.arrange` answer as
   right or wrong. Until labels exist, no route earns evidence, and routing
   stays on a conservative configured route.
3. **Renderer target.** A terminal-only dashboard can keep `srgb` null. A
   graphical renderer needs color values, type families, and sizes.
4. **Session-record retention.** Whether the arrangement allowance also has a
   ceiling across sessions for one operator.
5. **Who submits `goal.opened`.** No surface yet authors a goal. Setup does
   not, in this plan.
6. **Citing the painted revision on `approval.decided`.** That would change
   the M1 payload. This plan does not.
7. **Admission denial.** Whether the runtime grows a path so
   `admission.pending` can submit `denied`.
8. **More than one session or operator.** That waits on the external
   authority channel left open in [ARCHITECTURE.md](../ARCHITECTURE.md) §11.
