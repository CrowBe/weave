---
name: verify-loom
description: Build and drive Weave Loom (the goal-directed runtime; package `packages/weave`, npm `@weave/weave`, there is no `packages/loom`) through its public Runtime API — `Runtime`, `ScriptedDecisionLayer`, `FileJournal`, `replay`, `recover`, `traceCompletenessViolations` — over the enforcing AgentFabric host with in-memory sources, plus its offline entry points `npm run example:crystallize` and `npm run task-acceptance:offline`, with a scripted Node helper that records per-check evidence. Use this to prove a change to packages/weave (observation intake, cycles and weighing, dispatch under grants, policy refusal, budgets, journals, replay/recover, crystallization, task acceptance) actually behaves, alongside the monorepo verify gate. Loom has no CLI bin and no UI; everything is offline with scripted decision layers. Do not use this for packages/loom-binding or the Tapestry web UI (use verify-tapestry), Weft (verify-weft), Gauge (verify-gauge), or anything that needs a hosted provider.
---

# Verify Weave Loom (`@weave/weave`)

Loom is the goal-directed runtime (`GLOSSARY.md` → Loom): it owns state transitions, scheduling, policy enforcement, evidence capture and the action loop. **The package is `packages/weave` until a later rename**; its npm name is `@weave/weave`. There is no `packages/loom`. `packages/loom-binding` is **not** Loom: it projects recorded runtime state into a Tapestry workspace view and belongs with `verify-tapestry`.

What a user (a composition root, an example, a benchmark) touches is the **public library API**, `@weave/weave` → `packages/weave/dist/src/index.js`:

| Export                                          | What it does                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `new Runtime({ host, decisionLayer, ... })`     | the action loop; `observe`, `operator.submit`, `clock.submit`, `settle`, `state()`, `trace()`, `admitCapability` |
| `ScriptedDecisionLayer`                         | offline `frontier.weigh` (weights `0.8`, implementation `scripted@1`); no model                                  |
| `FileJournal`, `MemoryJournal`                  | durable observation log (JSONL / memory); holds accepted observations only                                       |
| `replay(observations, options)`                 | re-runs the cycle over a recorded log without invoking host or decision layer; fails closed                      |
| `recover(journal, options)`                     | rebuilds a runtime from a journal and reconciles; refuses an out-of-order journal                                |
| `traceCompletenessViolations(trace)`            | M0-C3: every `action.started` is explained by exactly one cycle record                                           |
| `ScriptedFoldAuthor`, `RETAINED_FOLD_PROCEDURE` | offline crystallization author used by `examples/crystallize.ts`                                                 |

The host is `AgentFabricHost` from `@weave/agentfabric` with a `createGrantAuthority()` from `@weave/agentsop`, sources registered in memory with `host.registerSource`; the runtime takes it as its capability host. `GatewayDecisionLayer` / `fixtureGateway` exist but are not driven here; the hosted examples (`example:gateway`, `example:free`, `example:weigh`, `example:preselect`, `example:muse-spark`, `example:vercel-free`, `example:nous-portal`, `example:chatgpt-*`, `task-acceptance:live`, `bench:*:live`) need API keys or sign-in and are **out of scope**: never run them for this proof and never fake a credential.

There is no bin, no server, no UI. "Launch" means build the package tree once; each drive is a short-lived Node process. Everything goes through one helper (Node built-ins plus the workspace packages):

```bash
H=.claude/skills/verify-loom/bin/loom-verify.mjs   # run from the repo root; it resolves paths from its own location
```

Requirements: Node >= 26 (type stripping for the `.ts` examples), `npm ci` already done so `node_modules/@weave/weave` links to `packages/weave`.

## Monorepo baseline (required before calling a change "done")

This skill proves Loom behaviour. It does not replace the monorepo gate. "Done" needs real proof: the behaviour exercised for real (a live command, a trace), not green tests alone. Before calling a change done or approving its PR, do all of this (the verify-weave workflow, `/home/box/agent-data/workflows/verify-weave/SKILL.md`):

1. Check out the exact head SHA under review in a **clean clone**. Use **Node 26** (`node -v` must print `v26.x`; switch with nvm/fnm if needed). The repo's engines are `>=26`, so a newer Node runs, but record the Node 26 requirement and the version you actually used. Run `npm ci`.
2. Run **`npm run verify` from the repo root FIRST**, before any package-specific proof, and record the result per package. Loom's parts of it are `npm run check`, `npm run test:checks`, `npm test` (includes `packages/weave/dist/test/**/*.test.js`), `npm run typecheck:examples`, `npm run task-acceptance:offline`, `npm run test:decision-sites`, `npm run test:frontier-weigh` and the example tests (`test:weigh-example`, `test:chatgpt-cli`, ...), which all import `@weave/weave`.
3. Run **every script under `checks/`**. List the directory first; don't assume names. Each must exit 0. `$H checks` does this and records each result. The checks that cover Loom directly:
   - `checks/import-direction.mjs` (M0-C1): weave imports agentsop, agentfabric and gateway only; weave tests may also import weft, weave source never does; agentfabric never imports weave; examples and benchmarks reach weave only through `@weave/weave`.
   - `checks/no-ambient-clock.mjs` (M0-C2) and `checks/no-ambient-entropy.mjs`: no wall clock or random draw in `packages/weave/src`; time enters as `clock.tick`.
   - `checks/no-ambient-env.mjs`: no `process.env` in package source.
   - `checks/extract-before-site.mjs`: free-text decision sites in `packages/weave` pass an extract@1 origin.
   - `checks/no-swallowed-failures.mjs` scans scripts; `checks/gauge-attribution-contract.mjs` targets Gauge; `checks/source-scan.mjs` is a shared module (no-op when run). All must still pass.
   - `checks/test/*.test.mjs` (`npm run test:checks`): red/green fixtures for the checks above, credential parity, execution provider, g7 lint (runs `npm run build`).
4. Package-specific runtime evidence: this skill's Launch → Doctor → Drive (every feature the change touches, from `features/`) → Evidence → Cleanup, plus `$H test`.
5. Confirm CI on the PR is green for the **same SHA**. A new commit voids this verification.
6. Report: SHA, Node version, `npm run verify` result, each `checks/` script result, and the runtime-proof evidence (paths under `.local/verify-loom/<RUN>/`). Any gap is a failure and goes back as a gap, not a pass.

To choose which package skills a change needs, follow `.claude/skills/verify-weave-index/SKILL.md`.

## Launch

```bash
$H launch                      # or: $H launch --run my-run-id
export LOOM_VERIFY_RUN=<RUN printed on the first line>
```

Launch prints `RUN=<id>` first, then builds with `npx tsc -b packages/weave/tsconfig.json` (that builds `agentsop`, `agentfabric`, `gateway`, `weft` and `weave` `dist/`, nothing else; transcript in `build.log`), creates an **empty** scratch dir `$TMPDIR/loom-verify/<RUN>/` and the evidence dir `.local/verify-loom/<RUN>/`, writes `state.json` (scratch) and `run.json` (evidence) with the HEAD SHA, dirty flag and Node version, and ends with:

```
READY: packages/weave built; run doctor next.
```

Ready means the built package is importable; Doctor proves it. Launch refuses an existing run id. There is no database, migration or seed step: each drive seeds its own in-memory sources (`alpha` 3 lines, `beta` 5 lines, `gamma` 1 line, the M0 fixture text) and its own journal file in scratch. Teardown is `$H cleanup`; there is no long-lived process.

## Doctor

```bash
$H doctor        # read-only; exit 0 = worth driving, exit 1 = something is off
```

Prints JSON `{ run, ok, checks: [{ name, ok, detail }] }` and saves `doctor-<ms>.json` in the evidence dir. It checks: run state and evidence dir exist; Node satisfies `>=26` (and reports `is_v26`, which the baseline requires you to record); HEAD equals the SHA at launch; `packages/weave/dist/src/index.js` exists; `agentsop`, `agentfabric`, `gateway`, `weft`, `weave` `dist` are not older than their `src`/`test` (stale build); `@weave/weave` resolves into **this** checkout's `packages/weave`; `Runtime`, `ScriptedDecisionLayer`, `replay`, `recover`, `FileJournal`, `MemoryJournal`, `traceCompletenessViolations`, `stableStringify` are functions; `examples/crystallize.ts` and `benchmarks/task-acceptance/frozen-set.json` exist. Run it first, and again whenever anything looks off. A stale-dist or HEAD failure means someone edited after launch: start a new `launch`.

## Drive

```bash
$H drive <feature>    # observe-dispatch | policy-refusal | replay-recover | crystallize | task-acceptance-offline
$H test               # the packages/weave slice of `npm test`, transcript into evidence
$H checks             # every checks/*.mjs plus node --test checks/test/*.test.mjs
```

Each `drive` prints one `PASS`/`FAIL <check>` line per check, then `PASS|FAIL <feature>: n/m checks; evidence .local/verify-loom/<RUN>/<feature>/`, and exits 0 only if every check passed. Recipes, what each check means and gotchas are in [`features/README.md`](features/README.md). Drive every feature the change touches:

| Change touches                                                                      | Drive                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `runtime.ts` (cycle, intake, budget, completion), `validation.ts`, `state.ts`       | `observe-dispatch`, `policy-refusal`, `replay-recover` |
| `dispatch.ts`, `scheduler.ts`, grants, eligibility, authority                       | `observe-dispatch`, `policy-refusal`                   |
| `journal.ts`, replay, recover, `stable-json.ts`, `digest.ts`                        | `replay-recover`                                       |
| `crystallize*.ts`, `fold-author.ts`, lifecycle/admission, `examples/crystallize.ts` | `crystallize`, `replay-recover`                        |
| `task-acceptance*.ts`, `benchmarks/task-acceptance/`                                | `task-acceptance-offline`                              |

The preferred end-to-end drive is **`crystallize`**: it runs `npm run example:crystallize` exactly as a user does (search, contract, corpus, demonstrated red under isolation, two implementations, proven green, operator admission, a separate execution grant, then replay), then reruns the same entry point under a network observer and checks every printed stage. **A green `crystallize` does not satisfy the M3 milestone**: the example predates `docs/m3-fill-a-capability-gap.md` and adds a procedure arm (the file header says so; `result.json` records `m3_milestone_satisfied: false`). M3 is covered by `packages/weave/test/m3.test.ts` inside `$H test`.

`$H test` runs `npx tsc -b packages/weave/tsconfig.json` then `node --test "packages/weave/dist/test/**/*.test.js"` (default concurrency, as `npm test` runs it) and writes `test-weave.log` and `package-test.json` (exit code, counts, failing test names). If tests fail it reruns each failing file alone **for diagnosis only** (`test-weave.isolated.<file>.log`); the result stays FAIL. History: at `ec5babd` the suite was load-sensitive (`M3-T01`, `M4-T01` and other text.normalize tests ended with `goal.status` `active`). The cause was the isolate worker enforcing its 100ms CPU budget with vm's wall-clock `timeout`, so a starved child failed the trusted probe; it now measures CPU time (see `packages/agentfabric/src/isolate-worker.ts`). A failure under load is now a real regression. Report it as a failure, with the isolated reruns as diagnosis; do not rerun until green.

`$H checks` lists `checks/` and runs each script plus the `checks/test` suite, one log per script, `checks/summary.json`.

## Evidence

Evidence lives in **`.local/verify-loom/<RUN>/`** at the repo root. `.local/` is git-ignored, and cleanup never deletes it.

```
run.json                                SHA, dirty flag, Node, launch time
build.log                               launch build transcript and exit code
doctor-<ms>.json                        each doctor verdict
<feature>/result.json                   per-check { name, ok, expected, actual }, SHA, Node, time, notes
observe-dispatch/trace.json, state.json, journal.jsonl, host-invocations.json
policy-refusal/trace.json, host-rejections.json, no-judgment-budget.trace.json
replay-recover/recorded-trace.json, journal.jsonl, replay-failures.json
crystallize/npm-run.{stdout,stderr}.txt, npm-run.json        the user command, verbatim
crystallize/guarded.{stdout,stderr}.txt, guarded.json, guarded.net-attempts.json
task-acceptance-offline/report.json, offline.*, live-test.*  (stdout, stderr, net attempts)
test-weave.log, package-test.json, test-weave.isolated.*.log
checks/<script>.log, checks/checks-test.log, checks/summary.json
cleanup.json                            what cleanup removed and every evidence file it left
```

Proof standards for this package:

- Exercise the public entry point `@weave/weave` (and the real `AgentFabricHost`), or the repo's own npm scripts. Never import `packages/weave/src` internals or the test-only `FakeHost` / `test/fixture.ts`.
- Capture the action and the resulting state: every check records expected and actual. Expected values come from the contract docs, the package's own pinned tests, or independent recomputation (the inspect digest is `sha256(content)` hex, first 16 chars, recomputed with `node:crypto`; the crystallize fold is recomputed from the source text), never from re-running the producer under test.
- Second view: the journal is re-read from disk and compared with the trace; the recorded trace is written to scratch, re-read, and replayed by a fresh host that must record zero invocations; `recover` rebuilds from the on-disk journal.
- Fail-closed paths, not just happy ones: malformed observation rejected without a transition; an unauthorised source prohibited, never weighed, never started, goal blocked with the reason; the host refuses ungranted invocations (`DENIED`); no judgment budget means no dispatch; replay refuses a truncated or tampered log; recover refuses an out-of-order journal.
- Offline is observed, not assumed: `crystallize` and `task-acceptance-offline` run under `bin/net-guard.mjs` (`node --import`), which records and refuses fetch, net/tls connect, http(s) and dns in that process, and `git status --porcelain` is compared before and after. The guard does not reach children spawned with an explicit argv (the AgentFabric isolate worker); the example's own isolation probe (`fetch undefined`, `filesystem blocked`, `child_process blocked`, `credentials absent`) covers those.
- Mocks only where a production boundary already isolates: the scripted decision layer and fold author stand in at the decision-layer and author ports, which are real Loom boundaries. No model, provider, network or credential anywhere; a change that needs a real provider call is out of this skill's scope and must be stated, not faked.
- Never edit product code, tests or fixtures to make a drive pass. A failure is a finding; record it.

## Cleanup

```bash
$H cleanup
ls .local/verify-loom/$LOOM_VERIFY_RUN     # evidence must still be there
```

Cleanup deletes only `$TMPDIR/loom-verify/<RUN>/` (state, journals, scratch traces, net logs) and refuses any other path. There are no processes to kill: every drive is a child that has exited. It writes `cleanup.json` with what it removed and every evidence file it left, prints `CLEAN: ...`, and exits non-zero if scratch survived or the evidence dir is missing or empty. Run it after every attempt, including failed ones.

## Isolation

Runs are isolated by run id: separate scratch and evidence dirs, in-memory sources and hosts, no ports. Two runs can go side by side. Shared state is the checkout's `packages/*/dist` (launch and `$H test` rebuild the weave tree; `npm run example:crystallize` and `checks/test/g7-lint.test.mjs` run the whole-repo `npm run build`). Do not launch while another agent is mid-edit or mid-build in the same checkout; Doctor's stale-dist and HEAD checks catch an edit after launch.

## Helpers

- `bin/loom-verify.mjs` (executable; `node` shebang): `launch [--run ID]`, `doctor`, `drive <feature>`, `test`, `checks`, `cleanup`. The run comes from `--run ID` or `LOOM_VERIFY_RUN`. Exit codes: 0 pass, 1 a check failed, 2 usage or missing-run error. Verification scaffolding, not product code; adding a feature means one function in its `DRIVES` table and one file under `features/`.
- `bin/net-guard.mjs`: the network observer preloaded by `crystallize` and `task-acceptance-offline` (`node --import file://.../net-guard.mjs`, log path in `LOOM_VERIFY_NET_LOG`). Not run directly.
- The root `npm run fmt:check` (first step of `npm run verify`) also formats `.claude/skills/`. After editing this skill, run `npx vp fmt .claude/skills/verify-loom`.

## Upkeep

Keep `features/` honest as Loom changes with `/pstack:maintain-verification-skill`. Not yet mapped (covered only by `$H test`): publication under approval (M1 `report.publish`, destinations, revocation), cancellation and execution slots, the gateway decision layer over `fixtureGateway`, compaction / context budget, log bounds (`TraceRetention`), workstreams, audit loop, decision sites and `extract`, spawn roles, M3 `text.normalize` composition and M4 reuse.
