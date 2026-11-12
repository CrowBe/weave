# Task acceptance offline

`npm run task-acceptance:offline` scores Loom's frozen acceptance-fact set (`benchmarks/task-acceptance/frozen-set.json`) from recorded fixtures with no gateway, fetch or Jev call, prints the report as JSON, and runs the live comparison's caller-level tests on their skip paths only.

## Sub-features

- `offline-score` `offline.ts` exits 0 with a JSON report and zero network attempts.
- `declared-policy` `scoring_rule task-acceptance.score@1`, `contract acceptance.line@2`, `thresholds_source declared_before_run`, `holdout_used_for_tuning false`, `live_comparison not_run`.
- `counts-agree` `counts.tasks`, `tune`, `holdout` and `disagreements` agree with the per-task rows and with the frozen set on disk.
- `live-skip-tests` `live.test.ts` exits 0 and its process makes no network attempt.
- `no-side-effects` `git status --porcelain` unchanged.

## How to get to it (user POV)

- From the repo root: `npm run task-acceptance:offline` (= `npm run build && node --experimental-strip-types benchmarks/task-acceptance/offline.ts && node --experimental-strip-types --test benchmarks/task-acceptance/live.test.ts`).

## Driving it with loom-verify

Preconditions:

- Baseline launched and doctor green (launch built the `packages/weave` tree, which is all `offline.ts` imports).

- **Score.** Run `$H drive task-acceptance-offline`. `PASS offline.ts exits 0`, `PASS offline.ts makes no network attempt`; `task-acceptance-offline/report.json` is the parsed report.
- **Policy and counts.** `PASS report: ...` four times.
- **Skip-path tests.** `PASS live.test.ts ...` twice; `live-test.stdout.txt` holds the TAP output.
- **Proof.** `PASS task-acceptance-offline: 9/9 checks`.

## Gotchas

- The drive runs the npm script's two node commands under the net guard, not `npm run task-acceptance:offline` itself (it skips the leading whole-repo build). `npm run verify` runs the real script; for a PR touching this path, run it too and keep its transcript.
- Disagreements with hand labels are printed and are a completed eval, not a failure (the file header says so). Drift between computed and stored attribution fails the process.
- The frozen set includes holdout tasks. Running the scorer is fine; tuning anything against its output is not (AGENTS.md: reserve held-out cases).
- `task-acceptance:live` calls the hosted Jev route and needs `TYPESAFE_API_KEY`. Out of scope; never run it from this skill.
