# Loom verification map

This directory is the maintained source for verifying the user-facing behaviour of Weave Loom (`packages/weave`, `@weave/weave`). Read the index before driving, then use the matching feature file as the recipe. "User" here means a composition root, example or benchmark calling the public Runtime API, or a person running the repo's offline npm scripts.

## Baseline preconditions

- `npm ci` done; Node >= 26 (record whether it is v26.x, which the monorepo baseline requires).
- `H=.claude/skills/verify-loom/bin/loom-verify.mjs`, run from the repo root.
- `$H launch` printed `RUN=<id>` and `READY: packages/weave built; run doctor next.`; `export LOOM_VERIFY_RUN=<id>`.
- `$H doctor` exits 0.
- Each drive builds its own world: a fresh `createGrantAuthority()`, a fresh enforcing `AgentFabricHost`, in-memory sources `mem:alpha` (3 lines), `mem:beta` (5 lines), `mem:gamma` (1 line), registered in that order so their handles are `ref_1`, `ref_2`, `ref_3`, a `ScriptedDecisionLayer`, and (where named) a `FileJournal` in `$TMPDIR/loom-verify/<RUN>/`.
- No provider, no network, no credential. Never drive an instance or journal this run did not create.

## Driving conventions

- Every drive starts from the baseline; drives do not share state, so any order works.
- Drive only through `@weave/weave` exports, `AgentFabricHost`, or the repo's npm scripts. Never import `src/` internals or the test-only `FakeHost`.
- Host invocations are held until released: the helper releases every open action id in sorted order and calls `runtime.settle(id)`, round by round, until none is open.
- Expected values come from contract docs, the package's pinned tests, or independent recomputation, never from re-running the producer.

## Proof and skip reporting

- Each drive writes `<feature>/result.json` with every check's expected and actual, plus the traces, journals, stdout and network-attempt logs it used.
- Library proof includes the recorded trace and a second view (journal re-read from disk, a replay by a fresh host, or a recover).
- CLI proof (`crystallize`, `task-acceptance-offline`) includes the command, stdout, stderr, exit code and the net-guard attempt log.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behaviour, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with loom-verify`, `Gotchas`.

## Features

- [Observe and dispatch](./observe-dispatch.md): observation intake and rejection, cycle candidates, weights as an observation, concurrent dispatch under grants, report completion, trace completeness, the durable journal.
- [Policy refusal](./policy-refusal.md): an unauthorised source is prohibited before weighing and blocks the goal honestly; the host refuses ungranted invocations; no judgment budget means no dispatch.
- [Replay and recover](./replay-recover.md): replay a recorded log without executing, fail closed on truncation and tampering, recover from a journal, refuse an out-of-order journal.
- [Crystallize a capability offline](./crystallize.md): `npm run example:crystallize` end to end (gap, red, green, admission, separate grant, replay), offline and deterministic. Preferred end-to-end drive. Not M3.
- [Task acceptance offline](./task-acceptance-offline.md): `npm run task-acceptance:offline` scores the frozen acceptance set from recorded fixtures with no provider.
