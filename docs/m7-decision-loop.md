# M7 — Decision-model loop

This is the behavioral contract for the planned milestone in
[ARCHITECTURE.md §11](../ARCHITECTURE.md). It extends
[M6](m6-route-a-reconstructed-view.md). Terms follow
[GLOSSARY.md](../GLOSSARY.md). These requirements describe the target, not
implemented loop behavior. P0 establishes this contract; P1 supplies tier and
availability routing plus pure configuration validation. P2 supplies local ChatGPT authentication and a Responses adapter; P3–P12 remain planned.
Demonstrate red before implementation, prove green with deterministic fixtures,
and retain M0–M6 checks. Live provider runs are non-gating evidence.

## 1. Outcome and scope

Advance an authorized goal through observe, triage, route, preselect, guard,
implement, check, evaluate, and audit. Typed evaluation answers return as
observations. Deterministic policy retains authority over every transition,
destination, budget, effect, and grant. Independent actions may proceed together;
dependencies and effect conflicts constrain the frontier. Fabric remains bounded
and does not import Loom's runtime or scheduling concerns.

The existing `frontier.weigh` site remains available through
`ScriptedDecisionLayer`. New sites retain their semantic operation and answer
shape. Provider outage cannot silently turn evaluation into prose generation.
Capability generation, admission, and authority to execute stay separate gates.

## 2. Target loop

```mermaid
flowchart TD
  G[Authorized goal + success criteria] --> O[Observe / integrate state]
  O --> T{{D1 triage: decision choice}}
  T -->|trivial / deterministic| CAP[Invoke admitted capability]
  T -->|needs work| R{{D2 route: decision choice → tier}}
  T -->|needs human| ASK[Approval request]
  T -->|out of scope| STOP[Refuse / stop]
  R --> PRE{{D3 preselect skills+tools: boolean per catalogue entry}}
  PRE --> GR{{D4 input guardrail: decision predicate}}
  GR -->|block| ASK
  GR -->|pass| IMPL[Implementation step: configured generate tier]
  IMPL --> SH[Capability shell-out: tests, lint, build, tools]
  SH --> OE{{D5 output eval vs criteria: decision predicate per criterion}}
  OE -->|fail, retries left| IMPL
  OE -->|pass or retries spent| TS[Build tidy state]
  TS --> AUD[Audit tier: strong routed unit]
  AUD --> GAP{{D6 gap disposition: decision choice over audit findings}}
  GAP -->|gaps| O
  GAP -->|done + checks green| DONE[Complete: deterministic success evidence]
  Q[(quota-axi --json<br/>+ gateway spend)] -.budget gate before every dispatch.-> R
  Q -.-> AUD
```

Every `{{Dn}}` node is an `evaluate` request through the gateway, served by the configured **decision provider** (§4a): TypeSafe Jev is the sole default decision provider. OpenAI Decisions (401 under ChatGPT sign-in) and Cloudflare Workers AI fallbacks are deferred. Its answer is recorded as an observation, and a deterministic rule then turns it into a transition. The decision model never dispatches anything itself. D7 guards proposed output effects before dispatch or publication; D8 checks progress after each round.

## 3. Tidy-state schema (audit-tier input)

The planned versioned view is `view.audit@1`, assembled in `views.ts` from authorized slices. It is deterministic and digested so it can be cached by prefix.

```text
interface AuditState {
  schema: 'audit-state@1';
  goal: { goal_id; statement; success_criteria: Criterion[]; authority_scope; revision };
  iteration: number;                         // loop-back count
  plan: { step_id; intent; tier; status: 'done'|'failed'|'skipped' }[];
  decisions: { site; question_id; choice; probabilities; confidence; fallback_used: boolean; obs_seq }[];
  artifacts: { artifact_id; kind: 'diff'|'file'|'report'; digest; summary; bytes; ref }[]; // ref, not raw body, above a size cap
  checks: { check_id; argv_digest; exit: number; passed: boolean; tail: string }[];  // deterministic evidence
  evals: { criterion_id; verdict_probability; confidence?; passed: boolean }[];       // D5 outputs
  open_issues: { issue_id; source: 'check'|'eval'|'audit'; text; severity }[];
  budget: { spent_micros; ceiling_micros; quota: { provider; window; percent_remaining; resets_at }[] };
  omissions: string[];                       // what the view left out and why (existing view rule)
  source_revisions: Record<string, number>;
}
```

The audit tier returns `AuditReport { findings: {criterion_id|null, kind:'gap'|'defect'|'regression'|'scope_creep', evidence_ref, proposed_fix}[], goal_met_claim: boolean }`. Its `goal_met_claim` is an observation only. Completion still requires deterministic success evidence (ARCH §3).

## 4. Decision-point catalogue

### 4a. Decision provider interface

Decision providers serve the existing
`EvaluationAdapter.evaluate(EvaluationCall)` interface. Configuration selects
TypeSafe Jev as the sole default decision provider, with no provider fallback.
OpenAI Decisions (401 under ChatGPT sign-in) and Cloudflare Workers AI fallbacks
are deferred. The loop names a judgment site and answer shape. It does not name a vendor.

The [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
documents `POST /v1/decisions` with `gpt-6-luna`, shared input, named questions,
and typed answers. Gateway `boolean` maps to its `predicate`; gateway `choice`
and `score` map to choices and ordered levels. TypeSafe Jev uses
`/v1/systemone` with `noul`, `choice`, and `score`. Wire profiles translate these
protocols without changing the gateway's semantics. P3 will carry both profiles
through a shared HTTP transport and exercise one contract suite against each.
P12 will extend that arrangement to compatible endpoints, including local ones.

Refusal, malformed answers, and unavailable providers must lead to recorded
fallback or pause. Missing confidence triggers fallback only where the site's
provider-specific rule requires it. OpenAI predicate answers supply probability
only; D5 uses the provisional probability-only band below, to be tuned in P10
on the tune split. Providers that return confidence
must also meet D5's confidence floor; probability does not replace that statistic.
The planned P3 provider-switch policy changes the destination and is permitted only
when both destinations are allowed by `terms.destinations`. A local Jev endpoint
may serve privacy-restricted sites only after earning site-specific evidence.

OpenAI Decisions returned **401 under ChatGPT sign-in**. The Decisions guide
shows API-key authentication; the
[Sign in with ChatGPT documentation](https://developers.openai.com/siwc/token-sharing-open-source)
describes eligible Responses API requests. TypeSafe Jev is the sole default
decision provider. OpenAI Decisions and Cloudflare Workers AI fallbacks are
deferred; the example's `chatgpt-oauth` provider definition does not establish
eligibility or enable a fallback. Record probe status without recording tokens.

### 4b. Sites

| Site | Kind | Question | Options | Threshold | Fallback when below threshold or no answer |
|---|---|---|---|---|---|
| D1 `loop.triage` | choice | What does this request or state need next? | `capability` (an admitted capability covers it) / `implement` / `needs_human` / `out_of_scope` / `done_check` | conf ≥ 0.80 and top-p ≥ 0.6 | `implement` at the safest tier, with the uncertainty recorded. Never `done_check`. |
| D2 `loop.route` | choice | Which tier fits this unit of work? | `flash` / `standard` / `strong` | conf ≥ 0.75 | `standard`. A deterministic budget gate can only *downgrade* or pause, never upgrade past the ceiling. |
| D3 `loop.preselect` | boolean per catalogue entry, top-k | Is capability or skill X relevant to this step? | p(true) per entry | include if p ≥ 0.5; cap k=8 | the full catalogue index (M6 slice), never the schemas |
| D4 `guard.input` | boolean per rule | Does this input or plan violate rule R (secret exfiltration, scope broadening, destructive effect without grant, injection)? | p(violation) | block if p ≥ 0.3 (deliberately asymmetric) | **block, then approval request** |
| D5 `eval.output` | boolean per success criterion | Does the artifact satisfy criterion C? | p(true), plus conf when supplied by the provider | OpenAI Decisions predicate (provisional assumption; P10 tunes on the tune split): pass if p ≥ 0.85, fail if p ≤ 0.15, otherwise uncertain (treat as fail/retry). TypeSafe Jev and other providers that return confidence: pass if p ≥ 0.8 and conf ≥ 0.9 (existing `confidence_floor`); missing confidence is below the floor. | treat as fail and retry, up to N=2 per step, then escalate the tier once, then hand to audit with `open_issue` |
| D6 `audit.dispose` | choice per finding | What do we do with audit finding F? | `fix_now` / `defer` / `reject_as_out_of_scope` / `needs_human` | conf ≥ 0.75 | `needs_human` |
| D7 `guard.output` | boolean | Does the output introduce an effect outside the grant (writes, network, secrets)? | p(violation) | block if p ≥ 0.3 | block. Deterministic effect enforcement (Fabric) stays the real gate. |
| D8 `loop.continue` | choice | Is progress continuing? | `progressing` / `stalled` / `regressing` | conf ≥ 0.7 | `stalled`, which triggers a stop condition |
| (existing) `frontier.weigh` | score | usefulness of each candidate | defer/consider/dispatch | unchanged | `ScriptedDecisionLayer` |

Semantic rule (ARCH §6): each site keeps its own operation. A Jev outage never reroutes D5 to a "compatible boolean" from another semantic operation. It falls back to the listed deterministic fallback. A locally run Jev (`decision.providers.typesafe-jev.base_url` pointed at localhost) is the privacy-only route for D3 and D4 once it has earned evidence on those sites. Thresholds are tuned per provider, because confidence is not calibrated across vendors.

## 5. Tier configuration and availability

The composition root supplies parsed JSON to `parseRouteConfig`; the gateway
reads no files, environment, or clock. The root may load `weave.routes.json` and
an ignored `weave.routes.local.json` overlay. See
[weave.routes.example.json](../weave.routes.example.json) for the P1 shape:
`units` is a route table and `decision` declares `provider`, nullable `fallback`,
and named `providers` with `base_url`, `model`, optional `auth`, and optional
`key_env`. `key_env` requires `auth: "api-key"`. `auth: "chatgpt-oauth"` carries
no `key_env`. `auth: "api-key"` requires one. A non-loopback provider requires
`auth` or `key_env`; a loopback provider may omit both. These are configuration
names, never embedded credentials. The example declares
future adapters; parsing it does not install or execute them.

`tier` is optional on a routed unit. A requested tier in `InferenceTerms` or
`RouteTarget` filters mismatches with `tier_mismatch`; if both specify a tier,
a unit must satisfy both. Omitting tier preserves existing routing. Quality is
still `baseline` or `high`, independently checked. Prices are nonnegative finite
micros per million tokens; subscription examples declare zero token prices.
Quota accounting is a separate P4 gate, not an implication of zero cost.

`ProviderAvailability` is caller-supplied data keyed by exact routed-unit adapter
ids, not provider or destination ids. The composition root must map quota-provider
ids to adapters (for example, quota provider `claude` to adapter `claude-code`).
Only own entries are consulted; unmatched keys are ignored. Entries are `available`, `exhausted`, `auth_required`, or
`unavailable`, or `{ status, recheck_after? }`. Any explicit nonavailable adapter match
excludes a unit with `provider_unavailable`. Missing entries preserve existing
behavior. `recheck_after` is an injected timestamp for the root to act on;
routing never reads time or turns an expired entry into permission to dispatch.
Filtering and existing evidence ordering stay deterministic.

Validation rejects duplicate routed-unit ids, invalid operation/kind pairs,
unknown tiers, a `decision` tier on a generate unit, malformed route fields,
whitespace-padded models, context profiles, and prompt templates, negative or
nonnumeric prices, missing configured decision providers, identical primary and
fallback, a `key_env` without `auth: "api-key"`, a non-loopback provider with
neither `auth` nor `key_env`, a `key_env` on `chatgpt-oauth`, an `api-key`
provider without a `key_env`, and base URLs other than HTTPS or HTTP on loopback hosts
(`127.0.0.1`, `::1`, `localhost`) without userinfo, `?`, or `#`. Adapters remain
credential-injected.

P3 assumption: per-provider destinations will come from each provider's routed
unit or be added to its provider record in P3. Switching decision providers will
require both destinations in the request's terms. P1's `DecisionConfig.providers`
has no destination field and P1 does not enforce provider-switch destinations.
The example CLI units declare remote vendor destinations even when the CLI
process runs locally.

## 6. Loop-back and stop conditions

Loop back to Observe when audit findings dispose as `fix_now`. Each finding becomes an `open_issue`, then a candidate with the `criterion_id` attached.

Stop:

1. **Done**: every success criterion has deterministic evidence (checks green), D5 passes all criteria, and the audit has no `fix_now`.
2. **Budget**: the weekly quota gate trips (§8), or the gateway cost ceiling is reached. The loop pauses with state persisted. This is not a failure.
3. **Iteration cap**: `max_iterations` (default 4 audit rounds).
4. **No progress**: D8 says `stalled`/`regressing` twice in a row, or the same `issue_id` reappears after two fix attempts.
5. **Authority**: D4 or D7 block, or a needed approval, goes to `needs_human`.
6. **Decision outage**: both configured decision providers are unavailable. The loop drops to `ScriptedDecisionLayer` plus deterministic fallbacks for *read-only* steps, and pauses before any dispatch that needs D4.

## 7. Phased PR plan

Each PR is small. Each must pass `npm run verify`, adds tests to the existing `node --test` suites, and keeps `checks/` green. Live provider runs are non-gating benchmarks, as today.

| # | PR | Acceptance criteria | Tests |
|---|---|---|---|
| P0 | **Glossary + design doc**: add *tier*, *decision provider*, *wire profile*, *tidy state*, *audit tier* to GLOSSARY.md; write `docs/m7-decision-loop.md` | Terms used consistently; ARCH §11 updated | doc-only |
| P1 | **Tiered route table from config**: `tier` on `RoutedUnit`; pure config validator in gateway; file loading only in the composition root; `ProviderAvailability` port | Gateway still does no env/fs reads; an unavailable provider is excluded with reason `provider_unavailable`; deterministic order preserved | routing tests: exclusion, tie order, empty table gives a blocked outcome |
| P2 | **Sign in with ChatGPT** (early): `packages/auth-chatgpt` (PKCE, loopback, persisted host id and issued client_id, ID-token/JWKS validation, refresh) plus an `openai-chatgpt-plan` Responses generate adapter; **live probe of `/v1/decisions` with the OAuth token** | No client secret; token file 0600; token never on argv or in logs; unit is `auth_required` until signed in; probe result recorded in the doc | mocked auth server and fetch; nonce, aud and expiry failure cases; Responses stream parse |
| P3 | **Decision providers behind one interface**: refactor `typesafe-ai.ts` into wire profile plus transport with a configurable base URL; add `openai-decisions.ts` (predicate/choice/score/refusal); `decision.provider` and `fallback` config | Same `EvaluationAdapter` for both; provider chosen by config only; local TypeSafe base URL works; refusal leads to fallback; fallback only when both destinations are permitted | **shared contract suite run against both profiles**: every question type, refusal, missing confidence, 401/429/5xx, malformed body, key never in logs |
| P4 | **Budget gate**: `QuotaPort` (a `quota-axi --json` snapshot supplied as data) plus `budget.policy@1` | No dispatch once a provider's week is 80% used; pause until `resetsAt`; pace `ahead` downgrades the tier | fixtures at 79/80/95% used, unknown pace, stale, missing, or unknown snapshot fails closed for every quota-tracked tier |
| P5 | **Decision sites D1, D2, D8** (triage, route, progress) in `packages/weave/src/sites/` | Below-threshold answers take the recorded fallback; a stale answer is rejected; the scripted layer still passes M0–M6 | fake provider answers; replay determinism |
| P6 | **D3 preselect plus D4/D7 guardrails** | Preselect only narrows the disclosed catalogue slice; a block becomes an approval request | M6 slice tests; guard asymmetry tests |
| P7 | **`shell.run@1` plus `repo.test/lint/build`, and CLI backends** (`codex exec`, `claude -p`, `grok`) as generate adapters, prompt on stdin | Effects enforced by grant; env values never on argv or in logs; timeout and cancel honoured | Fabric host tests with the canary-env leak pattern; stub CLIs |
| P8 | **Implementation-tier step plus D5 output eval** | Retry ≤2, escalate a tier once, then raise an open_issue | toy-goal loop with fake providers |
| P9 | **`view.audit@1` tidy state, audit tier, D6, loop-back and stop** | An audit claim alone cannot complete a goal; iteration-cap and no-progress stops fire | end-to-end fixture: gap, loop, done; stall, stop |
| P10 | **Live benchmarks** (non-gating): per-site sets for each decision provider | Thresholds tuned per provider on the tune split; holdout reported | recorded results |
| P11 | **MVP test drive** (last MVP phase): Weave runs one real end-to-end task, e.g. a small real PR on weave itself | **Exit:** (a) ChatGPT sign-in works as an inference provider and serves real calls; (b) the configured decision provider makes the D1 triage and D2 routing decisions, recorded with confidence; (c) a light tier and a frontier tier both run inside the loop; (d) checks green, audit run, stop recorded; (e) the week stays under 80% | recorded trace and replay; quota-axi delta logged |
| P12 | **Post-MVP: generic decision-endpoint adapter.** A config-declared wire profile for any compatible decision endpoint, local providers included | No interface change; adding an endpoint is config plus a profile; the destination is declared | the shared contract suite runs against a local mock server |

Order: P0 → P1 → **P2 ChatGPT sign-in, early, because both the OpenAI decision provider and the test drive depend on it** → P3 decision providers. P4 (budget) and P7 (shell) can run alongside P2 and P3. P5 depends on P3. P6 depends on P5. P8 depends on P6 and P7. P9 depends on P8. **P11 MVP test drive is the last MVP phase** and depends on P2, P3, P5 and P9. P12 comes after the MVP.

## 8. Budget

**Hard policy: no dispatch may take a provider beyond 80% of its weekly budget.**

**Loop mechanism (P4).** The hard rule: the loop stops at 80% of weekly quota, checked with `quota-axi --json`.

- Before every routed dispatch, and at the start of every audit round, the composition root runs `quota-axi --json` with a ~60s cache. For each `quota_provider` it reads `windows[id=seven_day].percentRemaining`, `resetsAt`, `pace.status`, and `five_hour`.
- **Weekly gate:** if `percentRemaining ≤ 20` (80% used) for the provider a unit draws on, the unit is excluded (`weekly_budget_cap`). If no eligible unit remains for the step, the loop records `loop.paused{until: resetsAt}` and stops dispatching. It resumes at reset, through the injected clock and timer only. The cap is enforced against the whole week, including use outside Weave, because quota-axi reports the account total. That is stricter than "Weave's share", and safe.
- **Five-hour window:** if `≤ 10%`, prefer another provider; if none, wait until that reset (the gateway already waits on known delays).
- **Pace:** `ahead` downgrades `strong` to `standard` except for the audit step, which pauses instead. An audit should not be done by a weaker model.
- **Fail closed:** a stale, missing, or `unknown` snapshot is at the cap for every quota-tracked tier (`decision`, `flash`, `standard`, and `strong`). Each such unit is excluded (`weekly_budget_cap`) until a fresh snapshot shows its provider under the 80% weekly gate.
- **Metered providers:** the per-run `cost_ceiling` in micros. A weekly metered cap is configured in the same policy record.


## 9. Acceptance evidence and unresolved assumptions

Deterministic fixtures must prove threshold boundaries, recorded fallbacks,
stale-answer rejection, destination restrictions, retry and escalation bounds,
effect denial, cancellation, concurrent independent work, audit loop-back, and
every stop condition. Every consequential transition records the state revision,
site, answer, confidence, applied policy, and fallback. Generated artifacts and
tests remain untrusted until independently validated; checks cannot be weakened
by a decision answer or audit report.

P1 does not instantiate decision or CLI adapters, read quotas, authenticate,
assemble tidy state, or execute this loop. Configured model names, credentials,
CLI availability, and OAuth access are operator assumptions until subsequent
phases supply evidence. P4 must fix snapshot freshness, account/provider quota
mapping, and reservation bounds before implementing the weekly gate. A stale,
missing, or unknown snapshot is at the cap for every quota-tracked tier. The
repository cannot establish live provider entitlement or quota guarantees from
configuration alone.


## P2 — Sign in with ChatGPT and Responses

Landed `@weave/auth-chatgpt`, an independent stdlib-only package with injected
fetch, clock readings, and a credential-store port. It persists a UUID URI host
ID before authorization, uses PKCE S256, state and nonce, validates RS256 ID
signatures and issuer/audience/expiry/nonce, and checks the token response's
plan-usage scope. Returning sign-in reuses the selected issued client ID and
checks the validated subject before replacing credentials. The filesystem
implementation writes atomically with file mode 0600 and directory mode 0700.
No runtime or Fabric package imports authentication.

`@weave/gateway/openai-chatgpt-plan` sends credential-injected Responses calls to
`openai.chatgpt-plan`. Its SSE parser accepts success only at
`response.completed`. Usage limits become `quota_exhausted` without an inferred
reset; temporary usage unavailability and interrupted streams become
`unavailable`; incomplete output becomes `malformed_response`. HTTP diagnostics
retain status, body, structured error code/param and request ID with the access
token redacted. The gateway's existing closed failure vocabulary is unchanged.

Run the composition roots locally on the browser's machine:

```sh
npm run example:chatgpt-signin
mkdir -p .local
npm run example:chatgpt-probe -- --out .local/chatgpt-probe.json
```

Sign-in accepts `--port` (default 1455), `--timeout-ms` (default 600000), and
`--credentials` (default `~/.config/weave/chatgpt.json`). Probe accepts
`--credentials` and requires `--out`. The listener binds only 127.0.0.1 before
printing the authorize URL. Neither script accepts credentials on argv or logs
tokens. A lock file excludes concurrent sign-in/refresh commands; a stale lock
fails closed and requires operator removal after confirming the old process
stopped. Temporary refresh failures preserve the saved credentials; documented
terminal refresh errors discard unusable tokens while retaining host and issued
registration identity for reauthorization. Until credentials exist and plan
usage is granted, the composition must supply `auth_required` availability for
the `openai-chatgpt-plan` adapter; configuration alone establishes no entitlement.

The probe records the actual HTTP status, request ID and raw body (including SSE)
for models, Responses, and Decisions, redacting credential values. It preserves
server model order and selects the first `visibility: "list"` slug. If models
cannot be listed it records a skipped Responses call rather than guessing a
model; the Decisions probe still runs. The Decisions body follows the official
[choice example](https://developers.openai.com/api/docs/guides/decisions), using
`gpt-6-luna` and the duplicate-charge input. The `/v1/decisions` probe is **pending
the captain's sign-in**. No live OAuth entitlement or endpoint support is claimed;
neither sign-in nor live probes were run during implementation.

Conservative choices and limits:

- Optional returning `id_token_hint` and `login_hint` are omitted so the printed
  authorize URL contains no retained token. Returning users may see the account
  selector. No forced consent parameters are sent.
- The published JWKS URL is `https://auth.openai.com/.well-known/jwks.json`,
  confirmed by [OpenAI's identity validation guide](https://developers.openai.com/siwc/website).
  Keys are fetched for validation rather than introducing a cache. Expiration
  has zero clock-skew tolerance. Refresh ID tokens, when supplied, are signature,
  issuer, audience, expiry and subject checked; there is no authorization nonce
  in a refresh grant. A refresh omitting an ID token retains the validated identity.
- Each credential file selects one registration. There is no account-switching
  UI or automatic multi-account merge. The command never replaces a returning
  registration with a different client ID or subject.
- Preview restrictions forbid `max_output_tokens` and `temperature`, so the
  Responses adapter omits both. Caller cancellation still bounds execution;
  the provider's actual usage is reported, and unknown usage remains unknown.
- Identity-only credentials remain signed in but cannot invoke plan inference.
  No automatic billing fallback, retries, or guessed quota-reset times are added.

P2 deterministic evidence: missing-module red preceded implementation; 11 auth
cases, 15 Responses adapter cases, and two CLI lock/redaction cases pass on
Node 22. Build, structural checks, web build/typecheck, example and benchmark
typechecks, Jev tests, Python contract suites and the standalone offline
acceptance command pass. The exact requested `npm exec --yes --package=node@22
-- npm run verify` was attempted: its existing task-acceptance command tests
fail because this sandbox's `spawnSync` returns `EPERM` and empty stdout, which
those tests attempt to parse as JSON. No tests or permissions were weakened.
