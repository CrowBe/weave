# WV-S1 CF sim — living fixtures (P0b)

Credential-free copy of the local CF Clairic/Clef sim harness (issue #381,
WV-S1-P0b). No runtime package changes; the summaries below are checked-in
evidence, not product locks.

## Layout

| path                                                             | what                                                                                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e10/tasks.json` + `e2e10/summary.json`                        | 10 tasks (T01–T10) through extract → fidelity → decide-1 → (decide-2 + args); per-task `NN_*.out.json`/`.req.json` artifacts under `e2e10/T*/` |
| `e2e10-retune/retune_summary.json` + `e2e10-retune/T*/`          | retuned re-runs of T04/T07/T09 (spawn-plan + child-brief + child decide-1 slices)                                                              |
| `coding-preflight/summary.json` (T11) + `summary_t12.json` (T12) | coding preflight: extract → fidelity → decide-1 → target-set decide (`edit                                                                     | read | forbid | skip`) → sequenced spawn (`depends_on`reads → one`escalate_gen`); per-task artifacts under `coding-preflight/T1*/` |
| `tasks/task1`…`task4`, `task2-child-*`                           | earlier single-task extract/decide request + output pairs; `task4` adds a fidelity pass                                                        |

## Recorded outcomes

- T01–T10: 7/9 decided `band_match` plus T09 incomplete (`summary.json`). Of the decided
  results, misses are T04 (expected `spawn_subtasks`, got `tool_call`) and T07 (expected
  `ask_human`, got `tool_call`). T09 recorded a `reprompt` fidelity gate and is now
  marked `incomplete: true` with no decide-1 band: the runner stops before decide-1
  when the fidelity gate rejects extraction hints, so the earlier recorded T09
  `escalate_gen` band was measured past a bypassed gate and has been removed from
  `summary.json`.
- e2e10-retune: T04 and T09 match after tuning; T07 still misses on the
  first tuned band and matches only after the v2 `conf_floor+clarify→ask`
  rule (`tuned_band_v2: ask_human` in `retune_summary.json`).
- T11/T12 coding preflight: `shape_match: true` in both summaries —
  target roles place the expected edits, forbid/skip the expected
  no-touch paths, and the plan sequences reads before one `escalate_gen`.
  `edit_ok` requires exact set equality with the expected edit set, so an
  extra edit target (e.g. ARCHITECTURE.md marked `edit`) fails.

## Self-tests (stdlib, no network)

```
# from the repo root
python3 wvops/s1-sim/coding-preflight/run_preflight.py --selftest
python3 wvops/s1-sim/coding-preflight/run_preflight_t12.py --selftest
python3 wvops/s1-sim/e2e10/run_e2e.py --selftest
```

The preflight self-tests show an extra edit target fails and the exact set
passes. The e2e self-test shows a `reprompt` fidelity gate is recorded as
`incomplete` without calling decide-1.

## Re-run

Runners shell out to a local `cf` binary; the checked-in `summary*.json`
files are the evidence if `cf` is unavailable.

```
# from the repo root
python3 wvops/s1-sim/e2e10/run_e2e.py
python3 wvops/s1-sim/coding-preflight/run_preflight.py
python3 wvops/s1-sim/coding-preflight/run_preflight_t12.py
```

- `CF_BIN` (default `cf`) selects the binary. `CF_NODE22_BIN`, if set,
  is prepended to `PATH` for the `cf` subprocess (the original harness
  hardcoded a local node22 path; it is now env-driven).
- The runners run `cf` with `cwd` set to their own directory
  (`e2e10/` or `coding-preflight/`). Run them from the repo root, not
  from inside `_s1-sim-src/` (that staging copy is not committed).
- No API keys are stored in this tree. `cf` authenticates by its own
  local config; nothing here is read by the runtime.

## Status / non-goals

Living fixtures only. §3 provisional floors and tune rules (confidence
floors, `reads_before_gen→spawn`, `conf_floor+clarify→ask`) are recorded
as notes in the summaries, not promoted to product locks, and no
`packages/**`, `VISION.md`, or site code was changed.
