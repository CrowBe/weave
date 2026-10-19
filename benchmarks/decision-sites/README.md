# Decision-site benchmark (WHC-P10)

This non-gating experiment compares the nine production judgment sites across
TypeSafe Jev, local Amos, and the benchmark-local OpenAI Decisions profile.
It also supports pi and fx ask as generic ChatGPT-sign-in competitor harnesses,
and the Meta Muse Spark contributor model as an opt-in competitor.
It does not change production behavior, defaults, thresholds or provider routing.
Read [SCORING.md](SCORING.md) before running. The 424 committed cases and
[provenance](sets/PROVENANCE.md) are frozen by scenario and SHA-256; tune is used
only to select thresholds, then holdout is reported against both selected and
production thresholds. Source labels are teacher observations, not independent
truth; the provenance records their limitations and teacher versions.

Use Node 22 and the existing workspace dependencies:

```sh
export PATH=/home/box/.local/node22/bin:$PATH
npm run test:decision-sites
npm run bench:decision-sites:live -- --providers fake --run-id offline-dry-run
# Operator only, after configuring credentials and checking price assumptions:
nice -n 10 npm run bench:decision-sites:live -- --run-id live-20261015 \
  --providers typesafe-jev,amos-small,openai-decisions,pi,fx-ask
```

The live script reads `.env.local` if present. Credentials are injected only from
`run.ts`: `TYPESAFE_API_KEY` (fallback `TYPESAFE_AI_API_KEY`) and `OPENAI_API_KEY`.
Missing keys produce `skipped: no_credential`. Amos uses `AMOS_BASE_URL` or
`http://127.0.0.1:8766`; the harness never starts, stops or restarts it. It uses
`amosEvaluator`, discovers listed question types at `/v1/models`, and dispatches
one request at a time. Run under `nice -n 10` to keep local inference courteous.
Child processes (quota-axi, pi and fx) inherit only `HOME`, `PATH` and `XDG_*`.
Neither API-key family nor other ambient environment values reach those CLIs;
ChatGPT sign-in is discovered through their local authentication configuration.
All providers dispatch sequentially.
No grants, guardrail middleware, shuffle, routing tiers, or gateway budget
downgrades participate. Requests are captured from the actual production site
builders through a port, then sent directly to adapters (Muse Spark excepted, below). There are no trace
payloads; integration with the AgentSOP trace envelope remains a follow-up.

`typesafe-jev` pins `jev-1.14.0`, sets `shuffle:false`, batches every item's
questions, and rejects a different served model. OpenAI uses `/v1/decisions`,
`gpt-6-luna`, API-key authentication only, and a local predicate/choice/score wire
profile. Its wire schema and prices are offline contract assumptions until a
credentialed run confirms them. ChatGPT sign-in previously returned 401 for
Decisions and is never substituted as a credential. An HTTP 401/403 records
status, code and request id and skips the remainder of that provider. Other
providers continue. HTTP 429 retries up to three total attempts, honoring
Retry-After up to a 60-second bound; a longer wait ends the item without an early
retry. Network/timeout/5xx/shape/refusal failures remain in item denominators.
An unsupported Amos question type fails that item; it does not disable other
sites or future resumes. Only provider-level auth, credential, quota, model
availability or CLI capability failures skip the whole provider.

The default metered decision-spend ceiling is **USD 2.00 per run**. Each HTTP
attempt reserves `serialized_request_utf8_bytes * input_price / 1e6` before
calling. Actual `usage.input_tokens` replaces the reservation after receipt.
Missing usage retains that conservative estimate; skips before inference cost
zero. A 429 without usage is therefore charged at its projection on each of its
up to three attempts, which can over-state the bill and reach `budget_stop`
early; no provider here documents usage-less 429s as unbilled, so the budget
keeps that charge. Reports separate it instead: `summary.json` and the run
report give `observed_usd` (priced from usage receipts) and `reserved_usd`
(charged without a receipt: usage-less completed calls plus
`pending_reservation_usd` for unacknowledged calls) beside the conservative
ledger total `spent_usd`, which the budget stop uses. Prices are TypeSafe $0.042/M input (output free) and OpenAI Decisions
$0.10/M input with output tokens assumed unbilled and no cache charges, based on the
[Decisions guide](https://developers.openai.com/api/docs/guides/decisions).
The OpenAI price remains unconfirmed until a credentialed run; [code](providers.ts)
records the same source and input-only assumption. The reservation conservatively
allows one input token per UTF-8 byte. The USD ceiling is a hard preflight bound
on this projection, but a soft bound if a provider bills server-side template
tokens beyond the byte-based projection: at most one call can overrun. Its actual
cost is journalled, followed by a durable `budget_stop` that halts all further
dispatch, including on resume. Ordinary ceiling
stops still allow later providers their own preflight checks, including zero-price
Amos and competitors. No snapshot
authorizes spending on resume: the live journal is read
again before every call. A ceiling stop records `budget_stop` and renders partial
results. The first `run` record fixes the run's original ceiling. Resume and
render-only use it by default; an explicit lower `--max-spend-usd` is allowed.
Increasing it requires both `--max-spend-usd N` and `--allow-spend-increase`.
That override is recorded and applies only to the invocation; it does not replace
the first record. Any spending invocation above $5 additionally requires
`--allow-spend-above-5`, including an authorized increase on resume.

Competitors receive the same state and questions on stdin, asking for strict
JSON. Each child process, including quota/auth/help checks, runs in its own fresh
empty temporary cwd with sessions and tools disabled. The directory is removed
after the call, including failure and cancellation.
`quota-axi --provider codex --json` runs immediately before each competitor call;
a missing, stale or >=80%-used weekly window skips the provider for the current
invocation only. Freshness requires `provider.state.status: "fresh"` and
`provider.state.stale: false`, along with fresh timestamps and a valid reset.
Quota skips are journalled with `persistent:false` and are rechecked on resume,
including the item skipped before any inference. Auth, no-credential and CLI
tool/capability skips stay persistent. The quota check
accepts windows identified by kind `weekly` or id `weekly` / `seven_day`, using
the lowest remaining percentage across matching windows. Each competitor
has a hard cap of 40 intended calls including resume and uncertain dispatches;
known quota-only skips do not count as inference calls. Calls spread across sites in
round-robin order. Only holdout is sent; there is no competitor threshold tuning.
Auth failures skip without retry. pi verifies its supported flags with `--help`
and uses `-p --mode json --no-session`, explicit tool/MCP/extension/context
suppression, and `openai-codex`. fx verifies `fx status` and `fx ask --help`, then
uses `fx ask --json --no-save --no-tools` if supported. Installed fx 0.0.13 lacks
tool suppression and is recorded `skipped: tools_cannot_be_disabled` after auth
checks. A compatible version is needed for a tool-free fx comparison. Competitor served
model ids are not observed: `chatgpt-sign-in` identifies authentication, and is
excluded from the served-model list; the requested pi model is `gpt-6.1`.

Meta Muse Spark contributor (`muse-spark`) is opt-in: it is never in the default
provider set or the headline coverage requirement. Its destination may train on
content, so the operator must classify the benchmark content with
`--content-class public` or `--content-class non_sensitive`; the CLI refuses
`muse-spark` without one, including on resume and render-only, and records the
class in the run record. Never classify private repository work, operator or
captain data, or sensitive content that way. `MODEL_API_KEY` is read only by
`run.ts` and sent only as a Bearer header; a missing key skips with
`no_credential`. It is the one benchmark route that goes through the gateway
(`@weave/gateway/muse-spark`): routing admits the training-allowed destination
only for the declared class and excludes credential-shaped content before
dispatch, which fails that item as `credential_content`. Both units keep the
1024-token output budget that default reasoning needs and send no reasoning
parameter. Each makes one SDK attempt: the 1.3 contributor first, then the
declared 1.2 fallback once, except after a refused credential, which skips the
provider. The answering unit's requested model is recorded as the served model;
the response's own model id is not checked. When both models are rate limited
the item surfaces as HTTP 429 for the bounded retries above. Its price is
unknown and recorded as zero, which is not a claim of free use. It receives the
same strict-JSON prompt as pi and fx, holdout only, under the same 40-call cap.
No live Muse Spark run has been made; its tests use a stubbed `fetch` only.

Other flags: `--sites intake.classify,loop.route`, `--split tune|holdout|all`
(default all), `--providers ...`, `--run-id NAME`, and `--resume`. A holdout-only
run without tune results reports production thresholds with `no_tune_data`; to
continue a tune run, reuse its run id with `--split all --resume`.

`--resume` re-renders the report and summary without re-asking completed items
whose model/set/question bindings still match. It can dispatch unfinished or
changed items. For guaranteed report regeneration with **no provider or CLI
calls**, use `--render-only` with the same run id, providers and sites:

```sh
npm run bench:decision-sites:live -- --render-only --run-id live-20261015 \
  --providers typesafe-jev,amos-small,openai-decisions,pi,fx-ask
```

Render-only reads the existing journal without appending records or repairing a
torn tail; even an incomplete final line stays byte-for-byte unchanged. It
regenerates the run's `REPORT.md` and `summary.json`. The checked-in `REPORT.md`
is refreshed only for a complete, all-site, both-split run requesting the full
default live provider set (`typesafe-jev,amos-small,openai-decisions,pi,fx-ask`),
without the fake provider and with at least one successful answer. Requested
providers skipped at runtime for `no_credential` or `auth_required` still count
as covered. A `quota_unavailable_or_weekly_cap` skip does not count as covered
for headline publishing, including during render-only. Fake, partial and entirely
skipped reports stay under `results/<run_id>/`. A temporary exclusive lock still
prevents concurrent writers. Render-only makes no calls. Resume preserves
persistent skips and rechecks invocation-only quota skips.

Each run owns `results/<run_id>/lock` exclusively. A concurrent writer refuses;
a dead-pid lock is reported as stale and must be inspected and removed by the
operator. New locks record a nonce, boot id and PID namespace; only a matching
boot and namespace permit a local liveness probe. Foreign or unidentifiable
owners are `stale-unknown`, including a container using the same PID. Legacy
PID-only locks retain their inspection behavior. In both formats, a same-host
lock carrying our unheld PID is a crashed predecessor and reads as stale.
Lock keys resolve relative spellings to the same absolute path. Empty or
malformed locks are `stale-unknown`. No lock is silently stolen.
The append-only `journal.jsonl` fsyncs reservations and completed calls;
a torn final line is truncated before appending, while corrupt earlier records
refuse replay. Writable journals cache parsed rows only during a locally held
lock tenure, updating the cache after durable writes. A new tenure reloads disk;
read-only and unlocked journals continue reading disk. The lock assumes that
all writers cooperate and use the same run-directory spelling after resolution;
symlink aliases are not canonicalized. Saved answers bind provider, expected and served model, site,
item, set digest, production question digest, and serialized wire-body/prompt digest.
Changed bindings are re-asked; older
cost remains charged. Every completed attempt is charged once. Resume never
re-pays a terminal wrong-model failure: it remains recorded against the
requested binding, with the unexpected served model retained as failure evidence.
Legacy records without a serialized request digest remain displayable with
`--render-only`, but never match for reuse or report binding during resume.
The recorded `live-20261015` headline predates wire-body binding and is
legacy-bound by design: render-only can still regenerate and republish that
headline from its legacy records. New live runs bind answers to the serialized
wire body or prompt as well as the other recorded bindings.
SIGINT/SIGTERM request cancellation and wait for the in-flight call to settle
(up to 30 seconds for HTTP, 120 seconds for competitors), then record cancellation,
render partial results and exit nonzero. A second Ctrl-C does not force-exit;
this is deliberate for journal safety. Returned results are journalled before
stopping: an acknowledged answer and
its actual usage survive cancellation. Only cancellation before inference dispatch
produces a retryable cancelled/not-sent result: a nonterminal failure that costs zero
and consumes neither an attempt nor the competitor call cap. A competitor prompt
handed to the process runner counts conservatively toward the cap; cancellation
after that point is terminal `cancelled_after_dispatch` and is never auto-retried.

A crash or cancellation between dispatch and durable receipt cannot establish
whether a provider billed the call: no provider here exposes result lookup or an
idempotent inference guarantee. Its reservation remains spent, the item is
reported as uncertain/uncovered, and resume continues other items without
blindly paying again. This deliberate limit preserves the no-double-payment
rule; an operator must reconcile uncertain items separately. No single-use
execution grants are involved.

`REPORT.md` and `results/<run_id>/summary.json` derive from the journal in stable
site/provider order, with statuses, models, digests, Node version, spend, tokens,
latency and calibration. D3 shows both best-kept and kth-kept gaps (#145), needed
recall, and multi-entry counts (#140). Any looser guard, D3 or D5 setting is marked
`not_applied: needs captain (#142)`. Lower choice-site confidence floors and a
lower D1 top-p carry `not_applied: looser than production (report only)`.
Every candidate remains descriptive.
D3's headline and tune objective are all-needed recall among covered steps;
extra entries do not reduce it. Exact-set agreement remains a secondary column.
The score@2 correction and rationale are recorded in SCORING.md. Guards and D5
also show probability-only violation recall, false-block rate and ROC AUC,
labelled **descriptive only, not applied (#142)**. Those diagnostics ignore
confidence and use P(violation) >= .3 (D5 uses 1 - P(satisfied)); production
confidence gates and thresholds remain unchanged.
Generated artifacts from fake runs are explicitly labelled `fake` /
`offline-fake` and are not live provider evidence. The crewmate records live
results after the offline implementation is reviewed.
