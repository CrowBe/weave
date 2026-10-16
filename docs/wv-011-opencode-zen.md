# WV-011 phase 1 evidence

## Contract and scope

`@weave/gateway/opencode-zen` exposes the DeepSeek free profile only. The
free-model guard requires both the fixed exact allowlist and a fresh public
models-list result. Each call owns its list fetch and cancellation signal;
there is no shared positive cache. Only the generation POST carries the copied
Bearer credential. No environment, filesystem, shell or clock is read by the
adapter. SDK generation uses `maxRetries: 0`.

Guard failures, generation 404, 429, 5xx and network failures return
`unavailable`, `retryable: false`, without a retry delay. Authentication failures
remain `unauthorized`; malformed completions remain `malformed_response`.
Timeouts and cancellation preserve their closed failure codes. Failure evidence
uses fixed descriptions; successful text and response ids redact the copied key.

Generation escalates through eligible units and blocks `provider_unavailable`
when all have refused as unavailable, including completion exactly at the attempt
cap. Destination permissions, cancellation, deadline, budget and attempt limits
still apply. A fresh routing decision cannot grant another attempt at the cap.
Evaluation behavior, grants and durable journals are unchanged.

Zen's [documented policy](https://opencode.ai/docs/zen/) and public models-list
facts were supplied by Weave Bench on 16 October 2026. No live calls were made
in this sandbox. Free availability is limited-time; rate limits are unknown and
floating. The sample route's price zero means the documented free tier. Its
128,000-token context limit is a local conservative routing bound, not verified
provider capacity. The example has a smaller local context bound and an 8,192
output-token budget to leave room for reasoning tokens.

The destination `opencode-zen.deepseek-free` requires explicit caller permission
and stays NOT training-allowed after #167. Generic route parsing remains
provider independent; it does not import this SDK-backed profile. Exact model
validation happens before any network operation at the adapter boundary.

Phase 2 (Zen Muse contributor, Responses API, training admission) awaits #167.
Phase 3 (P10 competitors) awaits #160. No benchmark, privacy, deadline-signal,
token-rate-limit, D4/D7 or runtime changes from those phases were copied.

## Demonstrated red, then green

Tests were written before candidate implementation. Two known-invalid provider
stubs exercised the contract: an always-failed `invalid_request` stub and a
permissive always-completed stub. Initial provider run: 46 tests, 8 passed,
38 failed. Permissive mutation: 46 tests, 2 passed, 44 failed. Both built cleanly.
The table records assertion output as expected/actual, not just test-loader
failures. Green is the real SDK adapter over injected mocked fetches.

| Behavior / test name | Observed red assertion | Green |
| --- | --- | --- |
| `gets the public live list without a key then posts exactly one authenticated SDK completion` | expected `completed`, actual `failed` | Exact unauthenticated GET then one authenticated POST, exact model/messages/budget, usage including reasoning, finish/id pass |
| `omits blank instructions, forwards temperature and keeps unknown usage unknown` | expected `true`, actual `false` | Pass |
| `rejects non-allowlisted id … before any request` (paid twin, case, leading/trailing whitespace, phase-2 Muse, empty, other-free) | permissive stub: expected `failed`, actual `completed` for all seven ids | All seven pass, zero requests |
| `fails closed for list … without generation` (missing exact free id, HTTP 500/401, network, non-JSON, wrong/null shape, bad entries) | expected `unavailable`, actual `invalid_request` for all eight cases | All pass, one public GET, no generation |
| `rechecks the live list after every completed call; a positive result never persists` | expected `completed`, actual `failed` | Pass; disappearance after success blocks next generation |
| `maps generation HTTP … without SDK retries or leaking provider errors` (401/403/408/429/500/503/404) | expected corresponding `unauthorized`/`timeout`/`unavailable`, actual `invalid_request` | All pass, one generation each, no echoed key/header/error |
| Generation HTTP 400 | expected 2 total requests, actual 0 | Pass, `invalid_request` |
| `maps 429 with Retry-After … to immediate unavailability` (absent / 3600) | expected `unavailable`, actual `invalid_request` | Both pass; nonretryable, no delay |
| `rejects malformed generation …` (non-JSON, empty choices, null text, empty text) | expected `malformed_response`, actual `invalid_request` | All four pass |
| `returns a safe transport failure and never logs echoed credentials` | expected `unavailable`, actual `invalid_request` | Pass; captured console contains no sentinel |
| `redacts the captured key even from successful provider-controlled fields` | expected `completed`, actual `failed` | Pass; result contains no sentinel |
| `rejects missing, blank, CR and LF keys safely at construction` | `Missing expected exception.` | Pass; thrown errors contain no key |
| `copies the key at construction` | `Cannot read properties of undefined (reading 'init')` | Pass; options mutation cannot change Bearer key |
| `honours pre-start AbortError/TimeoutError without requests` | expected `cancelled`/`timeout`, actual `invalid_request` | Both pass; zero requests |
| `honours AbortError/TimeoutError during list/generation without another request` | expected `started`, actual `finished` in all four cases | All pass; cancellation/timeout, no further request |
| `isolates concurrent calls and keys, with one generation each and no positive cache` | expected `true`, actual `false`; permissive stub expected 8 POSTs, actual 0 | Pass; eight independent generations with correct Bearer key |
| `a failed list cannot poison a later call` | expected `unavailable`, actual `invalid_request` | Pass; next call succeeds |
| `one list abort cannot abort a concurrent or later call` | expected `started`, actual `finished` | Pass; other calls succeed |
| Gateway 429 with/without Retry-After and six list-failure escalation cases | stubs: expected second unit `public@second`, actual `public@zen`, or expected one list GET, actual 0 | All pass; one Zen attempt, no wait, no secret in attempts/trace |
| `blocks provider_unavailable once every eligible generation unit is unavailable`; all-permitted-unavailable control | real adapter before gateway mapping: expected `blocked`, actual `unaccepted` | Both pass |
| Single/two unavailable units completing escalation exactly at cap | expected `blocked`, actual `unaccepted` | Both pass |
| Expired deadline / exhausted budget at that cap | expected `deadline_reached`/`budget_exhausted`, actual `attempts_exhausted` | Both pass |
| Newly eligible fallback at cap | removed second cap check: expected `unaccepted`, actual `accepted` | Pass; zero fallback dispatches |
| Example missing/blank credential | placeholder stdout differed from expected empty stdout | Pass; exit 1, exactly `OPENCODE_API_KEY is not set`, zero requests |
| Example provider error and minimal successful public request | placeholder request counts: expected 1, actual 0 | Both pass; child fetch mocked, key only from env, no key on argv/stdout/stderr |
| Example CRLF credential | placeholder unsafe stderr differed from expected empty stderr | Pass; bounded safe failure JSON, zero requests |
| Example scripts / verify inclusion | expected string, actual undefined | Pass |
| Sample free flash route and explicit destination permission | `the example must declare the free Zen routed unit` | Pass; paid twin absent, no numeric rate limits, local-only requests exclude Zen |

Gateway mapping red against the real adapter: 18 tests, 16 passed, 2 failed.
Cap tests before the fix: 23 tests, 19 passed, 4 failed. Dynamic-routing mutation:
23 tests, 22 passed, 1 failed. Example placeholder: 5 tests, 0 passed, 5 failed.

Final named suites: provider **46/46**, gateway integration **23/23**, example
**5/5**, route configuration **94/94**. Existing gateway **38/38** and routing
**5/5** pass. Negative controls cover mixed unavailable/unauthorized failures,
unapproved destinations, cancellation before/list/generation, deadline, budget,
and attempt bounds.

## Full verification on Node v22.23.3

`npm run verify` reaches the full package suite and reports:

```text
# tests 42
# pass 38
# fail 4
```

Untouched `origin/main` (`4869332c30c8cf32dbc0567eb615f07caaed02c2`), archived to a
scratch directory with isolated workspace links and the same installed tools:

```text
# tests 40
# pass 36
# fail 4
```

The same four files fail. Direct runs on each revision have identical failing
test names, error descriptions and pass/fail counts:

- `packages/gateway/test/amos.test.ts`: `listen EPERM: operation not permitted 127.0.0.1`.
- `packages/agentfabric/test/cli-generate.test.ts`: empty child stdout causes JSON parse and expected-output failures.
- `packages/agentfabric/test/shell-run.test.ts`: empty child stdout causes JSON parse and bounded-output failures.
- `packages/weave/test/task-acceptance.test.ts`: command child stdout is empty, causing `Unexpected end of JSON input`.

No existing test/check was weakened or skipped. Remaining verify commands ran
separately and passed: web typecheck/build, examples/benchmarks typechecks, Jev
(4 file tests), entailment (5 tests), decision (66 tests, 22 pre-existing skips),
offline task acceptance, ChatGPT CLI (2 file tests), and Zen example (1 file test,
5 named tests). The Node worker summaries count files; direct runs provide the
named counts above.

Every `checks/*.mjs` passed:

```text
M0-C1 OK: import direction holds across 187 files
M0-C2 OK: no ambient clock in 78 runtime files
```

## Local delivery

The original worktree's Git index is mounted read-only: `git add` and
`git commit` fail creating `index.lock` with `Read-only file system`. Following
the task's fallback instructions, the changes are committed as three logical
commits on `wv-011-opencode-zen-provider` in `/tmp/WV-011-commits`, with a clean
scratch working tree, and delivered in `/workspace/wvops/WV-011.bundle`. The
original working tree intentionally retains the same edits; no work was lost
and no remote operations were performed.
