---
name: verify-weave-index
description: >-
  Before verifying a weave change or approving its PR, to choose which
  verify-<pkg> skills to run from the files the change touches. Use after
  running `git diff --name-only origin/main...HEAD`, or when you are unsure
  whether to run verify-loom, verify-weft, verify-gauge, or verify-tapestry.
---

# Choose weave verification skills by touched packages

Agents pick package skills from the change's paths. This index only selects skills. It does not replace them.

## Always first

Run **`npm run verify` from the repo root first**, and record the result per package. Do this before any package-specific skill, including when the path set is empty or unmatched. Then follow the Monorepo baseline in the selected skills (clean SHA, Node 26, `npm ci`, every `checks/` script, CI green on the same SHA). The Fleet skill at `/home/box/agent-data/workflows/verify-weave/SKILL.md` is the same gate.

## Select skills

From the repo root:

```bash
git diff --name-only origin/main...HEAD
```

Use the merge-base form (`...`), not a two-dot range. If you are not on a branch with `origin/main` as upstream, replace `origin/main` with the PR base. Working-tree edits not yet committed are added with `git diff --name-only` and `git ls-files --others --exclude-standard`.

Then:

1. If any path matches a **shared / root** glob below, select **all** package skills: `verify-loom`, `verify-weft`, `verify-gauge`, `verify-tapestry`.
2. Otherwise, select **every** package skill whose globs match at least one path (the union; never just the first hit).
3. If nothing matches, still keep the monorepo verify result, and report that no package skill applied. Do not invent a surface.

Run each selected skill's Launch / Doctor / Drive / Evidence / Cleanup for the features the change can affect. A gap in any selected skill is a failure.

## Shared / root — triggers all

These paths are repo-wide or are libraries several packages depend on and that have no `verify-*` skill of their own:

| Glob                                                                                        | Why                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `package.json`, `package-lock.json`                                                         | Root manifests and lockfile                             |
| `tsconfig.json`, `tsconfig.base.json`, `tsconfig.examples.json`, `tsconfig.benchmarks.json` | Shared TypeScript config                                |
| `checks/**`                                                                                 | Monorepo static checks                                  |
| `scripts/**`                                                                                | Shared verify/cache/benchmark scripts                   |
| `.github/**`                                                                                | CI that gates the same SHA                              |
| `packages/agentsop/**`                                                                      | Shared contract layer (Loom and Fabric depend on it)    |
| `packages/agentfabric/**`                                                                   | Shared capability host (Loom examples and tests use it) |
| `packages/gateway/**`                                                                       | Shared inference gateway                                |
| `packages/auth-chatgpt/**`                                                                  | Shared auth helper used by examples                     |

## Package skills

Loom is `packages/weave` (there is no `packages/loom`). `packages/loom-binding` is a Tapestry view adapter, not Loom.

| Skill                                          | Path globs                                                                      | Helper                                                   | What it proves                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [verify-loom](../verify-loom/SKILL.md)         | `packages/weave/**`, `examples/crystallize.ts`, `benchmarks/task-acceptance/**` | `.claude/skills/verify-loom/bin/loom-verify.mjs`         | Runtime: observe/dispatch, policy refusal, crystallize (offline), replay/recover, task-acceptance offline |
| [verify-weft](../verify-weft/SKILL.md)         | `packages/weft/**`                                                              | `.claude/skills/verify-weft/bin/weft-verify.mjs`         | Trace contract, sink, weave.trace@1 import, OTel round-trip, OTLP intake                                  |
| [verify-gauge](../verify-gauge/SKILL.md)       | `packages/gauge/**`, `benchmarks/failure-attribution/**`                        | `.claude/skills/verify-gauge/bin/gauge-verify.mjs`       | Evaluation records, evaluate/compare/track, info-only, offline failure-attribution                        |
| [verify-tapestry](../verify-tapestry/SKILL.md) | `packages/tapestry/**`, `packages/tapestry-web/**`, `packages/loom-binding/**`  | `.claude/skills/verify-tapestry/bin/tapestry-verify.mjs` | Tapestry web workspace UI (Chrome/CDP)                                                                    |

Consumer note, not a shared/root trigger: a change to Weft's public contract (`packages/weft/src/WEFT-CONTRACT.md`, `packages/weft/src/types.ts`, `packages/weft/src/index.ts`) should also run `verify-gauge`, because Gauge depends on that contract.

## After selection

Point at `/pstack:maintain-verification-skill` to keep a map honest as a package changes. This index needs a matching update when a new `verify-*` skill is added, or when a package is renamed (including the planned `packages/weave` → Loom rename).
