# Replay and recover

A recorded Loom log is evidence that can be re-checked: `replay` re-runs the cycle over it without invoking the host or the decision layer and must reproduce it byte for byte, failing closed on a missing result or a tampered judgment; `recover` rebuilds a runtime from a durable journal and refuses one whose seqs are out of order.

## Sub-features

- `replay-trace` replaying the recorded trace (written to disk, read back) with a fresh host and a refusing decision layer returns `ok`, goal `complete`, identical observations and cycles, zero host invocations and rejections.
- `replay-journal` replaying the on-disk `FileJournal` of a run without rejected inputs does the same.
- `replay-missing-result` dropping the final `action.result` fails with `missing recorded action.result for <id>`, executes nothing, and does not complete.
- `replay-tampered-judgment` changing one recorded weight fails with `replay diverged from the record at seq <n>`, where `<n>` is the first runtime observation after the tampered weights (the first `action.started`).
- `recover-journal` `recover(journal)` with a fresh host yields goal `complete` and the same report, with zero host invocations.
- `recover-refuses-reorder` swapping two journal lines makes `recover` throw `... refusing to load it`.

## How to get to it (user POV)

- `replay(recordedObservations, { host, decisionLayer })` after a run, or on a log from another process.
- `recover(new FileJournal(path).snapshot(), { host, decisionLayer })` after a restart.

## Driving it with loom-verify

Preconditions:

- Baseline launched and doctor green; the drive first completes an `alpha`, `beta` goal with a `FileJournal` and no rejected inputs.

- **Replay.** Run `$H drive replay-recover`. `PASS replay: ...` twice.
- **Fail closed.** `PASS replay fails closed: ...` twice; `replay-failures.json` holds both failure objects.
- **Recover.** `PASS recover: ...` and `PASS recover fails closed: an out-of-order journal is refused`.
- **Proof.** `PASS replay-recover: 7/7 checks` with `recorded-trace.json` and `journal.jsonl` in `replay-recover/`.

## Gotchas

- Replay does not re-ask the decision layer: it takes the recorded `weights.recorded` as an observation and re-derives Loom's own decisions, so a tampered weight is reported at the first dependent runtime observation, not at the weight's own seq.
- Replay over a journal fails after a rejected input (the journal omits rejected observations; replay feeds by seq). Replay the trace; use the journal for `recover`. Whether journal replay should tolerate that gap is an open question for a human.
- Recovery mid-run (open invocations, reconciliation with a host that lost them) is not mapped; `m1.test.ts` and `h1.test.ts` cover it inside `$H test`.
