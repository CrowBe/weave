# Context budget contract — C1

Status: contract and validated red corpus only. No managed preparation,
accounting, framing stop, admission, persistence or replay implementation ships
in C1. Source: `_plan/PLAN.md`, copied byte for byte from `841d7f4:PLAN.md`.
D-ENG-025/026/027 stay closed; D-ENG-034 permits #353. This contract changes no
acceptance boundary. C2a/C2b/C2c/C2d and C2d-Q require separate authorization.

## 1. Boundary and trusted inputs

Loom prepares authorized content before inference reservation or dispatch.
Preparation is a pure transformation: no clock, randomness, environment,
credentials, transport, host lookup or model judgment. Model output is an
observation. Deterministic site policy owns inventory, requiredness and limits.
Fabric has no dependency on this mechanism or Loom scheduling.

Disclosure filtering precedes capture. Preparation never fetches content,
reverses an authority omission, changes destinations or grants authority.
Instructions, questions, goal, authority, budget, iteration, selected audit
material, profile identity/version, prefix and catalogue are protected.
Existing disclosed profile/audit omissions are inputs, not permission to cut
more. No audit summarization is authorized (D-ENG-027).

All records below are closed: extra fields reject. Arrays are ordered unless
explicitly canonicalized. An optional field is absent, never undefined. Type
aliases below describe validated detached JSON, not arbitrary live objects.
Named revision/digest references identify immutable pure procedures whose
historical implementations and proof bundles must remain available. Missing
history fails replay; a mutable file, alias or current default cannot replace it.

## 2. Shared shapes and validation

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Nat = number; // checked integer in [0, 9007199254740991]
type Positive = number; // Nat >= 1
type Hex = string; // exactly 64 lowercase ASCII hex characters
type DecisionId = string; // exactly "ctx:" + Hex (68 ASCII bytes)
type ActionId = string; // a:<Positive>:<Positive>, canonical decimal, <=35 ASCII bytes
type WeighAttempt = string; // inf:c<Positive>:weigh, <=27 ASCII bytes
type Path = (string | Nat)[]; // exact canonical input path; no wildcard expansion
type Position = ({ index: Nat } | { key_ordinal: Nat })[];
type Revision = { id: string; version: Positive; digest: Hex };
type Owner =
  | { site: 'goal.frame'; owner_scope: Hex; logical_attempt: ActionId; candidate_set: null }
  | { site: 'frontier.weigh'; owner_scope: Hex; logical_attempt: WeighAttempt; candidate_set: Hex };
type Binding = {
  decision_id: DecisionId;
  owner: Owner;
  fit_input_digest: Hex;
  policy_digest: Hex;
  storage_policy_digest: Hex;
};
type StoragePolicy = {
  schema: 'context.storage-policy@1';
  max_observation_bytes: Positive;
  encoding: 'stableStringify/utf8';
};
type Limits = { max_depth: Positive; max_nodes: Positive };
type PartClass = 'required' | 'optional';
type PartKind =
  | 'instructions'
  | 'questions'
  | 'goal'
  | 'authority'
  | 'budget'
  | 'iteration'
  | 'audit'
  | 'prefix'
  | 'catalogue'
  | 'source'
  | 'artifact'
  | 'state';
type PartRule = {
  name: string;
  kind: PartKind;
  path: Path;
  class: PartClass;
  priority: Nat;
};
type Template = {
  identity: Revision;
  body: Json;
  substitutions: { path: Path; value: Json }[];
  rendering: Revision;
};
type Profile = {
  id: string;
  version: Positive;
  catalogue_budget: Nat;
  slices: string[] | null;
  prefix: string | null;
  schema_for: string[] | null;
};
type SitePolicy = {
  schema: 'context.site-policy@1';
  identity: Revision;
  site: Owner['site'];
  operation: 'generate' | 'evaluate';
  kind: string;
  role: string;
  profile: Profile;
  rules: PartRule[];
  inventory: Revision;
  renderer: Revision;
  reconstruction: Revision;
  validator: Revision;
  templates: Template[];
  dynamic_question_ids: string[];
  ceiling_tokens: Positive;
  mode: 'refuse' | 'drop_optional';
  limits: Limits;
  volatile_fields: Path[];
  volatile_fields_digest: Hex;
};
```

`owner_scope = digest({journal_scope, goal_id})`, using trusted composition's
stable journal scope and admitted goal id. No ambient identity is generated.
For goal.frame, the decision id is `ctx:` plus
`digest({site, owner_scope, logical_attempt})`. One accepted decision of any
kind per owner/action is permitted. Its three binding digests are verified
bindings, never extra uniqueness components. Reentry with changed bindings is
an integrity error, even after a tick, term change or changed assembly id.
For frontier.weigh the id additionally binds all three binding digests. A fresh
cycle has a fresh logical attempt; A→B→A therefore produces distinct ids.
The stop index key is owner scope plus candidate_set and the three digests.
Volatile-only changes reuse the latest stop without append, accounting,
reservation, controller or call; new nonvolatile authorized inputs permit a
fresh weighing. This bookkeeping is not fresh weighing evidence.

`policy_digest = digest(complete SitePolicy)`;
`storage_policy_digest = digest(complete StoragePolicy)`.
`fit_input_digest = digest(captured authorized input with exactly the
snapshotted volatile_fields removed)`. The list and its digest are explicit,
including an empty list. Goal.frame has no volatile fields. Frontier.weigh's
request_id, view.state_revision, terms.deadline and terms.cost_ceiling may be
excluded only when disjoint from every field the accounting family consumes.
Assembly ids and all other manifest/content/term fields stay bound. Disjointness
failure is unsupported_accounting. Current defaults cannot influence replay.

Accept null, boolean, finite JSON numbers (normalize -0 to 0), well-formed
strings, dense arrays and plain data objects with own string data properties. Plain objects have Object.prototype or null as
their prototype; arrays have Array.prototype, dense own indices and length
only. Reject symbol keys, extra array properties and non-enumerable object
properties, so canonical serialization cannot silently omit captured content.
Reject undefined, functions, symbols, BigInt, cycles, holes, accessors, custom
prototypes/hooks and non-finite numbers. Do not invoke getters or toJSON.
Validate before recursive serialization; proxies/host objects are outside this
contract. Count the root as one node at depth zero, each array element/object
property value as one node; keys are checked strings but not counted nodes.
Count repeated acyclic references per occurrence after detachment. Stop at the
first exceeded depth/node bound. Exact equality is accepted. Check keys as well
as values for lone surrogates; valid emoji and supplementary CJK pairs remain
valid. `digest(value)` uses canonical JSON; raw UTF-8 string-body hashing is
forbidden. It collides on a lone surrogate and U+FFFD, whereas canonical digests
differ and payloadBytes measures respectively 8 and 5 bytes.

Validation order: budget/limits, structural JSON preorder (array index order,
object keys in sorted UTF-16 order, key validity before value), inventory in
policy order, classifications/linkages, accounting coverage, arithmetic, fit.
Narrow serialization errors become invalid_part/serialization_failure. Do not
catch journal, programmer or transport faults and call them fits.

Fixture probe at C1 base `2bff44304a4d15b3d3072a84634f2cce30c5c79c`:

| Site           | Largest depth | Largest nodes | Chosen max_depth | Chosen max_nodes | Fixture source                                                                                               |
| -------------- | ------------- | ------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| goal.frame     | 6             | 102           | 32               | 4096             | `packages/weave/test/p6.test.ts`, D3 consumes the budgeted M6 index rather than the registry or schema slice |
| frontier.weigh | 6             | 96            | 32               | 4096             | `benchmarks/frontier-weigh/build.ts`, buildCase over checked-in cases (maximum: fw-h02)                      |
| audit.generate | 5             | 3032          | 32               | 8192             | `packages/weave/test/audit-view.test.ts`, audit text caps retain many items and only mark authorized fields  |

Each limit is max(floor, nextPowerOfTwo(2 × measured maximum)); floors are
32 and 4096. The retained test-only `measure.mjs` observes existing renderers
without editing their files. Probe invocation and limitations are in the C1
evidence file. The audit row is a C4 policy prerequisite only; C1 widens no
runtime observation union. Beyond-limit future views receive a durable
invalid_part/depth_limit or node_limit refusal; P1's consequence inventory and
approval remain necessary before enforcement. These measurements establish no
certified token bounds and no fixture/default approval.

## 3. Exact reconstruction, evidence and ledger

```ts
type Terms = {
  quality: 'baseline' | 'high';
  destinations: string[];
  max_context_tokens: Positive;
  deadline: Nat;
  cost_ceiling: Nat;
  max_attempts: Positive;
  audit?: boolean;
  tier?: 'decision' | 'flash' | 'standard' | 'strong';
  content_class?: 'public' | 'non_sensitive' | 'sensitive' | 'private';
  max_attempts_per_route?: Positive;
  prefix_digest?: Hex;
  prefix_cache?: { routed_unit_id: string; prefix_digest: Hex; cached_tokens: Nat };
};
type Prepared = {
  schema: 'context.prepared@1';
  request_id: string;
  site: Owner['site'];
  role: string;
  kind: string;
  terms: Terms;
  request:
    | { operation: 'generate'; input: { instructions: string; prompt: string } }
    | { operation: 'evaluate'; state: Json; questions: { [id: string]: Json } };
};
type Link =
  | {
      kind: 'slice';
      manifest_index: Nat;
      name: string;
      revisions: Nat[];
      assembly_id: string | null;
      content_path: Path;
    }
  | { kind: 'template'; template_index: Nat; content_path: Path };
type Part = {
  name: string;
  kind: PartKind;
  class: PartClass;
  priority: Nat;
  body: Json;
  body_digest: Hex;
  body_bytes: Nat;
  link: Link;
};
type Capacity = {
  source_semantics: 'input_only' | 'total_window';
  source_limit: Positive;
  max_output_allowance: Nat;
  normalized_input_capacity: Positive;
};
type AccountingContract = {
  identity: Revision;
  evidence_digest: Hex;
  route_identity: Hex;
  transform: Revision;
  tokenizer: Revision;
  settings: Json;
  framing: Revision;
  serialization: Revision;
  capacity: Capacity;
  proof_digest: Hex;
  framing_allowance: Nat;
  monotonic_additions_proof: Hex;
  marker_swap_proof: Hex | null;
};
type AccountingFamily = {
  identity: Revision;
  evidence_digest: Hex;
  gateway_fingerprint: Hex;
  reconstruction: Revision;
  serialization: Revision;
  members: AccountingContract[];
};
type RouteBound = {
  contract_digest: Hex;
  evidence_digest: Hex;
  route_identity: Hex;
  neutral_bytes: Nat;
  neutral_digest: Hex;
  wire_bytes: Nat;
  wire_digest: Hex;
  framing_allowance: Nat;
  token_bound: Nat;
};
type Measurement = { request_digest: Hex; routes: RouteBound[]; tokens: Nat };
type LedgerPart = Omit<Part, 'body'> & { included: boolean };
type Ledger = {
  schema: 'context.ledger@1';
  fit_input_digest: Hex;
  policy_digest: Hex;
  storage_policy_digest: Hex;
  ceiling_tokens: Positive;
  reserved_tokens: Positive;
  full_tokens: Nat;
  required_tokens: Nat;
  used_tokens: Nat;
  truncated_tokens: Nat;
  original_view_digest: Hex;
  original_manifest_digest: Hex;
  effective_view_digest: Hex;
  family_digest: Hex;
  evidence_digest: Hex;
  original: Measurement;
  required: Measurement;
  included: Measurement;
  parts: LedgerPart[];
};
type View = {
  profile: string;
  profile_version: Positive;
  state_revision: Nat;
  content: Json;
  manifest: {
    slices: {
      name: string;
      revisions: Nat[];
      truncated: boolean;
      omitted: { name: string; reason: string }[];
      assembly_id?: string;
    }[];
  };
};
type AssemblyEvidence = Binding & {
  schema: 'context.assembly-evidence@1';
  policy: SitePolicy;
  storage_policy: StoragePolicy;
  accounting: AccountingFamily;
  original_view: View;
  effective_view: View;
  templates: Template[];
  parts: Part[];
  original_terms: Terms;
  effective_terms: Terms;
  prepared: Prepared;
  state_revision: Nat;
  catalogue_revisions: { id: string; revision: Nat }[];
};
```

These JSON snapshots contain every template body/substitution and candidate
body, including excluded bodies, full profile and manifest. `context` is a
sibling of `view`; no token fields are added to StateView/ViewSliceManifest.
Missing assembly_id is valid through explicit manifest index/name/revisions.
An instruction/question is linked to its template, never a fabricated slice.

Trusted inventory derives every expected part from the complete authorized
pre-trim view and site policy. Missing, duplicate, unknown, unmapped or
misclassified parts reject. Caller class metadata confers no requiredness.
Stable prefix bytes and renderer output remain unchanged. Prepared content and
terms are frozen and bound to included.request_digest. Callbacks and AbortSignal
stay outside evidence, selected/passed by the historical site contract.

The immutable family covers every route the scoped gateway can select, retry
or escalate to, even if currently unavailable/too small. Route/settings/adapter
or tokenizer drift, mutable aliases, unsupported framing and unknown capacity
semantics refuse dispatch; do not filter a route out to make admission pass.
Provider configuration remains opaque to Loom. Output allowances/settings belong
to the accounting member, not an invented gateway inference term. Terms retain
the exact presence/absence of all current gateway optional fields. Total capacity is normalized by
checked subtraction of maximum output allowance; input-only capacity is direct.
C2a must establish these facts. No generic byte/token fallback exists.

Each member reconstructs the exact actual adapter payload: keys, braces,
escaping, translated questions, settings, model fields, roles/messages,
nontext input and implicit protocol framing. Record neutral and wire bytes and
digests separately. Never copy headers/credentials. Certified algorithm or a
mathematical/structural bound plus adversarial independent evidence is required;
calibration/provider usage cannot prove soundness. Permutations require a bound
over every allowed ordering or an explicit sealed order honored at dispatch.
All complete-input token measurements include framing once per route. Part
bytes are diagnostic; they are not additive token estimates.

Let B(S) be the maximum certified complete-input bound over all family members
for reconstruction with inclusion set S. Check every operation, including sums,
products, differences and capacity normalization, for safe integer arithmetic.

- full_tokens = B(all), without omission markers.
- C2 required_tokens = B(required), without omission markers; diagnostic only.
- used_tokens = B(included); truncated_tokens = full_tokens - used_tokens.
- reserved_tokens = ceiling_tokens = terms.max_context_tokens; used <= reserved.
- First compare full_tokens <= ceiling_tokens; equality fits, regardless of the
  required-only diagnostic. C2 never trims.
- Only when full > ceiling classify required > ceiling as required excess;
  otherwise classify total excess. Both excess fields are strictly positive.
- Future C3 starts only on excess, with required ∪ all omission markers fitting.
  Prove B(required ∪ markers) <= B(all) and monotonic marker/body swaps for every
  permitted set; otherwise unsupported_accounting with no trimming. Drop whole
  optional parts by priority descending then name descending. Remeasure complete
  reconstruction after every removal, including context_budget omission entries.
  Only the detached effective view changes. Required/audit/prefix parts stay whole.

C6 needs a new ledger version to change reserved/ceiling equality. Monetary
reservations remain explicit and independent of token bounds/cache pricing.
Cached input occupies the full input window.

## 4. Decisions and rejection variants

```ts
type Violation =
  | 'undefined'
  | 'function'
  | 'symbol'
  | 'bigint'
  | 'cycle'
  | 'sparse_array'
  | 'accessor'
  | 'custom_prototype'
  | 'unsupported_hook'
  | 'extra_property'
  | 'non_enumerable'
  | 'non_finite'
  | 'lone_surrogate'
  | 'depth_limit'
  | 'node_limit'
  | 'missing_part'
  | 'duplicate_part'
  | 'unknown_part'
  | 'unmapped_part'
  | 'wrong_inventory'
  | 'protected_class'
  | 'link_mismatch'
  | 'serialization_failure';
type BudgetViolation = 'non_positive' | 'unsafe_integer' | 'arithmetic_overflow';
type Witness = {
  schema: 'context.rejection-witness@1';
  validator: Revision;
  part: PartKind | 'budget';
  position: Position;
  code: Violation | BudgetViolation;
};
type Overflow =
  | {
      schema: 'context.overflow@1';
      reason: 'required_exceeds_ceiling';
      ceiling_tokens: Positive;
      total_tokens: Nat;
      required_tokens: Nat;
      over_by_tokens: Positive;
      total_over_by_tokens: Positive;
    }
  | {
      schema: 'context.overflow@1';
      reason: 'total_exceeds_ceiling';
      ceiling_tokens: Positive;
      total_tokens: Nat;
      required_tokens: Nat;
      over_by_tokens: Positive;
      total_over_by_tokens: Positive;
    }
  | {
      schema: 'context.overflow@1';
      reason: 'invalid_budget';
      code: BudgetViolation;
      witness_digest: Hex;
    }
  | { schema: 'context.overflow@1'; reason: 'invalid_part'; code: Violation; witness_digest: Hex }
  | {
      schema: 'context.overflow@1';
      reason: 'unsupported_accounting';
      code:
        | 'coverage'
        | 'transformation'
        | 'tokenizer_revision'
        | 'framing'
        | 'capacity'
        | 'volatile_overlap'
        | 'monotonicity'
        | 'marker_swap';
      evidence_digest: Hex;
    };
type Refused = Binding & {
  overflow: Overflow;
  evidence:
    | { kind: 'complete'; assembly_evidence: AssemblyEvidence }
    | { kind: 'witness'; witness: Witness; policy_revision: Revision; storage_policy: StoragePolicy };
};
type RequestedV2 = Binding & {
  request_id: string;
  site: Owner['site'];
  role: string;
  kind: string;
  candidate_set: Hex | null;
  state_revision: Nat;
  view: View;
  terms: Terms;
  reservation: { judgments: Nat; cost: Nat };
  context: Ledger;
  assembly_evidence: AssemblyEvidence;
};
type Preparation =
  | { status: 'fits'; context: Ledger; assembly_evidence: AssemblyEvidence; prepared: Prepared }
  | { status: 'overflow'; refusal: Refused };
```

Required excess requires total > ceiling AND required > ceiling:
over_by = required - ceiling; total_over_by = total - ceiling.
Total excess requires required <= ceiling < total:
over_by = total_over_by = total - ceiling. Invalid variants omit every
uncomputable numeric field entirely, including ceiling if invalid; no NaN,
infinity, unsafe total, guessed number or nonpositive excess is serialized.

Witnesses contain only a closed part kind, violation and structural array
indexes/key ordinals, never offending key/value text or exception text. Invalid
cyclic/live objects and invalid/unsafe budget values cannot be snapshotted.
Budget failures use the budget part and a BudgetViolation witness, with no
offending number. Trusted policy/limit defects reject composition before an
action starts; a valid historical policy can witness invalid caller terms or
checked-arithmetic failure. Replay verifies the witness under
the immutable validator and policy rather than inventing numeric bounds.
A lone-surrogate witness must pass hasMidValue and ordinary append admission.
Symbol keys and executable objects are rejected without copying them.

inference.requested@2, context.refused@1 and context.persistence_failed@1 are
runtime-source only at these two managed sites. Every new managed request uses
v2, even via another ingress. C2c owns the explicit per-type version table,
trusted historical-vs-new-write mode, prevalidation before load mutation and
version-dispatched folding/indexes. Historical v1 logs keep v1 semantics;
accepted flags cannot turn v2 into v1. No rollback to a v1-only loader.

Admission verifies snapshots/digests and sealed inventory before recomputation.
Use the same injected historical accounting member as runtime assembly,
retaining its identity/version/digest with the recomputed ledger; a test-local
estimator is invalid even if it returns identical numbers. Check every route,
allowance, total, inclusion/order, manifest/template/body digest, view/request,
term and binding. Merely checking used <= reserved is insufficient.

## 5. Bounded persistence failure and stopped result

```ts
type PersistenceFailed = Binding & {
  code: 'evidence_record_too_large';
  attempted_type: 'inference.requested@2' | 'context.refused@1';
  attempted_payload_bytes: Positive;
  max_observation_bytes: Positive;
  attempted_decision_digest: Hex;
};
type StoppedResultV2 = {
  action_id: ActionId;
  outcome: { outcome: 'failed'; failure: 'context_overflow' | 'context_persistence_failure' };
  context_decision_id: DecisionId;
};
```

The marker has exactly these Binding and PersistenceFailed fields; its version
is in the observation envelope, not a second schema field. Owner is the closed
union above. All identities are fixed ASCII or bounded canonical decimals.
The two counts are positive safe integers and attempted_payload_bytes >
max_observation_bytes. Bind storage policy/attempted decision digest; no bodies,
exception text, free identifiers, ledger, token claims or reservation are allowed.
The marker records only known payload-size failure. It is never a numeric
refusal or proof that a complete decision was committed.

Measure ledger, evidence and entire decision payload separately with
payloadBytes; only the full canonical payload determines observation fit.
Include every duplicated snapshot/term/manifest/field. Physical journal envelope
and framing bytes are separate. Equality fits; one byte over submits the marker
instead, before entering the diagnostic-only oversize path. No evidence cutting,
blob storage or bound increase is authorized.

Closed maximum canonical payload sizes (all field encodings included):

| Payload                                            | Maximum bytes |
| -------------------------------------------------- | ------------- |
| context.persistence_failed@1, goal.frame owner     | 789           |
| context.persistence_failed@1, frontier.weigh owner | 847           |
| action.result@2 with context_persistence_failure   | 215           |

The test constructs each extremal encoding: all hex at length 64, decision id
length 68, largest safe decimal (16 digits), longest legal action/attempt ids,
longest attempted type and failure code. Punctuation, keys, quoting and nesting
are measured with the repository's canonical payloadBytes. No key/value needs
JSON escaping in these closed alphabets; each independent maximum is therefore
an upper bound for every valid payload. The marker maximum may conservatively
combine count lengths, but has a valid witness with attempted=MAX_SAFE_INTEGER
and bound=MAX_SAFE_INTEGER-1, so its maximum is attainable. No free action id or
owner string can evade these bounds: managed composition rejects a start whose
identity is outside the grammar before it can become running.

Generic composition rule: before enabling preparation, require a positive safe
configured log bound and a closed maximum-encoding proof for EVERY mandatory
stop-disposition payload. Verify max(marker variants), maximum stopped result,
and maximum clarification request each <= configured bound, with checked
canonical sizes. Missing proof, absent bound or one insufficient maximum is
unsupported configuration before any action/overflow. Never increase the bound.
C1 fixes marker/result bounds only. C2d-Q must supply the clarification schema,
maximum and independent equality/one-under checks; preparation cannot be enabled
until then. The C1 bound tests exercise each independently, including result
with marker disabled solely in the test composition proof input.

A stop-backed framing result has exactly action_id, outcome and the required
top-level context_decision_id. Only runtime-source goal.frame failed results
may use v2. context_overflow references the unique preceding accepted refusal;
context_persistence_failure references the unique preceding marker for the same
owner and started action. Admission/load/replay reject absent, unknown,
cross-owner/action, fit, wrong-code or free-text references and duplicate terminal
results. Preserve the typed reference in action state and accepted-record index.
New stopped results cannot downgrade to v1; all other result paths retain v1.

P2 prefers a separate durable goal-level clarification before an overflow's
result; the action always ends once as failed while the goal may await the
clarification. Pending clarification confers no call, spend or grant. A marker
needs separately authorized configuration/input change; a larger model cannot
repair storage failure. C2d-Q owns the exact request/response schema and one-time
response/change binding to fresh candidate/action identity. Failed candidates
stay excluded; no raw state change, response reuse or automatic retry is allowed.

## 6. Atomic transitions and append outcomes

Durable acknowledgment of a complete decision precedes state fold, reservation,
controller registration and dispatch of the exact sealed Prepared. Journal
contracts must establish atomic complete append, fsync before acknowledgment,
directory sync on creation, torn-tail repair, incomplete-append latch and other
writer detection. C2b reuses FileAttemptJournal's protocol for FileJournal;
current FileJournal is not evidence of these guarantees.

| Decision append outcome          | Contract                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| accepted                         | Fold once; only a fit may reserve/register/dispatch.                                                                         |
| known oversize                   | Premeasure and append one bounded marker; no full record claimed.                                                            |
| unexpected budget diagnostic     | Content-free persistence error, stop; no durable claim.                                                                      |
| mid_value                        | Contract error, stop, no dispatch or durable claim.                                                                          |
| duplicate                        | Reuse only an accepted identical canonical decision; absent/different accepted bytes is integrity failure. Never redispatch. |
| rejected / unknown_type          | Content-free contract error, no fallback or relaxed fields.                                                                  |
| journal throw / ambiguous append | Stop owner; reload before continuation. Never issue a speculative second marker.                                             |

| Stop-disposition append/feed outcome         | Contract                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| accepted                                     | Live/recovery fold after acknowledgment; replay consumes checked recorded bytes once in memory. |
| budget / mid_value / rejected / unknown_type | Stop and unwind before any continuation, reload; replay explicitly fails with no repair.        |
| duplicate                                    | Stop/reload even if in-memory bytes match; only reload completes missing writes.                |
| PersistError-as-rejected                     | Stop/reload; no result claimed durable.                                                         |
| journal throw, including written-then-throws | Stop/reload regardless of apparent commit; no in-process retry.                                 |

The second table covers stopped v2 results AND C2d-Q requests. Live stopped-result
code checks acceptance INSIDE the single-writer step, before drainQueue and later
selected dispatches or enclosing drains. Checking only after ordinary
recordResult returns is too late. Live accepted result may drain; reconcile's
pre-pass variant never drains. A failed write unwinds the entire active dispatch
or reconcile step, not merely the next cycle. Preserve acknowledged prefixes.
Even marker-append ambiguity requires reload and a content-free explicit error;
no acknowledged marker means no durable failure claim.

Recovery performs a non-draining stopped-framing pre-pass BEFORE constructing
the generic unfinished list, even with a generic action first or zero allowance.
Complete only the missing request/result suffix by recorded identity; no framing
recovery attempt/spend/lookup/grant. Then generic recovery retains its existing
rules. Double reload neither loses nor duplicates records. Outstanding fit
intents never redispatch; abandonment settles the existing reservation once.
Cancellation before append makes no decision; after append retains evidence
and normal settlement rules. Late responses cannot overwrite stops. Distinct
owners/actions have independent decisions within single-writer serialization.

## 7. FU5 replay feed policy (specification only)

Resolve historical snapshots and procedures by immutable identity, verify
sealed evidence, then reconstruct canonical bytes/digests and exact arithmetic.
Markers reproduce only their failure/policy identity; never read a nonexistent
view or reconstruct a nonexistent ledger. Index accepted fits/refusals/markers
by id, owner/logical attempt and site. Goal.frame replay matches its started
action's stop without recapture or append. No journal, gateway, host, Weft,
grant or recovery effect occurs during replay.

Policy is keyed by (record type, write site), not payload type alone:

| Record                              | Write site                           | Validation / ordering                                                                                          | Continuation                                                                                     |
| ----------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| C2d-Q overflow request              | live execute                         | Unique owner/action/decision, request before result; reproduce only while nextSeq matches.                     | No request drain.                                                                                |
| action.result@2 stop                | live execute                         | Closed v2 admission, exact reference/envelope; inline only at nextSeq.                                         | Return outcome; reconstruct recorded scoped queue continuation before later selected candidates. |
| C2d-Q request                       | reconcile pre-pass                   | Delayed beyond execute: feed at recorded seq through trusted replay admission, never repair.                   | Fold only; no cycle or drain.                                                                    |
| action.result@2 stop                | reconcile pre-pass                   | Same per-record cursor; request can be inline and result delayed.                                              | Fold only; no cycle or drain.                                                                    |
| action.started queued               | stop-backed live result drain        | Pending historical identity, payload, authority and seq; reconstruct in non-executing replay environment.      | No invoke/new grant; one cursor arming.                                                          |
| action.started queued               | post-pre-pass end-of-reconcile drain | Same result-bound state/seq predicate; never start inside pre-pass.                                            | No bypass of generic recovery records.                                                           |
| action.cancel_requested             | either scoped queue continuation     | Reject scoped_queue_cancel_unreachable; publish cannot coexist with uncovered framing.                         | No feed/reconstruction.                                                                          |
| recovery.exhausted                  | generic early return after pre-pass  | Verify unfinished generic work and exhausted allowance, at seq, before any queued/later selected review start. | No drain, recovery attempt, lookup or repair.                                                    |
| ordinary results / queue / recovery | other write sites                    | Preserve existing prefix divergence, missing-result and unfinished-action failures.                            | FU6 remains outside #353; unrelated stop does not qualify.                                       |

Each disposition has one cursor state: pending, reproduced inline or fed.
Queue records can be reconstructed once, never fed as arrivals. Skip only
already reproduced identical bytes at the same seq. Adjacency permits in-memory
reproduction even if recovery wrote it, never effects or invented starts. Arm
queue continuation once after accepted stopped result, keyed by owner/action/
decision/result seq; no inference about indistinguishable write origins.
Keep exact prefix, final length and unfinished-action checks. Do not skip later
selected candidates to repair interrupted selections. Wrong reference/order,
double/missing consumption, validation errors or missing history fail replay.

Run the historical pending filter/order, slot check and stillAuthorized before
queue reconstruction. Only contiguous next-seq starts matching an accepted
pending action.queued qualify. Compare action/candidate ids, inputs, read set,
effects, reservation, recorded grant and invocation identity, plus canonical
envelope and validation. Call only replayEnvironment.execute for its recorded
outcome; never invokeHost, liveEnvironment, grantForLookup or reconcile.
A non-scoped ingress, ordinary/reconciled result, recovery.attempted or
recovery.exhausted BETWEEN the v2 result and queue record permanently closes
that cursor. The enclosing ingress BEFORE the result does not. Consuming an
already reproduced result cannot re-arm it. A mismatched drain, missing expected
start or later start after closure fails; a stop elsewhere cannot qualify it.
Both trailing ingress/ordinary-result drains must append nothing in L2; an
extra start attributable only to either retains FU6's failure. At these two
scoped sites only report.review can be pending under uncovered PROCEDURE_FRAME;
host-backed or publish continuations have no supported formation witness.

For the running-review restart variant, freeze all inputs except the opened
goal's recovery allowance (0 versus 1), fork after X starts and the selecting
ingress has settled, and retain no open inference or other unfinished work.
Use a fresh FakeHost without a GrantAuthority/invocation for X, whose recorded
grant is null. Fix q = prefix.last_seq + 1. Lookup's unresolved reason is exactly
`no durable record for ${invocation_id}`. First prove replay's identical prefix
through q-1 with zero effects, ending at_seq=null with the expected
`missing recorded action.result for ${X.action_id}` failure. An earlier stop or
version mismatch cannot count. At allowance 0, recovery.exhausted at q remains
outside the scoped pre-continuation barrier after X has started: replay fails
at_seq=q with `recorded log continues beyond what replay reproduced`. At
allowance 1, recovery.attempted at q spends one and lookup happens once; the
uncertain runtime review result at q+1 has the exact lookup reason. Existing
feedReviewResult takes seq q, so checkPrefix fails there with
`replay diverged from the record at seq ${q}`, rather than final-length failure.
Neither fork permits a new generic-recovery feed or finishReview on a missing
view. These are failure witnesses, never completed-log replay success.

The contiguous nine-row T9 table in the pinned plan is the witness declaration,
not implemented behavior. Required rows: T9-L1, T9-L2, T9-R0, T9-R1, T9-R2,
T9-R1x, T9-Q0, T9-G1, T9-C1. The C1 coverage check preserves each exact row and
the synthetic validate/load recipe plus retained formation-precursor requirements.
Every row needs procedure, candidate set, source pins and scheduling evidence
before behavioral evidence counts. L1 uses uncovered PROCEDURE_FRAME's frame/
review frontier; L2/R2(a) use scripted A/review, queued review, incomplete A,
then B; R1 crashes a real pending weighing on framing-only weights ingress.
G1 retains the ordinary source.inspect generic replay gap. R0/R1x/C1/Q0 are
synthetic ordering/rejection states, never reachable-composition success claims.

R1/R2(a) finish review in the first process BEFORE second reload. Fork the
running-review restart variant with zero and positive allowance, fixed lookup,
q and feedReviewResult reporter. R1 retains abandonment, its new weighing and
later gateway arrival without pending queued review. R1x pins exact recovery
spend, second-reload exhaustion and divergence at recovery.attempted; never feed
past it. R0/C1 preserve exhaustion/mid-selection divergence. Q0 rejects scoped
cancel at the exact prefix. L2 proves both enclosing drains append nothing;
site-2 reconstruction is required for supported post-pre-pass continuation.
Uniform feed/regenerate, replay drain no-op, pre-pass drain, double reconstruction,
accepted cancel, extra spend and unscoped queue feed must all fail future tests.

Retained C2d precursor must independently pin P_overflow and P_marker under
final storage policies; measuredCeiling comes from P_overflow. Keep A/B full-bound
equalities and both term-only invariance assertions, fixed route membership,
separate determinism comparison and final-term marker byte counts. Recompute B's
ledger from sealed complete refusal evidence through the SAME injected historical
member, retaining its version/digest. Substitution with a test-local estimator
fails even with equal numbers. These are future behavioral obligations; C1's
coverage check establishes document completeness only.

## 8. Source symbols and C1 evidence

Contract source pins contain symbols only, no line numbers. The FU3 test resolves
these tracked paths and exported symbols against the child's base:

| Path                                   | Exported symbols                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/weave/src/types.ts`          | `StateView`, `ViewSliceManifest`, `ActionResultPayload`, `ActionOutcome`, `DecisionLayer` |
| `packages/weave/src/views.ts`          | `renderFrameView`, `renderWeighView`, `sliceAssemblyId`                                   |
| `packages/weave/src/log-bound.ts`      | `payloadBytes`, `hasMidValue`                                                             |
| `packages/weave/src/stable-json.ts`    | `stableStringify`                                                                         |
| `packages/weave/src/digest.ts`         | `digest`, `candidateId`                                                                   |
| `packages/weave/src/journal.ts`        | `FileJournal`, `MemoryJournal`                                                            |
| `packages/weave/src/implement-step.ts` | `FileAttemptJournal`                                                                      |
| `packages/weave/src/audit-view.ts`     | `assembleAuditState`                                                                      |
| `packages/weave/src/runtime.ts`        | `Runtime`, `replay`                                                                       |
| `packages/weave/src/state.ts`          | `applyAccepted`, `initialState`                                                           |
| `packages/weave/src/validation.ts`     | `validate`                                                                                |

T1–T4 and T15 marker/result contracts run against explicit invalid test-only
placeholders. Direct red mode must produce assertion failures, not missing
imports/types. Default tests verify each mutation is killed; that does not mean
a production implementation is green. See test/fixtures/context-budget/EVIDENCE.md
for commands, measured sizes, demonstrated red and available-suite results.
