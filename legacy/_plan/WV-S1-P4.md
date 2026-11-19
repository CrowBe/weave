# WV-S1-P4 — replace D3 with Decide-1/2 (P4a: the Decide-1 rule table feeds every dispatch decision)

Parent: https://github.com/CrowBe/weave/issues/381
Issue: to be opened for P4a–P4c (do not invent a number in the commit; Refs parent #381).
Plan: `_plan/WV-S1-frontier.md` §2 (loop shape), §3 (bands, provisional floors), §7 P4, §8 F6/F7. Locks: D-ENG-030 (ask only for irreversible + low confidence, or ambiguity only the operator can resolve), D-ENG-031 (intake / D1 / D2 hold dispatch authority), **D-ENG-044** (every Decide/split spawn carries a sealed parent frame: parent goal, why this child was spawned, sibling / `depends_on` edges; never a bare subtask string), **D-ENG-045** (Decide-1 is a rule table over isolated judgments plus code facts; the closed band is the rule output, not a single Choice; `dispatch.decided` carries every judgment with its probability, every code fact, the rule that decided, and the band).

Repo CrowBe/weave. Worktree `/workspace/weave-WV-S1-P4` (self-contained clone), today at `f15229b` (origin/main). **Rebase onto main after P3a (#393) merges**, then branch `wv-s1-p4a-decide1`.

## depends_on

- **P3a (PR #393, not merged; must merge before P4a implement).** P4a edits `packages/weave/src/dispatch.ts` and `packages/weave/test/dispatch.test.ts`, which only exist on #393's branch. This brief writes P3a's briefed names (`decideDispatch`, `transitionDispatch`, `DispatchCheckpoint`, `DispatchDecision`, `DispatchIntent`, `dispatchJudgments`, `MemoryDispatchJournal`, the outcome table in `_plan/WV-S1-P3.md`). If review renames or reshapes any of them, use the merged code and keep this brief's behaviour. If #393 is abandoned, stop and report: P4a must not re-create a dispatch composition of its own.
- **P3b (merged, `d92e6c5`): Weft kind `dispatch.decided`** with the D-ENG-045 trace fields (`packages/weft/src/types.ts:104`, `validate.ts:193`, `WEFT-CONTRACT.md` §`dispatch.decided`). P4a emits it as-is and does not change `packages/weft`. P3b's "Loom emission commit after P3a" is **delivered by P4a** (D-P4a-3). If a separate emission commit lands on main first, P4a replaces its trace builder with Decide-1's output and keeps one emitter, not two.
- **P2a / P2b / P2c (merged):** `decideIntake`, `intake.decision@1`, typed-state origin, `decideTriage` / `decideLoopRoute` (`packages/weave/src/sites/loop-decide.ts`). P4a reaches no site directly and adds no model call.
- **Not P5.** P4a forms no spawn intent and no child plan. The `spawn_subtasks` band exists in the type but no P4a row returns it (D-ENG-044 guard below). Split, preflight `target.roles` and tier selection stay P5.

## Split

P4 is three PRs. This brief covers **P4a** in full.

- **P4a (this brief):** a pure, versioned **Decide-1 rule table** (`decide1.rules@1`) over named judgments and code facts that returns `{ rule, band }`. `decideDispatch` builds its plan **from the rule's output** instead of P3a's inline if-chain. The trace is stored in the journal record (`dispatch.decision@2`) and emitted as one Weft `dispatch.decided` per appended decision. The P4a rows reproduce P3a's outcome table exactly (parity), so the authority boundary moves into the table with no behaviour change. No new model question, no gateway / Weft / benchmark / `SITE_POLICY` change.
- **P4b:** isolated Decide-1 judgments. Add boolean questions asked each in isolation, never as one Choice (`clarify`, `multi_deliverable`, `reads_before_gen`, `veto_bare_gen`; names from the §3 sim vetoes), plus the `residual_ambiguity` fact from D1's final `extract@1` (the checkpoint then stores `loop.decision@1`, not only the `SiteTransition`). New rows route to `ask_human` / `spawn_subtasks` / `escalate_gen` per §3. Spawn rows stay `paused` / `spawn_unavailable` until P5 supplies the sealed parent frame (D-ENG-044). Blocked on Open question 1 (shadow vs. gating).
- **P4c:** **Decide-2** and D3 retirement. After a `tool_call` band whose action the intent kind does not already fix (today only D1 `capability`), Decide-2 picks exactly one entry from the disclosed M6 catalogue index. A targeted extract then pulls only that entry's args from the original plus prior grounded slots (`extract@1`; a required arg that comes back null is an `ask_human` row per D-ENG-030 / §3). The `capability` intent gains `entry_ref` and an args record ref. `loop.preselect` leaves the loop: the M7 diagram replaces the D3 node, `sites/CONTRACT.md` P6 section and GLOSSARY **Preselect policy** mark D3 as a frozen benchmark/Gauge site that no runtime composition may feed into a generation prompt, and a check pins it. The `boolean.ts` site code, `examples/preselect.ts` and its benchmark sets stay (frozen digests; Decide-2 may reuse D3's per-entry relevance evidence). Blocked on Open question 2. Until P4c lands, P3c must not wire D3 into the implementation prompt either.

## Goal (smallest change)

Every dispatch decision's band is **the output of one deterministic rule table**, and Weft and the journal carry the full Decide-1 trace (judgments with probabilities, code facts, the deciding rule id, the band) for every decision appended, including asks and pauses no site answered. Dispatch behaviour (which decisions dispatch, with which intent, which ask, which pause) is identical to P3a for every stage shape `transitionSite` can produce (D-P4a-10 covers the rest). Later P4/P5 slices add rows and inputs, not a new decision path.

## Preflight targets (closed-set roles)

| path                                                                                                                    | role                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/weave/src/decide1.ts`                                                                                         | edit (new): `Band`, `DECIDE1_BANDS`, `Decide1Judgment`, `Decide1Fact`, `Decide1Inputs`, `Decide1Trace`, `Decide1RuleId`, `DECIDE1_RULE_TABLE = 'decide1.rules@1'`, frozen ordered `DECIDE1_RULES`, pure `decideBand`. Imports nothing from `dispatch.ts`, `sites/` or `@weave/gateway` |
| `packages/weave/src/dispatch.ts` (lands in P3a)                                                                         | edit: pure `decide1Inputs(request, checkpoint)`; replace the inline plan chain with `planFor(trace, checkpoint)` (exhaustive switch over `Decide1RuleId`); record `dispatch.decision@2`; pure `dispatchDecided(...)` Weft builder; emit after the judgments                            |
| `packages/weave/test/decide1.test.ts`                                                                                   | edit (new): tests 1–6                                                                                                                                                                                                                                                                  |
| `packages/weave/test/dispatch.test.ts` (lands in P3a)                                                                   | edit: tests 7–14. P3a's existing assertions stay unchanged except the record key-set/order test, which moves to `@2` (D-P4a-5)                                                                                                                                                         |
| `packages/weave/src/index.ts`                                                                                           | edit: export the new public names beside the P3a `./dispatch.js` block                                                                                                                                                                                                                 |
| `packages/weave/src/sites/CONTRACT.md`                                                                                  | edit: new section "WV-S1 P4a Decide-1 rule table" after P3a's section: table, band semantics, pause band, D-ENG-044 guard, trace fields. Amend P3a's outcome-table paragraph to say the table is now `decide1.rules@1`                                                                 |
| `GLOSSARY.md`                                                                                                           | edit: add **Decide-1** (and its rule table); one sentence in **Decide-1 trace** that the journal record carries the same trace and that a paused decision's band is the band of the choice it withheld                                                                                 |
| `packages/weft/src/types.ts`, `validate.ts`, `WEFT-CONTRACT.md`                                                         | read: `dispatch.decided` fields, `CODE = /^[a-z][a-z0-9_.@:-]{0,63}$/`, `DECIDE_JUDGMENT`, `DECIDE_FACT`, ≤64 lists, name-once rule, `caused_by` to `judgment` records                                                                                                                 |
| `packages/weave/src/weft.ts`                                                                                            | read: `deliver`, `WeftPort`, `WeftRecordShape` (P3a exports `deliver`)                                                                                                                                                                                                                 |
| `packages/weave/src/intake.ts`                                                                                          | read: `IntakeDecision` (`decided_by: 'extract' \| 'site'`, `choice`, `status`, `reason`, `site: SiteObservation \| null`)                                                                                                                                                              |
| `packages/weave/src/sites/index.ts`                                                                                     | read: `SiteTransition`, `SiteObservation`, `SiteReason`, `SITE_POLICY`, `correlation`, `unit`                                                                                                                                                                                          |
| `packages/weave/src/sites/loop-decide.ts`                                                                               | read: `LoopDecision` (P4b will store it; P4a does not)                                                                                                                                                                                                                                 |
| `packages/weave/src/sites/boolean.ts`, `examples/preselect.ts`, `docs/m7-decision-loop.md`                              | read (P4c context: D3 is not wired into any runtime composition on main; only tests, example and benchmarks call it)                                                                                                                                                                   |
| `_plan/WV-S1-P3.md`, `_plan/WV-S1-P3b.md`                                                                               | read: P3a outcome table (parity oracle), P3b fields                                                                                                                                                                                                                                    |
| `packages/weave/test/intake.test.ts`, `loop-decide.test.ts`, `w5-records.test.ts`, `p6.test.ts`, `p6-preselect.test.ts` | read; must pass unchanged                                                                                                                                                                                                                                                              |
| `packages/weft/**`                                                                                                      | forbid (P3b contract is final for P4a; band stays the closed 4-set)                                                                                                                                                                                                                    |
| `packages/gateway/**`, `packages/agentfabric/**`                                                                        | forbid                                                                                                                                                                                                                                                                                 |
| `benchmarks/**` (runner, sets, `DIGESTS.json`, results; every `holdout.jsonl`)                                          | forbid (never read holdout; never mutate)                                                                                                                                                                                                                                              |
| `SITE_POLICY`, `BOOLEAN_SITE_POLICY` values, options, thresholds, fallbacks, question text                              | forbid                                                                                                                                                                                                                                                                                 |
| `checks/*.mjs`                                                                                                          | read; must pass; forbid widening any `ALLOWED` / `TEST_EXTRA` list                                                                                                                                                                                                                     |
| `VISION.md`                                                                                                             | forbid (no acceptance boundary moves; `VISION.md:54` already covers authority)                                                                                                                                                                                                         |
| `wvops/s1-sim/**`                                                                                                       | forbid mutate                                                                                                                                                                                                                                                                          |
| `packages/weave/src/sites/boolean.ts`, `examples/preselect.ts`, `docs/m7-decision-loop.md`                              | skip edits (P4c)                                                                                                                                                                                                                                                                       |
| `packages/weave/src/sites/model-extract.ts`, `sites/extract.ts`, `sites/loop-decide.ts`                                 | skip edits (P4b / P4c)                                                                                                                                                                                                                                                                 |
| `packages/weave/src/runtime.ts`, `scheduler.ts`, `implement-step.ts`, `workstream.ts`, `operating-process.ts`           | skip (P3c port; P5 spawn)                                                                                                                                                                                                                                                              |
| `weave.routes.example.json`                                                                                             | skip                                                                                                                                                                                                                                                                                   |

## Data shape

All names are new unless marked existing. Every enum is closed. Records copy no message, summary, context, provider or error text. Ids pass `correlation()`; every rule id and fact/judgment name passes Weft's `CODE`.

**Decide-1 (`decide1.ts`).**

```ts
export const DECIDE1_BANDS = ['tool_call', 'spawn_subtasks', 'escalate_gen', 'ask_human'] as const; // = Weft band
export type Band = (typeof DECIDE1_BANDS)[number];
export const DECIDE1_RULE_TABLE = 'decide1.rules@1' as const;
export interface Decide1Judgment {
  readonly name: string;
  readonly probability: number;
} // unit(probability)
export interface Decide1Fact {
  readonly name: string;
  readonly value: string | number | boolean | null;
} // string = id
export interface Decide1Inputs {
  readonly judgments: readonly Decide1Judgment[];
  readonly facts: readonly Decide1Fact[];
}
export interface Decide1Trace extends Decide1Inputs {
  readonly table: typeof DECIDE1_RULE_TABLE;
  readonly rule: Decide1RuleId;
  readonly band: Band;
}
interface Decide1Rule {
  readonly id: Decide1RuleId;
  readonly when: (facts: ReadonlyMap<string, Decide1Fact['value']>, judgments: ReadonlyMap<string, number>) => boolean;
  readonly band: Band | 'withheld'; // 'withheld' only on hold.* rows
}
export function decideBand(inputs: Decide1Inputs): Decide1Trace; // first match; throws 'decide1: no rule matched'
```

`decideBand` validates its inputs (names unique and `CODE`-shaped, probabilities in [0, 1], fact values scalar, string values pass `correlation()`, each list ≤ 64) and throws on violation, so a bad trace can never reach a record. `'withheld'` resolves through the pure `bandOfChoice(stage, choice)` below.

**Code facts (fixed names, fixed order, every name always present; `null` when the stage was not asked).** These are exactly what the P4a rows read.

| fact                                                  | value                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `intake.decided_by`                                   | `extract` \| `site`                                                                                                     |
| `intake.choice`                                       | intake `SiteChoice`                                                                                                     |
| `intake.status`                                       | `transition` \| `paused` \| `needs_human`                                                                               |
| `intake.reason`                                       | `SiteReason` \| `ambiguous_reference`                                                                                   |
| `intake.accepted`                                     | flag (`site?.accepted ?? false`)                                                                                        |
| `thread_target`                                       | `resolved` \| `no_target` \| `ambiguous_reference` \| null (only for a thread relation; from P3a `resolveThreadTarget`) |
| `triage.choice` / `.status` / `.reason` / `.accepted` | from the stored `SiteTransition`, or null                                                                               |
| `route.choice` / `.status` / `.reason` / `.accepted`  | same, or null                                                                                                           |

**Judgments (only non-null unit values, in stage order).** `intake.confidence`, `intake.top_p`, `triage.confidence`, `triage.top_p`, `route.confidence`, `route.top_p`, each from the stage's `SiteObservation`. A stage that no site answered (intake `decided_by: 'extract'`, origin failure) contributes none. In P4a the rows read the code fact `<stage>.accepted`, which `SITE_POLICY` (frozen) derived from these probabilities; the judgments record what that admission read. P4b adds isolated boolean judgments that rows read directly.

**Rule table `decide1.rules@1`** (15 ids, D-ENG-049; first match wins; order is P3a's precedence). `decided_by`, status, reason and intent come from `planFor`, which is an exhaustive switch over the rule id, so each row has exactly one outcome.

| #   | rule id               | when                                                                                         | band           | P3a outcome (`decided_by`, status / reason, intent)       |
| --- | --------------------- | -------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------- |
| 1   | `hold.admission`      | first asked stage (intake → triage → route) with reason `stale_answer` / `mismatched_answer` | withheld       | that stage, `paused` / that reason (terminal)             |
| 2   | `hold.outage`         | first asked stage with reason `decision_unavailable`                                         | withheld       | that stage, `paused` / `decision_unavailable` (resumable) |
| 3   | `hold.paused`         | first asked stage with status `paused` not covered above                                     | withheld       | that stage, `paused` / its reason                         |
| 4   | `ask.intake`          | `intake.status = needs_human`                                                                | `ask_human`    | intake, `needs_human` / intake reason                     |
| 5   | `ask.irreversible`    | `intake.choice = stop`                                                                       | `ask_human`    | rule, `needs_human` / `irreversible`                      |
| 6   | `ask.thread_target`   | thread relation and `thread_target ∈ {no_target, ambiguous_reference}`                       | `ask_human`    | rule, `needs_human` / that reason                         |
| 7   | `act.thread`          | thread relation and `thread_target = resolved`                                               | `tool_call`    | intake, `thread` intent                                   |
| 8   | `ask.triage`          | `triage.status = needs_human`                                                                | `ask_human`    | triage, `needs_human` / triage reason                     |
| 9   | `act.capability`      | triage accepted `capability`                                                                 | `tool_call`    | triage, `capability` intent                               |
| 10  | `act.done_check`      | triage accepted `done_check`                                                                 | `tool_call`    | triage, `done_check` intent                               |
| 11  | `act.decline`         | triage accepted `out_of_scope`                                                               | `tool_call`    | triage, `decline` intent                                  |
| 12  | `gen.triage_fallback` | triage status `transition`, not accepted, choice `implement`                                 | `escalate_gen` | triage, `implement` strong/strong `triage_fallback`       |
| 13  | `gen.route`           | route status `transition`, accepted with a tier                                              | `escalate_gen` | route, `implement` at that tier, `route`                  |
| 14  | `ask.route`           | `route.status = needs_human`                                                                 | `ask_human`    | route, `needs_human` / route reason                       |
| 15  | `gen.route_fallback`  | route status `transition`, asked, not accepted                                               | `escalate_gen` | route, `implement` standard/standard, `route_fallback`    |

Anything else matches no row and throws before `claim`. That covers intake `new_thread` with no triage, which is P3a's "impossible stage set". It also covers P3a's defensive guards: an intake choice outside the known set, an accepted triage choice outside the options, and a non-accepted triage whose choice is not `implement`. P3a returns `needs_human` / `invalid_answer` for those, and P4a throws instead (D-P4a-10). Cancellation never reaches the table: P3a appends nothing.

**Band semantics.** `tool_call` is a deterministic act with no generation (thread routing, capability, done check, decline). `escalate_gen` is a generative implementation step. `ask_human` asks. `spawn_subtasks` is unused in P4a. A `hold.*` row returns the band of the choice the pause withheld: `bandOfChoice(stage, choice)` maps intake `ask_user` / `stop` → `ask_human`, intake thread relations → `tool_call`, triage `capability` / `done_check` / `out_of_scope` → `tool_call`, triage `needs_human` → `ask_human`, triage `implement` and every route tier → `escalate_gen`. Band never stands for resolution by itself: a reader counts asks by `status = needs_human` and escalations by `band = escalate_gen ∧ status = dispatched` (D-P4a-4).

**`dispatch.decision@2`** (P3a's `@1` with two keys inserted after `reason`). Keys in this order:

```text
{ schema: 'dispatch.decision@2', decision_id, entry, state_revision,
  decided_by, choice, status, reason,
  rule_table: 'decide1.rules@1',
  decide1: { judgments: Decide1Judgment[], facts: Decide1Fact[], rule: Decide1RuleId, band: Band },
  intent, receipt, intake, triage, route }
```

`dispatch.checkpoint@1` is unchanged: the trace is a pure function of the checkpoint, the captured request and the table version.

**Weft emission (`dispatch.decided`, P3b kind, unchanged contract).** For each decision **this call appended**, after P3a's `judgment` records and after the final `append`, the pure `dispatchDecided(decision, judgmentIds, target, sequence)` builds:

```text
{ schema: 'weft.record@1', trace_id, record_id: '<emitter>:dispatch:<decision_id>:<entry>',
  emitter: { kind: 'loom', id: emitter_id }, sequence, kind: 'dispatch.decided',
  thread_id: null, parent_id: null,
  links: [{ rel: 'caused_by', record_id: '<emitter>:judgment:<request_id>' } …],   // only judgments emitted in this call
  evidence: [{ source: 'observation', ref: decision_id },
             { source: 'inference_request', ref: <each stage request_id the decision used> } …],
  fields: { decision_ref: decision_id, decided_by, choice, status,
            tier?,          // only for an implement intent
            dispatch_ref?,  // only when an intent was formed
            judgments, facts, rule, band } }
```

Stages reused from an earlier call are cited as `inference_request` evidence, not linked, because a restarted instance has a new emitter id and their judgment record ids are unknown. If any id would fail `correlation()` (for example a long emitter id plus a 96-character decision id), build no `dispatch.decided` for that decision. Never truncate an id. The decision itself is unaffected. Sequence continues P3a's per-port counter.

## Runtime behaviour

`decideDispatch(request, ports, journal, signal?)` keeps P3a's steps 1–4 and 6 unchanged: validation, capture before await, recorded/terminal return, unconfirmed-intent handling, staged asks with ask counts checkpointed before each ask, reuse of checkpointed stages, `now()` re-read before reuse and claim. Step 5 becomes:

1. `inputs = decide1Inputs(captured request, checkpoint)`, then `trace = decideBand(inputs)`, then `plan = planFor(trace, checkpoint)`. All three are pure. A throw here (invalid inputs, no rule) propagates before `claim`, so nothing dispatches, which matches P3a's journal-throw-before-claim rule.
2. A dispatch plan re-reads `now()`, then `claim`s, calls the port, maps the receipt, and `append`s exactly as P3a does. The receipt changes `status` / `reason` (`approval_required` → `needs_human`, `budget` → `paused`, …) but **never the rule or the band**. The trace records how the decision was reached, and the receipt records what the port did.
3. Emit P3a's `judgment` records, then one `dispatch.decided` per appended decision.

`transitionDispatch(request, checkpoint, receipt)` recomputes the same trace and decision with no port. A recorded `@2` decision whose `rule_table` differs from `DECIDE1_RULE_TABLE` throws on replay, so a later table never silently reinterprets an old decision.

**Dispatch authority and ask-human (D-ENG-030).** Authority and asking stay exclusive per decision. An `ask_human` row forms no intent and claims nothing. The only `ask_human` rows are P3a's sanctioned asks: intake could not place the message (its `ask_user` fallback: no safe default relation exists), `ambiguous_reference` / `no_target`, D1 or D2 status `needs_human` (including `invalid_extract` / `extract_missing` origin failures; D-ENG-049), intake `stop` (irreversible; τ_irrev unmeasured), plus the port's `approval_required` receipt, which changes status, not band. No row maps D1/D2 `low_confidence`, `missing_confidence`, `low_top_p`, `invalid_answer` or `no_answer` to `ask_human`: those take the reversible `gen.*` fallbacks and dispatch. Outages, staleness and cancellation pause and never ask. Test 3 pins this over the whole input domain. Downstream irreversible effects stay behind grants and approvals at the port. A rule cannot mint, widen or satisfy them, and an intent still carries no grant, scope or approval field.

**D-ENG-044 guard.** No P4a row returns `spawn_subtasks`, and `planFor` throws on it with message `spawn_subtasks needs a sealed parent frame (D-ENG-044, P5)`. That makes a bare-child spawn unrepresentable until P5 adds the parent-frame intent. Test 1 pins "no spawn row in `decide1.rules@1`".

**Failure.** `decideBand` / `planFor` throws are code defects. They surface before any claim and are never recorded with text. A Weft sink that throws or rejects changes nothing (P3a `deliver`). A journal throw on the final `append` after dispatch leaves the intent durable, the next call reports `dispatch_unconfirmed` (P3a), and that later append gets its own `dispatch.decided`.

**Cancellation.** Unchanged from P3a. Abort before claim appends nothing and emits nothing. An abort during dispatch takes P3a's path, and if P3a appends a decision there, that decision's trace is the same rule and band as the plan it aborted.

**Concurrency.** `decide1.ts` holds no state, and `DECIDE1_RULES` and its rows are frozen. Separate decisions share only the per-port Weft sequence counter, which advances synchronously inside `emit`. Two concurrent decisions on one port therefore get unique, strictly increasing sequences. The same `decision_id` run twice still yields one claim winner (P3a). Only the winner's appended decision has an intent and a `dispatch_ref`. The loser's `paused` / `dispatch_unconfirmed` decision gets its own trace and record id (different `entry`).

## Tests (red before green)

Write each test and show it failing before the implementation lands. Use fake `generate` / `evaluate` / `dispatch` / Weft ports and authored fixtures with canaries (`CANARY-msg`, `CANARY-summary`, `CANARY-ctx`, `CANARY-provider`, `CANARY-error`). Use no benchmark rows. Reuse P3a's fixtures and P2b's canary helper.

`decide1.test.ts`:

1. **Table shape.** Rule ids are unique and pass `isCode` from `@weave/weft` (a test-only edge that `checks/import-direction.mjs` allows). `DECIDE1_RULES` and each row are frozen. Every band is in `DECIDE1_BANDS`. Only `hold.*` rows use `'withheld'`. **No row returns `spawn_subtasks`** (D-ENG-044 until P5).
2. **Totality and reachability.** Enumerate the reachable domain: intake (`decided_by` × choice × status × reason), `thread_target`, triage and route (choice × status × reason × accepted, or not asked), all respecting stage dependencies. Every input matches exactly the row its P3a outcome names, every row is matched by at least one input, and each impossible stage set throws `decide1: no rule matched`.
3. **D-ENG-030 over the domain.** No input whose deciding stage reason is a D1/D2 fallback reason yields `ask_human`. Every `stale_answer` / `mismatched_answer` / `decision_unavailable` input yields a `hold.*` row. The only `ask_human` rows are intake (`ask.intake`), irreversible (`ask.irreversible`), thread target (`ask.thread_target`), triage (`ask.triage`) and route (`ask.route`). Origin-failure modes `invalid_extract` and `extract_missing` are crossed for triage and route, preserving their P3a ask outcome. Every `gen.*` row requires status `transition`.
4. **Withheld band.** `bandOfChoice` over every stage × choice: intake outage → `ask_human`, D1 outage → `escalate_gen`, D2 outage → `escalate_gen`, stale D1 whose fallback says `implement` → `escalate_gen` with status `paused` (the stale-D1 trap stays a pause).
5. **Input validation.** Duplicate names, a non-`CODE` name, probability < 0 or > 1 or NaN, an object/array/text fact value, a value failing `correlation()`, or a list longer than 64 all throw. Inputs are not mutated, and identical inputs give deep-equal traces.
6. **Purity.** `decide1.ts` imports nothing from `./dispatch.js`, `./sites/` or `@weave/gateway` (a source assertion in the test). `decideBand` makes no call when its ports are absent (it has none).

`dispatch.test.ts`:

7. **Parity.** Every P3a test (1–19) passes with its assertions on intents, status, reason, `decided_by`, `choice`, call order and call counts unchanged, except the D-P4a-10 guard cases, which now throw. A table maps each P3a case to its expected `rule` and `band`.
8. **Record.** `dispatch.decision@2` exact keys and order. `decide1` deep-equals `decideBand(decide1Inputs(request, checkpoint))`, with facts in the fixed order and all 14 names present. `JSON.stringify` of journal contents and the return value contains no canary. There is no `grant` / `scope` / `approval` / `provider` key.
9. **Receipt does not move the band.** `approval_required` → status `needs_human` with rule and band unchanged. `budget` → `paused` with the same. Resumed and re-presented → `entry` 2 with the same rule and band.
10. **Weft `dispatch.decided`.** One per appended decision, delivered after the `judgment` records and after the final `append` (the fake sink asserts journal state). Each passes `validateRecord` from `@weave/weft`. Fields mirror the record: `tier` only for an implement intent, `dispatch_ref` only when an intent was formed. `caused_by` links equal this call's judgment record ids. Reused stages appear only as `inference_request` evidence. Sequences rise across `judgment` and `dispatch.decided`. A resume yields a second record `…:<decision_id>:2`. A recorded, replayed or cancelled-before-claim decision emits nothing. A throwing or rejecting sink leaves the decision deep-equal to a run with no Weft port. An emitter id that makes `record_id` fail `correlation()` builds no `dispatch.decided`, and the decision is unchanged.
11. **Asks and pauses still emit.** An intake `ask_user` (no D1), P2a `ambiguous_reference` (intake `decided_by: 'extract'`, so `judgments` is empty and the field is present), `stop`, and a D2 outage each emit exactly one `dispatch.decided` with the tabled rule, band and status.

12. **Replay.** `transitionDispatch` deep-equals the live decision, including `decide1`, with ports that throw if called. A recorded decision with `rule_table: 'decide1.rules@0'` throws.
13. **Concurrency.** Two decisions with deferred answers resolved out of order on one Weft port: unique, strictly increasing sequences, and each trace is bound to its own decision. The same id run concurrently gives one claim winner, one port call, two appended decisions with distinct `entry` and record ids, and `dispatch_ref` only on the winner. Mutating the caller's request after the call changes no trace.
14. **No new inference.** For every P3a case, the `generate` / `evaluate` call count and every request deep-equal P3a's. Decide-1 adds no model question in P4a. `SITE_POLICY` is unchanged. `p5`, `p6`, `p6-preselect`, `intake`, `loop-decide` and `w5-*` tests and `test:decision-sites` pass with no edits.

**Fix1 verification boundary (da91cc4).** `gateExtract` finalizes attempt 2 as `original_only` or `use_hints`; provider text cannot set its verdict. `dispatch.ts` also re-derives stored loop stages before applying the table and rejects `invalid_extract` / `extract_missing` stage fixtures. The requested second-`re_extract` live dispatch case therefore cannot produce an appended ask without bypassing or changing validation. The domain test covers both origin failures at both loop stages, and the dispatch regression pins their ask rows plus refusal of untrusted stages with zero inference, dispatch or emissions. The requested one-`dispatch.decided` regression remains blocked by these existing boundaries.

Checks: `npm run check` (`import-direction`, `gauge-attribution-contract`, `extract-before-site`, `no-ambient-clock`, `no-ambient-entropy`, `no-ambient-env`, `no-swallowed-failures`), `npm run test:checks`, `npm run fmt:check`, `npm test`, `npm run test:decision-sites`, `npm run test:weft-contract`, then **`npm run verify` green** (Node 22 at `/home/box/.local/node22/bin`).

## Repo rules

- Keep the runtime provider-independent. Decide-1 names no model, provider, adapter or tool protocol. P4a asks for nothing new through the gateway ports.
- Keep the gateway and the runtime pure where they are pure. `decideBand`, `decide1Inputs`, `planFor`, `bandOfChoice`, `dispatchDecided` and `transitionDispatch` perform no I/O. The only effects remain P3a's injected `generate`, `evaluate`, `dispatch`, journal and Weft ports.
- No ambient clock: time comes only from `now()` (P3a). No ambient entropy: record ids derive from the decision id and entry. No `process.env`.
- Keys stay off argv and out of logs. Records hold no thrown error, provider text or credential-shaped id. Run `correlation()` on every id and every string fact value.
- Never weaken a check. Do not touch `ALLOWED` / `TEST_EXTRA`, frozen digests, holdout sets, `SITE_POLICY`, the Weft validator, or P3a assertions beyond the deliberate `@1` → `@2` key-set move and D-P4a-10.
- New terms go in `GLOSSARY.md`: **Decide-1** (rule table over isolated judgments and code facts whose output is the coarse band). Use **Decide-1 trace**, **Dispatch authority**, **Dispatch intent**, **hint** and **original** as already defined.

## Decisions taken in this brief (D-ENG-021: architecture and code health)

- **D-P4a-1, the spine first, at parity.** P4a moves P3a's outcome table into `decide1.rules@1` with no behaviour change. New isolated judgments (P4b) and Decide-2 (P4c) then add rows and inputs to one decision path, and each later behaviour change is a reviewable row diff with a parity baseline behind it. Shipping new judgments in the same PR would mix a refactor with unmeasured thresholds (§3 "Gauge before lock").
- **D-P4a-2, `decide1.ts` is generic and pure.** It knows bands, judgments, facts and rows, but not checkpoints, sites or the gateway. `dispatch.ts` adapts the checkpoint into inputs and maps rule ids to plans with an exhaustive switch. Decide-1 is policy, not a judgment site, so it lives beside `dispatch.ts`, not in `sites/`.
- **D-P4a-3, P4a owns the Loom emission of `dispatch.decided`.** Its required trace fields only have honest values once a rule table exists. Emitting a placeholder trace first and replacing it later would put two meanings under one kind.
- **D-P4a-4, a pause's band is the band it withheld.** P3b closed `band` to four values (D-ENG-045) and requires it on every record, including pauses. Widening the vocabulary would re-open a locked fork. `bandOfChoice` makes a pause's band the deterministic band of the stage choice that `transitionSite` already records as `choice`, and `status` says it did not happen. Gauge counts by `(band, status)`, never band alone.
- **D-P4a-5, trace in the journal, record bumped to `@2`.** Weft is a non-authoritative projection, so evidence for a consequential decision has to live in the journal. `@2` adds `rule_table` and `decide1`. There is no `@1` reader or compatibility shim: no production ingress journals exist before P3c. Replay refuses a foreign table version.
- **D-P4a-6, thread routing, done check and decline are `tool_call`.** They are deterministic acts without generation (§3 Stay-in-S1). Decide-2 (P4c) runs only when the intent kind does not already fix the action. Today that is only D1 `capability`.
- **D-P4a-7, D-ENG-044 is enforced by unrepresentability.** P4a has no spawn row, and `planFor` throws on `spawn_subtasks`. P5 adds the sealed-parent-frame intent before any spawn row can exist.
- **D-P4a-8, no new check script.** Table totality, no-spawn and the D-ENG-030 domain property are behavioural, so tests 1–3 pin them. P4c adds the D3-out-of-prompt check, because that one is a source-shape property.
- **D-P4a-9, no new inference and no policy change.** τ values come from P6. `SITE_POLICY` and `BOOLEAN_SITE_POLICY` stay frozen. Test 14 pins benchmark-route non-leak.
- **D-P4a-10, the one parity exception.** P3a's defensive `needs_human` / `invalid_answer` returns are for stage shapes `transitionSite` and `trustedTransition` cannot produce, so they only fire on a corrupted journal or a code defect. Asking a human about a code defect is not a D-ENG-030 ask. P4a throws before `claim` instead, the same as P3a's impossible-stage-set rule. Test 2 proves no `transitionSite` output reaches them. P3a assertions that pin those returns (if any) move to `assert.throws`. That is the only P3a expectation P4a changes besides the record key set.

## Cases

- **Failure:** if parity cannot hold without editing `packages/weft/**`, `packages/gateway/**`, benchmark files, `SITE_POLICY`, or P3a assertions other than the record key set and D-P4a-10's guard cases, stop and report the blocker in the PR body. If merged P3a differs materially from its brief (outcome table, record shape), re-derive the rows from the merged code, keep parity, and list every difference in the PR body.
- **Cancellation:** leave a clean tree. Do not land CONTRACT or GLOSSARY text without the code it describes.
- **Concurrency:** only this worktree edits the P4a targets. P3c (reference port) may run in parallel but must not edit `decide1.ts` or the `planFor` mapping, and must not wire `loop.preselect` into any prompt.

## Done

1. Red → green for tests 1–14, with `npm run verify` green.
2. Commit: `feat(loom): Decide-1 rule table feeds dispatch decisions and dispatch.decided (WV-S1 P4a)`. The body lists D-P4a-1…10, names the merged P3a commit and P3b `d92e6c5`, includes the rule table, and states that no Weft, gateway, benchmark, `SITE_POLICY` or VISION file changed.
3. Do not push. The captain pushes and opens a draft PR.

## Open questions (owner)

Neither question blocks P4a.

1. **(blocks P4b) May new isolated Decide-1 judgments change the band before Gauge fits their thresholds?** `clarify`, `multi_deliverable`, `reads_before_gen` and `veto_bare_gen` have only CF-sim floors (≈ .35, "not product locks", §3). Gating on them under dispatch authority would move live routing on sim numbers. Running them in shadow (asked, recorded in the trace, read by no row) costs up to four decision-tier asks per decision while P6 collects labelled tune evidence. **Recommendation:** shadow for all four until P6 fits τ on the tune split. If the owner wants one live, make it `clarify` → `ask_human` only, because an extra ask is the reversible failure.
2. **(blocks P4c) When Decide-2 cannot pick one tool with margin on reversible work, what happens?** D-ENG-030 rules out asking for low confidence on reversible work. The alternatives are (a) `escalate_gen` with the **full** disclosed M6 index, with no narrowing, so the generator picks a tool again (model-at-centre on that path, but bounded), or (b) a `decline`-style stop that reports "no confident tool". **Recommendation:** (a), recorded as its own rule (`gen.no_tool_margin`) so Gauge measures how often it fires, with an irreversible top candidate still asking.

Learning notes: durable journals survive crash and replay without duplicating or losing state. The Decide-1 trace is a pure function of the stored checkpoint and a versioned table, so it is stored in `dispatch.decision@2`, recomputed identically on replay, and replay refuses a foreign table version. Each appended entry gets its own `dispatch.decided`, and recorded or replayed decisions emit nothing. Single-use grants are never reused: rules output bands, not authority, intents still carry no grant, and a resume re-presents the same `dispatch_id`, never a grant. Guardrails and shuffles don't leak into benchmark routes: P4a adds no model question, D1/D2 requests stay byte-identical to P3a's, and `SITE_POLICY` and `benchmarks/**` are untouched. Repeated review findings become a lint or test: the stale-fallback trap, the low-confidence-never-asks rule and no-bare-spawn are domain-enumerating tests over the rule table, and D3-in-prompt becomes a check in P4c.
