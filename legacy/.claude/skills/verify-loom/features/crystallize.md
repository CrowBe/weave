# Crystallize a capability offline

`npm run example:crystallize` fills a capability gap without a model: Loom searches for an admitted capability, records the gap, fixes a contract and a split corpus, demonstrates red under isolation, takes two scripted implementations, proves them green on visible and held-out cases, waits for an operator admission, then runs the admitted `report.fold` under a separate execution grant to finish the report, and finally replays the trace without the author, lifecycle or host.

## Sub-features

- `cli-run` `npm run example:crystallize` exits 0 (it runs the whole-repo `npm run build` first).
- `offline` the same entry point under `bin/net-guard.mjs` exits 0 with zero network attempts and identical stdout (deterministic).
- `gap-search` `gap.search gap`, reason `no admitted capability or composition produces the desired output`; procedure `crystallize_and_report@1`.
- `corpus-split` only visible ids (`vis-pair, vis-empty, vis-bad`) are printed; held-out ids stay with the lifecycle.
- `red-isolation` red demonstrated under an isolation report (sha256); probe `filesystem blocked, child_process blocked, credentials absent, fetch undefined`.
- `green` two implementations (`aliased, direct`), each `visible n passed/0 failed; held-out m passed/0 failed`.
- `admission` one implementation `admitted ... by operator`, bound to a sha256 evidence digest.
- `separate-grant` `report.fold@r1 permissions []`, `host invocation true`; fold equals `fold|ref_1=<d(alpha)>|ref_2=<d(beta)>` recomputed from the source text.
- `complete` report covers `ref_1 rev 1, ref_2 rev 1`; goal `complete`; held-out text never in an author view; execute runs > 0.
- `replay` `complete fold true host invocations 0`.
- `no-side-effects` `git status --porcelain` unchanged.

## How to get to it (user POV)

- From the repo root: `npm run example:crystallize` (= `npm run build && node --experimental-strip-types examples/crystallize.ts`).

## Driving it with loom-verify

Preconditions:

- Baseline launched and doctor green. No `.env.local` is needed or read by this script.

- **User command.** Run `$H drive crystallize`. It runs `npm run example:crystallize`; `PASS npm run example:crystallize exits 0`; `crystallize/npm-run.stdout.txt` is the verbatim output.
- **Observed offline.** It reruns `node --import <net-guard> --experimental-strip-types examples/crystallize.ts`; `PASS guarded run exits 0`, `PASS offline: ...`, `PASS deterministic: ...`; `guarded.net-attempts.json` is `[]`.
- **Every stage.** One `PASS` per printed stage (search, corpus, red, probe, implementations, green, admission, evidence, fold, grant, host invocation, report, goal, held-out, execute runs, replay).
- **Side effects.** `PASS side effects: git working tree unchanged ...`.
- **Proof.** `PASS crystallize: 23/23 checks`; `result.json` records `m3_milestone_satisfied: false` and why.

## Gotchas

- **Not M3.** The example predates `docs/m3-fill-a-capability-gap.md` and adds a procedure arm; a green run does not satisfy that milestone. M3 lives in `packages/weave/test/m3.test.ts` (`$H test`).
- The npm script rebuilds every package's `dist`; do not run it while another agent edits or builds the checkout.
- The net guard covers only the example's own process. The isolate worker is spawned with an explicit argv and does not inherit `--import`; its isolation probe line is the evidence for the child.
- Digests in `red` and `admission` are deterministic today but are checked only for shape; do not pin their values.
