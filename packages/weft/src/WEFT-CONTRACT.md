# Weft record contract v1

Status: contract only (W1, #183). The validator in `src/validate.ts` is a
placeholder that accepts everything; `test/contract.test.ts` runs the
fixtures in `fixtures/records.json` against it and is red by design
(`npm run test:weft-contract`). W2 (#184) implements the validator to this
contract, makes the test green, moves it onto the compiled package build and
adds it to `npm run verify`. W3 (#185) maps `weave.trace@1` onto these records; W4 (#186)
decides whether any content may be recorded inline.

## What a Weft trace is

A **Weft trace** is the set of Weft records that share a `trace_id`. The
composition root chooses that correlation scope. In Loom it is one goal. A
gateway or Fabric host used outside Loom chooses its own, e.g. one benchmark
run.

A Weft trace is a projection made for inspection, attribution, debugging and
evaluation. It is not authoritative:

- It is not the observation log. No state transition, grant, approval,
  admission, promotion or completion may be derived from a Weft record.
- It is not Loom's `Trace` (observations plus cycle records,
  `packages/weave/src/types.ts` §9). That record stays Loom's.
- Replay and recovery never read it. They remain defined over recorded
  observations and historical versions. A Weft record may cite observations
  so a reader can find them; the citation is an index, not evidence of its own.
- Emitting is one-way. A failing, slow or absent sink must not change state,
  scheduling, budgets or outcomes (proved in W5).

`thread_id` names a Loom **Thread**: a causally related sequence of actions and
observations within a goal. Correlation across goals or runtimes is outside v1.
If it becomes necessary it gets its own term and its own field; `thread_id` is
not widened to cover it.

## Envelope

A record is a JSON object with exactly these keys, serialized in this order:

| Key | Type | Rule |
| --- | --- | --- |
| `schema` | string | `"weft.record@1"` |
| `trace_id` | id | Correlation scope |
| `record_id` | id | Unique within the trace |
| `emitter` | object | `{ "kind": "loom" \| "gateway" \| "fabric" \| "external", "id": id }` |
| `sequence` | count | Strictly increasing per `(trace_id, emitter.id)`; gaps allowed |
| `kind` | code | One of the kinds below |
| `thread_id` | id \| null | Loom Thread, when the record belongs to one |
| `parent_id` | id \| null | Containing record in the same trace (e.g. attempt → route) |
| `links` | link[] | At most 32 |
| `evidence` | evidence[] | At most 64 |
| `fields` | object | Kind-specific; see below |

Missing keys, extra keys, wrong types and unknown `schema` values are rejected.
Unlike the observation log, which retains unknown payload types for diagnosis,
Weft fails closed: a record it cannot validate is not stored.

**Time.** Records carry no wall-clock timestamp. Order within one emitter comes
from `sequence`. Order across emitters comes only from `parent_id` and
`links`, never from arrival time. Durations an emitter measured itself are
fields (`latency_ms`). Time of day, when it matters, comes from a clock
observation cited in `evidence`.

**Links.** `{ "rel": rel, "record_id": id }`, where `rel` is one of
`caused_by`, `joins`, `supersedes`, `cancels`, `handoff`, `retry_of`. A link
targets a record in the same trace. It may point at a record not yet received,
because emitters run concurrently; readers resolve links when they query. A
record may not link to itself, and `(rel, record_id)` pairs are unique within a
record. Handoffs between threads or emitters are `handoff` links; there is no
separate handoff kind.

**Evidence.** `{ "source": source, "ref": id }`, where `source` is one of
`observation`, `inference_request`, `invocation`, `check`, `external`. A record
whose `emitter.kind` is `loom` must cite at least one `observation`, because
everything Loom reports was observed first. Pairs are unique within a record.

**Identity and idempotency.** `(trace_id, record_id)` identifies a record.
Re-submitting an identical record is a no-op. Submitting a different record
under the same identity is a conflict and is rejected; the first record stands.
This is a store rule. The record validator cannot see other records.

**Size.** A serialized record is at most 16 KiB. List bounds are stated per
field.

## Value types

| Type | Rule |
| --- | --- |
| id | `^[A-Za-z0-9_.:@-]{1,128}$`, and it fails the repository credential screen at token starts (`weave.trace@1`'s `safeId` until W3 resolves #158). `@` is allowed because contract revisions and routed units use it (`boolean.task@jev-1.13.0`); `weave.trace@1` ids remain a subset |
| code | `^[a-z][a-z0-9_.@:-]{0,63}$`; a closed vocabulary where one is listed |
| count | Non-negative safe integer |
| metric | Finite number ≥ 0 |
| ratio | Finite number in [0, 1] |
| flag | Boolean |
| digest | `^sha256:[0-9a-f]{64}$` |
| content | `{ "content_class": class, "digest": digest }`, optionally plus `"ref": id` |

`content_class` uses the existing glossary **content class**: `public`,
`non_sensitive`, `sensitive`, `private`. A content value names and fingerprints
text held elsewhere; v1 has no way to carry the text itself. A bare string or
any other key in a content position is rejected with `content`. W4 decides if
and when inline content is allowed, and under what policy.

A field may be `null` only where its type says so. List fields are arrays of
the stated type and bound; an element in excess of the bound is rejected.

## Kinds

Fields not listed for a kind are rejected. *Required* fields must be present.
Everything else is optional.

### `goal.intent`

The goal as Loom recorded it. `thread_id` is null.

- `goal_ref` id, required
- `statement` content, required
- `criteria` id[] ≤ 64

### `thread.transition`

Requires a non-null `thread_id`.

- `transition` code, required: `opened`, `joined`, `superseded`, `cancelled`,
  `closed`

`joined` requires a `joins` link and `superseded` a `supersedes` link to the
record of the other thread's transition.

### `cycle.weighed`

One Loom cycle: the candidates it considered, how they were weighted, what
policy did with them and which were selected.

- `cycle_no` count, required
- `state_revision` count, required
- `procedure` code, required
- `weights_ref` id | null
- `cost_micros` count
- `candidates` candidate[] ≤ 256, required. Each candidate is an object with
  exactly:
  - `candidate_ref` id
  - `operation` code
  - `eligibility` code: `allowed`, `approval_required`, `prohibited`
  - `weight` metric | null
  - `disposition` code: what happened to the candidate in this cycle

  Loom weighs and selects only `allowed` candidates (`runtime.ts`
  `runCycleOnce`); the others are filtered by policy first. The rules follow
  from that, one disposition per path:

  | `disposition` | Meaning | `eligibility` | `weight` |
  | --- | --- | --- | --- |
  | `selected` | Dispatched this cycle | `allowed` | any |
  | `dependency`, `conflict`, `stale_read_set`, `budget` | Rejected by the scheduler for that reason | `allowed` | any |
  | `not_reached` | Eligible, but the cycle selected nothing from it: weighing waited, was unaccepted or was blocked | `allowed` | any |
  | `policy_filtered` | Never weighed or selected. Its eligibility gives the reason, and an `approval_required` candidate waits on an approval request | `approval_required` or `prohibited` | null |

  Any other combination is rejected.

### `judgment`

The answer a judgment site received. It is an observation, not authority.

- `site` code, required
- `request_ref` id, required
- `accepted` flag, required
- `confidence` ratio
- `routed_unit` id

### `route.selected`

The gateway's routing decision for one inference request.

- `request_ref` id, required
- `routed_unit` id, required
- `tier` code: `decision`, `flash`, `standard`, `strong`
- `excluded` exclusion[] ≤ 64. Each is `{ "routed_unit": id, "reason": code }`.

### `inference.attempt`

One gateway attempt. A retry links to the attempt it repeats with `retry_of`.

- `request_ref` id, required
- `routed_unit` id, required
- `attempt_no` count, required
- `disposition` code, required: `accepted`, `unaccepted`, `failed`
- `input_tokens` count
- `output_tokens` count
- `spent_micros` count
- `cost_is_upper_bound` flag
- `latency_ms` metric

### `capability.invoked`

- `contract_rev` id, required
- `implementation` id, required
- `status` code, required: `succeeded`, `failed`, `uncertain`, `cancelled`
- `invocation_ref` id
- `execution_tier` code
- `failure` code. Present only when `status` is `failed`.
- `latency_ms` metric

### `action.transition`

- `action_ref` id, required
- `operation` code, required
- `state` code, required: `pending`, `running`, `succeeded`, `failed`,
  `uncertain`, `cancelled`
- `contract_rev` id | null

### `context.assembled`

A slice assembly or state view handed to a consumer. It records which slices
filled it and how much was disclosed, never the disclosed text.

- `assembly_ref` id, required
- `view_ref` id
- `consumer` code
- `slices` code[] ≤ 64
- `source_revision` count
- `omissions` count
- `disclosed_bytes` count
- `cost_micros` count

### `budget`

- `line` code, required: `actions`, `judgments`, `cost`
- `limit` count
- `reserved` count
- `spent` count

### `outcome`

- `subject` code, required: `goal`, `thread`, `action`
- `subject_ref` id, required
- `status` code, required: `complete`, `missed`, `succeeded`, `failed`,
  `cancelled`, `uncertain`
- `criteria_met` count
- `criteria_total` count. If both are present, `criteria_met` ≤
  `criteria_total`.

An outcome record reports what Loom recorded. It does not make the goal
complete.

### `error`

- `code` code, required
- `retryable` flag

Error records carry a code, never a message, stack or provider body.

## Rejection reasons

The validator returns `{ "ok": true }` or `{ "ok": false, "reason": reason }`
with the first applicable reason, checked in this order:

1. `envelope`: not an object; missing, extra or mistyped envelope keys; unknown
   `schema`; bad `emitter`; record larger than 16 KiB
2. `id`: an id fails the pattern or the credential screen
3. `sequence`: not a count
4. `kind`: unknown kind, or a kind's `thread_id` rule fails
5. `link`: bad link shape or `rel`, a self link, a duplicate pair, more than 32
   links, or a transition that lacks its required link
6. `evidence`: bad evidence shape or `source`, a duplicate pair, more than 64
   entries, or a Loom record with no observation evidence
7. `content`: a content position holding anything but a content value
8. `field`: an unknown, missing or mistyped field, a null where none is
   allowed, an out-of-vocabulary code, an exceeded list bound, or a broken
   cross-field rule

## `weave.trace@1`

`weave.trace@1` (`packages/agentsop/src/TRACE-CONTRACT.md`) is the predecessor.
W3 moves it into Weft and defines the mapping: `run_id` → `trace_id`, `id` →
`record_id`, `parentId` → `parent_id`, `sequence` → `sequence`, and its kinds
onto the kinds above (`decision` and `audit` → `judgment`, `shell` →
`capability.invoked`, `budget` → `budget`, `error` → `error`; `implement` is
settled in W3). A value with no home in v1, such as `passed`, needs a contract
revision, not an untyped field. Its guarantees carry over: fail-closed
validation, a redactor required before serialization, and idempotent import.

## OpenTelemetry

OTel is an export format (W6, #188), not this schema. Records map to spans,
links to span links, and `inference.attempt` to the GenAI semantic conventions
where they fit. Information an export cannot carry is lost from that export,
not removed from Weft.
