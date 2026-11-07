# WV-353 C1 evidence

Base: `2bff44304a4d15b3d3072a84634f2cce30c5c79c` (`origin/main` when C1
started). Branch: `wv-353-c1-context-budget-contract`. Reference:
`_plan/PLAN.md` is the unmodified blob `841d7f4:PLAN.md`. The pre-existing
`_plan/WV-353-owner-locks.md` is left outside this commit. No production TS,
gateway, Weft, benchmark, VISION, dependency or permission changes are included.

## Demonstrated red

```sh
npm run build
WV353_RED=1 node --test --test-isolation=none --test-reporter=tap \
  packages/weave/dist/test/context-budget.test.js \
  packages/weave/dist/test/context-budget-marker.test.js
```

Observed exit 1: **87 tests, 84 assertion failures, 3 evidence checks pass**.
Examples include `fits !== overflow` for T1's always-fit placeholder,
`true !== false` for T15's insufficient composition bound, missing typed
context_decision_id and unsupported input/coverage being admitted. All failures
are assertions; no missing imports, compilation failures or skips supply red.
An initial relative-import error was fixed before counting behavioral red.

The same check functions run uncaught in red mode and under assert.throws in
default mode. The default pass means only that known-invalid placeholders were
killed. There is no conforming assembler, validator, persistence adapter or
replay implementation behind these tests. No C2 behavioral green is claimed.
The pure Probe seam injects synthetic complete-input bounds, not provider token
estimates. Actual fixture adapter projections use TypeSafe's wire profile and
OpenRouter's OpenAI-compatible transport with injected fetch; no HTTP occurs.

The additional pin-negative direct red run is reproducible with:

```sh
WV353_RED=1 node --test --test-isolation=none --test-reporter=tap \
  packages/weave/dist/test/context-budget-pins.test.js
```

Its deliberately invalid property-only call and JSDoc declaration fixtures fail
assertions. All default negative fixtures check rejection, including wrong
callee, partial range, wrapped prose/table pins, missing paths/symbols in closed
history, open/future property pins, deleted/substituted/relocated W2 pins and
exact test-title declarations. TypeScript 7's bundled async AST API is used;
no dependency was added. Async git avoids this environment's spawnSync EPERM.

## Closed encoded maxima

Using the repository's payloadBytes/canonical JSON, the maximum marker is
789 bytes for goal.frame and 847 for frontier.weigh; the stopped action.result@2
maximum is 215. Tests pin every field and alphabet maximum, exact equality and
one-under configuration mutations independently. Envelope bytes do not count
against the payload bound. The clarification maximum remains a C2d-Q
prerequisite: C1 cannot enable preparation without it.

## Structural fixture measurement

After building, reproduce the test-only renderer observation with:

```sh
WV353_MEASURE=/tmp/wv353-shapes.jsonl node \
  --import ./packages/weave/test/fixtures/context-budget/measure.mjs \
  --test 'packages/weave/dist/test/*.test.js' \
  'benchmarks/frontier-weigh/test/*.test.ts'
```

Use an empty destination for each run. The loader wraps functions in memory;
no runtime file is edited. It records site, root-zero depth, value-node count
and fixture callsite, with no body content. New C1 tests call none of these
renderers, so adding them does not expand these maxima.

| Site           | Calls observed at base | Depth maximum | Node maximum | Source of node maximum                                                                 | Limits    |
| -------------- | ---------------------- | ------------- | ------------ | -------------------------------------------------------------------------------------- | --------- |
| goal.frame     | 120                    | 6             | 102          | p6.test.ts: D3 consumes the budgeted M6 index rather than the registry or schema slice | 32 / 4096 |
| frontier.weigh | 354                    | 6             | 96           | buildCase, checked-in case fw-h02                                                      | 32 / 4096 |
| audit.generate | 225                    | 5             | 3032         | audit-view.test.ts: audit text caps retain many items and only mark authorized fields  | 32 / 8192 |

Limits apply max(floor, nextPowerOfTwo(2 × maximum)) independently. The probe
run had 44/45 test files pass; the existing task-acceptance command tests failed.
This is observed fixture coverage, not a structural bound on future states,
provider/window safety, an exhaustive fixture-consequence inventory, or P1
approval. Audit limits are C4 specification only.

## Document checks and unresolved reference diagnostics

```sh
node --test --test-isolation=none --test-reporter=tap \
  packages/weave/dist/test/context-budget*.test.js
```

Observed **132 tests: 131 pass, one fails**. The failure is the real
FU3 definition/navigation check over the immutable parent plan. No check is
weakened or plan reference rewritten to hide it. The 12 active labelled-call
pins, their exact multiset, both W2 scope-presence checks, all 22 contract
exported-symbol references, negative fixtures and FU5 document checks pass.
FU5 checks are specification coverage, not runtime replay witnesses.

The failing parent-reference check reports ambiguous basename paths
`digest.ts`, `stable-json.ts`, `run.ts`, `journal.ts`, `types.ts`, unmatched
grouped citations, current-base declaration drift for buildRequest and the
Runtime.appendStep use-site citation, and p8's exact test titles pinned to
1096/1903 (now 1106/1913). The 1903 pin names syncBuiltinESMExports at C1's
base. Comments/JSDoc/body statements cannot substitute for declarations.
The plan requires unique basename resolution against git ls-files and permits
no parent rewrite in C1. Closed review sections 14–28 get path/symbol-only
checks; section 29 and future sections get full AST shape checks. Fenced
headings never create a history exemption.

## Available-suite verification

- `npm run build`: pass. The concatenated TypeScript contract fences also
  pass a standalone strict no-emit check with the installed compiler.
- Explicit changed-file `vp fmt --check`: pass.
- `git diff --check`: pass.
- `npm run check`: pass, including benchmark-digests, import direction and
  ambient clock/entropy/environment/failure checks.
- `npm run test:jev`: 9/9 test files pass.
- `npm run test:frontier-weigh`: 1/1 test file passes.
- `npm run test:decision-sites`: 12/13 files pass; existing cli.test.ts fails.
- `npm run test:checks`: 2/3 files pass; existing checks.test.mjs fails.
- `npm test`: 104/112 files pass; the new parent-pin diagnostic test fails,
  plus seven unchanged files: AgentFabric cli-generate/shell-run, gateway
  amos/vercel-ai-gateway, Loom task-acceptance, Weft otel-isolation/sqlite-intake.
  Focused uncaught runs show loopback listen EPERM, spawnSync EPERM, empty
  process output and resulting JSON/listener assertions. These failures are
  recorded separately from C1's expected red; no permission was relaxed.
- `npm run fmt:check` and `npm run verify`: exit 1 on the immutable
  `_plan/PLAN.md` formatting. Verify stops at that gate; downstream stages are
  not claimed run by verify. The independently executed stages are listed above.

No live benchmark, hosted model call or remote issue/review verification was
performed. D-ENG locks are applied from the brief; external owner/review records
are not newly authenticated here. C2a/C2b/C2c/C2d and clarification integration
remain unimplemented and unauthorized by this C1 commit. No merge claim.
