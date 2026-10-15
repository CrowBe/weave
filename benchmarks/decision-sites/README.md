# Decision-site benchmark (WHC-P10)

This non-gating experiment compares the nine production judgment sites across
TypeSafe Jev, local Amos, and the benchmark-local OpenAI Decisions profile.
It also supports pi and fx ask as generic ChatGPT-sign-in competitor harnesses.
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
All providers currently dispatch sequentially (Jev <=4; Amos/competitors =1).
No grants, guardrail middleware, shuffle, routing tiers, or gateway budget
downgrades participate. Requests are captured from the actual production site
builders through a port, then sent directly to adapters. There are no trace
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

The default metered decision-spend ceiling is **USD 2.00 per run**. Each HTTP
attempt reserves `ceil(serialized_request_chars/3) * input_price / 1e6` before
calling. Actual `usage.input_tokens` replaces the reservation after receipt.
Missing usage retains that conservative estimate; skips before inference cost
zero. Prices are TypeSafe $0.042/M input (output free), OpenAI $0.10/M input;
[code](providers.ts) includes the source URLs. An unexpectedly larger reported
usage can exceed the preflight estimate and is recorded honestly; subsequent
calls stop. No snapshot authorizes spending on resume: the live journal is read
again before every call. A ceiling stop records `budget_stop` and renders partial
results. `--max-spend-usd` sets the ceiling; above $5 additionally requires
`--allow-spend-above-5`.

Competitors receive the same state and questions on stdin, asking for strict
JSON. They run in an empty temporary cwd with sessions and tools disabled.
`quota-axi --provider codex --json` runs immediately before each competitor call;
a missing, stale or >=80%-used weekly window skips the provider. Each competitor
has a hard cap of 40 intended calls including resume, spread across sites in
round-robin order. Only holdout is sent; there is no competitor threshold tuning.
Auth failures skip without retry. pi verifies its supported flags with `--help`
and uses `-p --mode json --no-session`, explicit tool/MCP/extension/context
suppression, and `openai-codex`. fx verifies `fx status` and `fx ask --help`, then
uses `fx ask --json --no-save --no-tools` if supported. Installed fx 0.0.13 lacks
tool suppression and is recorded `skipped: tools_cannot_be_disabled` after auth
checks. A compatible version is needed for a tool-free fx comparison. Competitor served
model ids are not observed: `chatgpt-sign-in` identifies authentication, and is
excluded from the served-model list; the requested pi model is `gpt-6.1`.

Other flags: `--sites intake.classify,loop.route`, `--split tune|holdout|all`
(default all), `--providers ...`, `--run-id NAME`, and `--resume`. A holdout-only
run without tune results reports production thresholds with `no_tune_data`; to
continue a tune run, reuse its run id with `--split all --resume`.

Each run owns `results/<run_id>/lock` exclusively. A concurrent writer refuses;
a dead-pid lock is reported as stale and must be inspected and removed by the
operator. The append-only `journal.jsonl` fsyncs reservations and completed calls;
a torn final line is truncated before appending, while corrupt earlier records
refuse replay. Saved answers bind provider, expected and served model, site,
item, set digest, and exact request digest. Changed bindings are re-asked; older
cost remains charged. Every completed attempt is charged once. SIGINT/SIGTERM
abort in-flight calls, record cancellation, render partial results and exit
nonzero. A cancelled item is never recorded as an answer.

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
recall, and multi-entry counts (#140). Any looser guard or D5 setting is marked
`not_applied: needs captain (#142)`; every candidate remains descriptive.
Generated artifacts from fake runs are explicitly labelled `fake` /
`offline-fake` and are not live provider evidence. The crewmate records live
results after the offline implementation is reviewed.
