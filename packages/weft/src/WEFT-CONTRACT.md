# Weft record contract v1

Status: contract (W1, #183) and validator (W2, #184). `validateRecord` in
`src/validate.ts` implements this contract; `test/contract.test.ts` runs the
fixtures in `fixtures/records.json` against the compiled package as part of
`npm test` (`npm run test:weft-contract` alone). `@weave/weft` imports nothing
in-repo (`checks/import-direction.mjs`). W3 (#185) moved `weave.trace@1` here
as a supported version (see `weave.trace@1` below). W4 (#186) added disclosure
classes, the inline content policy and the redacting serializer (see
Disclosure). W5 (#187) wired Loom, the gateway and the Fabric host to emit
through a port and added `capability.lifecycle` (see Emission).

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

| Key         | Type       | Rule                                                                  |
| ----------- | ---------- | --------------------------------------------------------------------- |
| `schema`    | string     | `"weft.record@1"`                                                     |
| `trace_id`  | id         | Correlation scope                                                     |
| `record_id` | id         | Unique within the trace                                               |
| `emitter`   | object     | `{ "kind": "loom" \| "gateway" \| "fabric" \| "external", "id": id }` |
| `sequence`  | count      | Strictly increasing per `(trace_id, emitter.id)`; gaps allowed        |
| `kind`      | code       | One of the kinds below                                                |
| `thread_id` | id \| null | Loom Thread, when the record belongs to one                           |
| `parent_id` | id \| null | Containing record in the same trace (e.g. attempt → route)            |
| `links`     | link[]     | At most 32                                                            |
| `evidence`  | evidence[] | At most 64                                                            |
| `fields`    | object     | Kind-specific; see below                                              |

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

| Type    | Rule                                                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id      | `^[A-Za-z0-9_.:@-]{1,128}$`, and it fails the credential screen (see Disclosure). `@` is allowed because contract revisions and routed units use it (`boolean.task@jev-1.13.0`); `weave.trace@1` ids remain a subset |
| code    | `^[a-z][a-z0-9_.@:-]{0,63}$`; a closed vocabulary where one is listed                                                                                                                                                |
| count   | Non-negative safe integer                                                                                                                                                                                            |
| metric  | Finite number ≥ 0                                                                                                                                                                                                    |
| ratio   | Finite number in [0, 1]                                                                                                                                                                                              |
| flag    | Boolean                                                                                                                                                                                                              |
| digest  | `^sha256:[0-9a-f]{64}$`                                                                                                                                                                                              |
| content | `{ "content_class": class, "digest": digest }`, optionally plus `"ref": id`, and plus `"text": string` only under an inline content policy                                                                           |

`content_class` uses the existing glossary **content class**: `public`,
`non_sensitive`, `sensitive`, `private`. By default a content value names and
fingerprints text held elsewhere. It carries the text itself only under an
inline content policy (see Disclosure). A bare string or any other key in a
content position is rejected with `content`.

A field may be `null` only where its type says so. List fields are arrays of
the stated type and bound; an element in excess of the bound is rejected.

## Kinds

Fields not listed for a kind are rejected. _Required_ fields must be present.
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

  | `disposition`                                        | Meaning                                                                                                                        | `eligibility`                       | `weight` |
  | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | -------- |
  | `selected`                                           | Dispatched this cycle                                                                                                          | `allowed`                           | any      |
  | `dependency`, `conflict`, `stale_read_set`, `budget` | Rejected by the scheduler for that reason                                                                                      | `allowed`                           | any      |
  | `not_reached`                                        | Eligible, but the cycle selected nothing from it: weighing waited, was unaccepted or was blocked                               | `allowed`                           | any      |
  | `policy_filtered`                                    | Never weighed or selected. Its eligibility gives the reason, and an `approval_required` candidate waits on an approval request | `approval_required` or `prohibited` | null     |

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
- `disposition` code, required: `accepted`, `unaccepted`, `failed`, `uncertain`
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

### `capability.lifecycle`

A Fabric host's capability events that are not an invocation: which
implementation an accepted invocation runs, and admission and revocation.

- `operation` code, required
- `implementation` id. A revocation of an operation with no admitted
  implementation names none.
- `event` code, required: `selected`, `admitted`, `revoked`
- `contract_rev` id | null

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

## Disclosure

Status: W4 (#186). A Weft trace is durable knowledge: retaining a record grants
no cross-goal access or disclosure, and nothing here grants either.

**Disclosure classes.** Every field has a disclosure class that says what it
can reveal. A field's class follows from its type:

| Class       | What it reveals                                                    | Types                      |
| ----------- | ------------------------------------------------------------------ | -------------------------- |
| `metric`    | A measure                                                          | count, metric, ratio, flag |
| `reference` | A name or fingerprint of something held elsewhere, not its content | id, code, digest           |
| `content`   | Goal content                                                       | content                    |

A list or object takes the class of its most revealing member, so `candidates`,
which carry weights beside references, is `reference`. In the envelope,
`sequence` is `metric` and every other key is `reference`. `FIELD_DISCLOSURE`
gives the class of every kind field. In v1 the only `content` field is
`goal.intent` `statement`. A disclosure class is not a content class: the
content class says how sensitive the content is.

**Content defaults to a reference.** A content value carries its content class,
a digest and optionally a `ref`. That is the default, and the only form a
record may take without an inline content policy.

**Inline content is a scoped policy decision.** The composition root may pass
an inline content policy `{ "trace_id": id, "classes": class[] }` to the
validator and the serializer. A content value may then carry `"text"` only if
all of these hold:

- the record's `trace_id` is the policy's `trace_id`: a policy for one trace
  permits nothing in another;
- the value's `content_class` is one of the policy's `classes`: the class must
  be explicit and permitted;
- the text is a non-empty string of well-formed Unicode;
- `digest` is the SHA-256 of the text's UTF-8 bytes;
- the text passes the credential screen.

Otherwise the record is rejected with `content`. A policy with a missing or
extra key, a bad `trace_id` or an unknown class is a configuration error: the
validator and the serializer throw instead of returning a verdict. Without a
policy, no record carries text.

**Redaction boundary.** `serializeRecord(record, redact, inline?)` is Weft's
serializer for `weft.record@1`. The composition root must supply `redact`.
Without a function, or with a malformed policy, the call throws before the
redactor runs. Weft reads what the redactor returns once, validates that copy
under the same policy, and throws on any rejection. So a redactor that returns
an invalid record, or leaves a credential, an unpermitted text or a stale
digest, serializes nothing. A redactor that throws serializes nothing too. The output is one JSONL line: the envelope keys in contract order,
fields in the order this contract lists them, and nested keys in their listed
order (`content_class`, `digest`, `ref`, `text` for content). An export (W6)
may carry nothing a serialized record could not.

**Credential screen.** Ids, content refs and inline text are screened for the
repository's credential markers at token starts (`src/credential.ts`, shared
with `weave.trace@1`). These are the markers the gateway screens inference
content for, copied because Weft imports nothing in-repo: `sk-` and `sk_`,
`Bearer` followed by whitespace, `eyJ`, `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
`github_pat_`, `AKIA`, `AIza`, `xoxa-`, `xoxb-`, `xoxp-` and PEM private-key
headers. `Bearer` alone is not a marker, so `bearer_x` is an id (#158). The
screen is a safeguard after redaction, not a substitute for it.

## Rejection reasons

The validator `validateRecord(value, inline?)` returns `{ "ok": true }` or
`{ "ok": false, "reason": reason }` with the first applicable reason, checked
in this order:

1. `envelope`: not an object; missing, extra or mistyped envelope keys; unknown
   `schema`; bad `emitter`; record larger than 16 KiB
2. `id`: an id fails the pattern or the credential screen
3. `sequence`: not a count
4. `kind`: unknown kind, or a kind's `thread_id` rule fails
5. `link`: bad link shape or `rel`, a self link, a duplicate pair, more than 32
   links, or a transition that lacks its required link
6. `evidence`: bad evidence shape or `source`, a duplicate pair, more than 64
   entries, or a Loom record with no observation evidence
7. `content`: a content position holding anything but a content value, or
   text that the inline content policy does not permit, that is empty or not
   well-formed, that does not match its digest, or that fails the credential
   screen
8. `field`: an unknown, missing or mistyped field, a null where none is
   allowed, an out-of-vocabulary code, an exceeded list bound, or a broken
   cross-field rule

## `weave.trace@1`

`weave.trace@1` is the P9 trace envelope. W3 (#185) moved it here from
AgentSOP: tracing does not belong in the contract layer, and AgentSOP exports
no trace API. Weft supports it as its own version beside `weft.record@1`
(`validateTrace`, `serializeTrace`, `importTraceLines` and `TraceImportPort`
in `src/weave-trace.ts`) and does not convert it.

**Envelope.** One JSON object per JSONL line with exactly these keys, written
in this order: `schema` (`"weave.trace@1"`), `id`, `parentId` (id or null),
`run_id`, `kind`, `sequence` (count), `payload`. Ids match
`^[A-Za-z0-9_.:-]{1,128}$` and fail the credential screen above. `kind` is one
of `decision`, `implement`, `audit`, `shell`, `budget`, `error`. `payload` is
closed: `spent_micros`, `latency_ms`, `input_tokens` and `output_tokens` are
finite numbers ≥ 0, `confidence` is a ratio and `passed` a flag. No raw
provider content, operator text, environment values or errors cross it.
Unknown fields and malformed envelopes fail closed.

**Redaction.** The composition root must supply a redactor, even for opaque
ids. `serializeTrace` validates the redacted record and throws rather than
write an invalid one. It writes payload keys in the order listed above. In
disclosure terms its ids and `kind` are `reference`, its payload is `metric`,
and it has no `content` field, so no inline content policy applies to it.

**Import.** `importTraceLines` validates every line before calling the port.
Identical canonical content under `(run_id, id)` is a no-op; different content
is rejected, never overwritten. Transactional ports supply `upsertBatch` so
all rows commit atomically. Legacy `upsert`-only ports cannot promise rollback
and remain responsible for their own storage semantics. SQLite's typed JSONL
import and torn-line policy are specified below.

**Why it is not converted.** The W1 sketch mapped `run_id` → `trace_id`, `id`
→ `record_id`, `parentId` → `parent_id`, `sequence` → `sequence`, and each kind
onto a v1 kind. The envelope corresponds, but no kind does: each target kind
requires fields `weave.trace@1` never recorded. `judgment` needs `site`,
`request_ref` and `accepted`. `capability.invoked` needs `contract_rev`,
`implementation` and `status`. `budget` needs `line`, `error` needs `code`, and
every `weft.record@1` needs an `emitter`. `implement`, an implementation step's
totals, and `passed` have no v1 home at all. A conversion would have to invent
those values. Carrying these records as `weft.record@1` needs a contract
revision and emitters that record the missing fields at the source, not values
filled in on import.

## Emission

Status: W5 (#187). Loom, the gateway and the Fabric host emit `weft.record@1`
records through a port each receives at composition. None of them imports
Weft.

**Port.** Each package declares its own `WeftPort` type:
`{ trace_id, emitter_id, emit(record) }`. Loom takes it as
`RuntimeOptions.weft`, the gateway as `GatewayConfig.weft` and the Fabric host
as the `weft` constructor option. The composition root chooses the trace and
the emitter ids; one gateway or host instance is one emitter. With no port,
nothing is emitted and no record is built. There is no ambient sink: no global,
registry or environment variable attaches one, so a benchmark or example gets
records only when its own composition passes a port.

**Redaction before the sink.** `createWeftSink({ redact, inline?, write })` is
Weft's sink for a port. It runs `serializeRecord` on every record and hands
`write` only the resulting line. A record the redactor or the validator
rejects is counted in `rejected` and not written. So the store, file or
exporter behind `write` never sees an unredacted or invalid record.

**One-way.** Emitting never changes state, scheduling, budgets or outcomes:

- `emit` is called synchronously, after the transition it reports. Its result
  is ignored. A throw is caught, a returned promise is never awaited and its
  rejection is handled.
- Loom and the Fabric host queue a step's records and hand them to the port
  only once the step has completed: for Loom, the outermost append or ingress
  arrival, with the cycle and dispatches it triggers; for the host, the whole
  invocation, settlement, lookup or revocation. A sink that calls back into
  the Runtime or the host from `emit` therefore starts a new step after the
  one being reported, never inside it, and its records follow in the same
  delivery. The run is the one where the same calls were made after that step.
- A record is a fresh object of strings, numbers, flags and fresh arrays. It
  holds no reference to state, grants, contracts, views, inputs, outputs or
  provider text, so a sink that keeps or mutates it changes nothing, and no
  grant can be re-presented from it.
- The gateway hands a request's records to the port after the request has
  settled, so even a slow synchronous sink cannot spend its deadline.
- Emitting reads no clock and no store, and scans no log.

**Replay.** `replay()` suppresses emission: in replay mode Loom calls no port,
whether or not one is configured. The live run already emitted these records,
and a replay that diverged would otherwise submit a different record under an
existing identity. `recover()` loads the journal without emitting; emission
resumes with the first observation appended after the load. Loading indexes
the journaled dispatches, so a dispatch after recovery still supersedes a
thread opened before the crash, and a queued action that starts after
recovery is not opened a second time. Replay invokes
neither the gateway nor the host, so they emit nothing either.

**Identity and order.** Loom's record ids are derived from the log, so a run
yields the same ids every time: `<emitter>:goal:<goal.opened seq>` (a run may
open another goal after one completes or is missed),
`<emitter>:cycle:<cycle_no>:<trigger seq>` (Loom may reuse a cycle number after
recovery; the trigger keeps the id unique), `<emitter>:thread:<action_id>:<transition>`
(`cancelled` adds the request's seq, since a cancel may be repeated),
`<emitter>:action:<action_id>:<state>`, `<emitter>:judgment:<ref>` and
`<emitter>:outcome:goal:<goal.opened seq>`. Loom's `sequence` is the highest observation seq
times 1024 plus an offset, so it keeps increasing across recovery. Gateway and
Fabric sequences count per emitter instance; a restarted gateway or host takes
a new emitter id. Loom evidence cites an observation by its seq (`seq:<n>`),
never by its observation id, so text a source chose does not enter a record
through a citation.

**Loom.** A Loom Thread in the reference stack is one dispatched action's line
of work, and `thread_id` is the action id.

| Loom event                                                              | Records                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal.opened`                                                           | `goal.intent`; `statement` is a `private` reference to the purpose's digest, never its text                                                                                                                                                                                                    |
| A cycle ends                                                            | `cycle.weighed` with every formed candidate, cited as its candidate id with `#` written `:`. A `deferred` candidate (`frontier.weigh@1`) is `not_reached`                                                                                                                                      |
| An action is queued or started                                          | `thread.transition` `opened` (parent: the cycle) and `action.transition` `pending` or `running`. A candidate with dependencies adds `joined`, with a `joins` link to each dependency thread's `closed` record. A thread that supersedes an earlier one adds `superseded` to the earlier thread |
| A queued action starts                                                  | `action.transition` `running`                                                                                                                                                                                                                                                                  |
| `action.cancel_requested`                                               | `thread.transition` `cancelled` with a `cancels` link to the thread's `opened` record, and `action.transition` `cancelled` if the action was still queued                                                                                                                                      |
| `action.result`                                                         | `action.transition` with the outcome, and `thread.transition` `closed` caused by it                                                                                                                                                                                                            |
| `weights.recorded` from a scripted decision layer, `inference.recorded` | `judgment`. A scripted weighing has no inference request, so its `request_ref` is the observation id (`weights:c<n>`)                                                                                                                                                                          |
| The goal completes or is missed                                         | `outcome` for the goal                                                                                                                                                                                                                                                                         |

A dispatched action supersedes the latest earlier thread of the same operation
over the same resources, revisions ignored: re-inspecting a changed source
supersedes the earlier inspection. The `superseded` record belongs to the
earlier thread; its `supersedes` link names the `opened` record of the thread
that took over. Joins, supersession and cancellation are always these links,
never inferred from order or timing.

**Gateway.** Each time a request routes to a unit other than the one before,
the gateway emits `route.selected` with the exclusions behind it (the first
64, in routing order). An
escalation `supersedes` the previous route and is `caused_by` the attempt that
ended it. Every attempt emits `inference.attempt`, child of its route, with
tokens, `spent_micros` (rounded up), `cost_is_upper_bound` and `latency_ms`
from the injected clock; every attempt after the first has a `retry_of` link to
the one before. A failed attempt adds an `error` child carrying the provider
failure code and `retryable`, never the provider's message.

**Fabric.** An accepted invocation emits `capability.lifecycle` `selected`
naming the implementation, and `capability.invoked` when it settles; a settled
invocation whose cancellation was requested and that did not succeed is
`cancelled`. A rejected invocation emits `error` with the failure code.
Installing an admitted implementation emits `admitted`; revoking an operation
emits `revoked` for each implementation it had.

**Across emitters.** Gateway and Fabric records carry no `thread_id`. They are
correlated with Loom's by evidence refs: `inference_request` (the gateway
request id; Loom's framing request uses the same id) and `invocation` (Loom's
action id is the invocation id). A citation is an index, not a causal claim.

## OpenTelemetry

OTel is an export format (W6, #188), not this schema. Records map to spans,
links to span links, and `inference.attempt` to the GenAI semantic conventions
where they fit. Information an export cannot carry is lost from that export,
not removed from Weft.

### W6 export boundary

`@weave/weft/otel` is an optional entry point, with no third-party runtime
dependency. The core entry point never imports it. `exportOtlp(records,
{ redact, inline?, baseTimeUnixNano? })` accepts a batch of `weft.record@1` values and returns
`{ ok: true, json }` or `{ ok: false, reason }`, without throwing. Every
record passes through `serializeRecord` before mapping; one rejection rejects
the entire batch. No raw input, environment, grant, resource detector or ambient
sink is consulted. Missing or invalid redactors and inline policies return
the non-sensitive reason `config`, including for empty batches. Redactor throws
and rejected record content return `disclosure`.

`createOtlpExporter({ redact, inline?, baseTimeUnixNano?, write, timer, writeTimeoutMs? })` adds
an explicit one-way `export(records, signal?)` method. The composition root
owns writer liveness: it supplies `timer(ms, expire)`, which must fire within
the requested delay and return a cancellation function. There is no ambient
clock. The write timeout defaults to 1000 ms; overrides must be finite,
positive and at most 2147483647 ms (otherwise `config`). Writer throws,
rejections, timeout and abort resolve as `write`; a pre-aborted signal skips
the writer. Each call cleans up its timer and abort listener. Abandoned writes
retain rejection handlers, so late rejection cannot escape to the run.
Abandonment cannot undo delivery or stop the writer's own effects. The
composition root must isolate synchronous blocking writers: JavaScript timers
and abort cannot interrupt synchronous work.

Identity uses SHA-256 of JSON arrays: `["weft.otel.trace@1", trace_id]`
(first 32 hex digits), and `["weft.otel.span@1", trace_id, record_id]`
(first 16). Identical duplicate records collapse; conflicting identities or
repeated sequences within one emitter reject. Traces sort by trace id, spans
by emitter id then sequence then record id, links by relation then target,
and evidence by source then ref. This is serialization order, not causality.
A batch must contain all parent and link targets in each trace; missing targets
reject as `incomplete`, parent cycles as `parent_cycle`. A batch may contain
several independent traces. There is no retained state between calls.

Each record becomes one INTERNAL span (CLIENT for `inference.attempt`).
Parent ids become parent span ids; every explicit link becomes a span link
with `weft.link.rel`. Evidence remains a namespaced attribute, never an inferred
causal link. All envelope references and kind fields are `weft.*` attributes;
nested values use OTLP AnyValue arrays and key-value lists. Nulls are omitted.
`error`, failed/missed/uncertain outcomes and unaccepted/failed attempts set
ERROR status; cancellation stays a namespaced state without implying failure.
Inference token counts also become `gen_ai.usage.input_tokens` and
`gen_ai.usage.output_tokens`. A routed unit is not necessarily a model or
provider, and Weft does not know the GenAI operation: none is invented.

**Time and loss.** Start and end are both `baseTimeUnixNano + sequence + 1`
nanoseconds after the Unix epoch, calculated with integer arithmetic. The optional
`baseTimeUnixNano` is injected only by the composition root as a non-negative
bigint or digits-only decimal string. It and every resulting timestamp must fit
uint64 (including the `+1`); invalid values or overflow return `config`, including
invalid bases on empty batches. No clock is read by Weft, Loom or the gateway to
obtain this base. Without a base, zero is used and output stays byte-identical
to the original epoch behaviour. These are synthetic point
spans, not occurrence times; `weft.time_basis = "sequence"` marks them.
Without a base, OTLP backends or collectors (for example, ingestion windows)
may silently drop these 1970-dated spans, so production composition roots should
inject a base.
Sequences from different emitters are incomparable. Across emitters a child
span can start before its parent when the parent has a later sequence; some
trace UIs flag or reorder these spans. Measured `latency_ms`
remains a namespaced metric rather than fabricating a start time. Real timing,
duration and cross-emitter chronology cannot be recovered from this export.
Null versus absent is lost; native validation, field disclosure classes,
conflict semantics and non-authority are not enforced by OTLP readers.
Decisions, rejected candidates, policy filtering and evidence retain their
values in namespaced attributes, but have no standard OTel meaning. Numeric
safe integers use OTLP decimal int strings; fractional metrics use doubles.
Truncated hash identities have theoretical collision risk; export is no store
and provides no exactly-once delivery guarantee. Retrying after a crash produces
the same bytes and span identities for the same redacted records and base; the composition
root must supply a deterministic redactor for reproducible export. Collector
deduplication is its concern.
`weave.trace@1` is rejected rather than inventing missing Weft fields.

## SQLite intake (WV-032 R3, #132)

`@weave/weft/sqlite` is an optional Node 22 `node:sqlite` adapter, with no
runtime dependencies. Core imports neither SQLite nor a listener. The existing
subsystem journals remain the only replay source. This store grants no authority.

`openTraceStore(path, { redactTrace, redact })` returns a typed result; both
redactors are mandatory, including for empty batches. The store provides
`upsert`/`upsertBatch` (TraceImportPort), `importJsonl`, `importRecords`, `read`
and `close`. Operational failures return only a reason: `input`, `disclosure`,
`conflict`, `cancelled`, `busy`, `storage`, `schema` or `config`. No exception,
SQLite message or input fragment crosses the port. Reads sort by `(run_id, id)`.

Schema version 1 uses `PRAGMA user_version`. Unknown versions are rejected,
never migrated implicitly. `runs(run_id)` and `threads(run_id, thread_id)`
index scopes. `spans(run_id, id, schema, parent_id, thread_id, kind, sequence,
emitter_kind, emitter_id, record_json)` has primary key `(run_id, id)` and references the run and optional
thread. `decisions`, `model_calls`, `tool_calls`, `errors`, `budget_events`
each have primary key `(run_id, id)` and a composite foreign key to spans.
Their remaining columns, in schema order, are:

- `decisions`: site, request_ref, accepted, confidence, passed, procedure,
  cycle_no, state_revision, weights_ref, cost_micros, routed_unit, tier.
- `model_calls`: request_ref, routed_unit, attempt_no, disposition, input_tokens,
  output_tokens, spent_micros, cost_is_upper_bound, latency_ms.
- `tool_calls`: contract_rev, implementation, status, invocation_ref,
  execution_tier, failure, latency_ms, spent_micros.
- `errors`: code, retryable.
- `budget_events`: line, budget_limit (the envelope's `limit`), reserved, spent,
  spent_micros.

Flags store as 0/1. Missing fields are SQL NULL, not invented values. Counts
use INTEGER, fractional metrics REAL, references TEXT. Legacy decision/audit,
shell, error and budget records fill only the metrics they actually carry.
Weft cycle/judgment/route, inference attempt, invocation, error and budget
records fill their respective tables. Other kinds remain spans. Links,
evidence, nested candidates and other version-specific fields remain in
canonical `record_json`; the typed columns are indexes over those validated
records. No missing operation provenance is invented.

Both envelopes share the identity namespace. Weft canonical storage sorts links
by relation then record id and evidence by source then reference, using W6's
lexical ordering. Optional null fields are omitted; required null parents, threads
and candidate weights are retained. Native import and re-ingestion from its own
W6 export therefore share identity. Canonical JSON is stored consistently.
Exact canonical bytes are a no-op;
any differing content (including schema) conflicts and leaves the original
unchanged. All records are snapshotted, redacted and validated before any write.
Every batch uses one `BEGIN IMMEDIATE` transaction; conflict, write failure or
abort rolls back every table. Concurrent calls on one adapter return `busy`;
independent connections serialize through SQLite's write lock or return `busy`
without waiting. Cancellation is checked between rows with an asynchronous yield;
JavaScript cannot interrupt one synchronous SQLite statement. Closing an active
adapter returns `busy`. Durable SQLite transactions recover after process death.

`importJsonl` accepts only newline-terminated complete records. A nonempty final
unterminated fragment is skipped, even if valid JSON, and success reports
`torn: true`. Earlier complete lines commit as one batch only if all validate;
an invalid complete line or conflict rejects that complete-line batch. Re-import
with the repaired final line is idempotent. Blank complete lines are ignored.
The legacy generic `importTraceLines` parser still rejects malformed lines;
with a transactional port it submits all its validated rows as one batch.

### Local OTLP/JSON intake

`@weave/weft/intake` exports pure `mapOtlp(value, { redact })` and
`intakeOtlp(value, store, { redact }, signal?)`. No listener or SQLite import
runs in this module. Mapping is all-or-nothing and runs `serializeRecord` with
no inline policy before returning records. Store admission repeats the boundary;
composition-root redactors must therefore be deterministic and idempotent.
SQLite additionally rejects credential markers anywhere in serialized records,
including code fields. Arbitrary environment values require the composition
root's redactor; Weft never reads the environment to discover secrets.

W6 namespaced attributes reconstruct the Weft record, including semantic fields,
links and evidence. Null envelope parents/threads and null candidate weights are
restored; optional nulls become absent (the W6 loss rule). Native ids are checked
against W6's derived OTLP identities; inconsistent or malformed attributes reject.
Other attributes, resources, scopes, names, timing and status do not override
native semantic fields. Unknown Weft schema versions reject.

Generic OTLP spans require nonzero 32-hex trace and 16-hex span ids and valid
optional parent ids. They project to `action.transition` with `otlp:`-prefixed
ids, a synthetic per-span emitter `external/otlp.import:<spanId>`, operation
`otlp.span`, sequence zero and
state `failed` for OTLP ERROR, otherwise `succeeded`. This is a minimal import
observation, not a claim about a Loom action or the source operation. Parents
are retained; names, attributes, timing, resources, scopes, events and generic
links are discarded. No provider, model, contract, thread or missing semantic
provenance is invented. Provider-specific richer mappings remain future work.

`createOtlpListener({ createServer, store, redact, host?, port?, maxBytes? })`
requires a composition-root HTTP server factory. It defaults to `127.0.0.1`
and an OS-selected local port; only `127.0.0.1`, `::1` or `localhost` are accepted.
After listening, the actual address must be `127.0.0.1` or `::1`; otherwise
the listener closes and returns a typed `config` error. Every request must carry
the exact bound Host authority (`127.0.0.1:<port>`, `[::1]:<port>`, or
`localhost:<port>` only when bound via localhost). Missing or different Host
headers and any Origin header, including an empty one, receive 403 before intake.
It exposes only POST `/v1/traces` with JSON, limits bodies (default 1 MiB),
returns no input or error fragments, disables automatic response dates and
propagates connection cancellation. Startup and shutdown return typed results.
The composition root owns listener lifetime; there is no registration, collector,
provider connection or ambient intake in core or benchmark routes.
