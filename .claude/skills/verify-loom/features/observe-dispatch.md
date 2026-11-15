# Observe and dispatch

A caller feeds observations into a Loom `Runtime` and opens a goal; Loom forms candidates, records the scripted weights as a judgment observation, dispatches independent inspections together under grants, assembles the report only after every inspection, and completes the goal with evidence, while a malformed observation is kept in the log but changes nothing.

## Sub-features

- `observe-reject` a malformed `source.changed` (no revision) is rejected, retained in the trace, and causes no transition.
- `cycle-candidates` goal.opened leaves the goal `active`; cycle 1 runs `inspect_and_report@1` with one allowed `source.inspect` per source and no `report.assemble`.
- `weights-observation` the cycle's weights are a `weights.recorded` observation, source kind `judgment`, implementation `scripted@1`.
- `parallel-dispatch` both inspections start in cycle 1, each with a `source.inspect` grant, and are open on the host at the same time.
- `assemble-complete` after both results, `report.assemble` runs; the goal is `complete`; the host ran inspect, inspect, assemble.
- `report-evidence` report entries carry revision 1, line counts 3 and 5, and digests equal to `sha256(content)[0:16]`; the report carries evidence seqs.
- `trace-complete` `traceCompletenessViolations(trace)` is empty.
- `journal-durable` the `FileJournal` on disk equals the accepted observations and holds no rejected one.

## How to get to it (user POV)

- Construct `new Runtime({ host, decisionLayer: new ScriptedDecisionLayer(), grantAuthority, journal: new FileJournal(path) })`.
- `runtime.observe({ payload_type: 'source.registered', ... })` per source, then `runtime.operator.submit({ payload_type: 'goal.opened', payload: goal })`.
- Release host invocations and `await runtime.settle(action_id)`; read `runtime.state()` and `runtime.trace()`.

## Driving it with loom-verify

Preconditions:

- Baseline launched and doctor green; goal `g-loom-verify` over `alpha`, `beta` with read authority on both, budget `{ actions: 6, judgments: 6 }`.

- **Reject.** Observe `source.changed` for alpha without `revision`. Run `$H drive observe-dispatch`. `PASS observe-reject: ...` three times; `result.json` shows reason `source requires a positive integer revision` and an unchanged `state_revision`.
- **Open and weigh.** The drive opens the goal. `PASS cycle: ...` and `PASS weights: ...`; `trace.json` cycle 1 has two candidates with weight `0.8`.
- **Dispatch.** `PASS dispatch: both inspections start in cycle 1 under a grant, concurrently` with `open_on_host: 2` before any release.
- **Complete.** `PASS complete: ...`, `PASS report: ...` twice; `state.json` has `goal.status: "complete"` and the two report entries.
- **Journal.** `PASS journal: ...`; `journal.jsonl` in the evidence dir is the on-disk journal copied after the run.
- **Proof.** The summary line `PASS observe-dispatch: 14/14 checks`, plus `observe-dispatch/{result,trace,state,host-invocations}.json` and `journal.jsonl`.

## Gotchas

- Cycle 2 is `waiting` (one inspection still running) and cycle 4 is `complete`; do not assert a fixed cycle count beyond what a test pins.
- The journal holds accepted observations only. After a rejected input its seqs have a gap, so `replay` over the journal diverges at the rejected seq (recorded as `info_replay_over_journal_after_a_rejected_input` in `result.json`); feed `replay` the trace. See replay-recover for the question this raises.
- `FileJournal` appends. The helper deletes its scratch journal before each drive; a hand-written driver that reuses a path will trip `recover`'s seq check.
- Source handles are `ref_<n>` in registration order on that host; never hard-code handles across hosts.
