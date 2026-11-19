# Weave

Weave uses a System 1 model to interpret a goal and choose a bounded action from current evidence. This branch tests that idea with a single household task. Find a shared hour for dinner next week, then report the options or ask for approval to place one calendar hold. A read-only request can finish as soon as the shared times are known.

## Try it

With Node 26 or later, run `npm start` and open **http://127.0.0.1:5186**. The local app starts with fixture decisions, two synthetic calendars and a persistent SQLite database. It runs with Node's standard library. The header identifies the active calendar and decision provider.

Submit the prefilled request. Choose an evening, reload the page, then approve. The receipt identifies the hold. Change **Demo availability** to try one or no matching evenings. To try a read-only request, enter “Find a free hour for dinner on our calendars next week after 6 pm.” Fixture mode recognises these requests and a few variants.

`PORT` selects the local port and `WEAVE_DATABASE` selects the SQLite file. The default file is `.local/calendar.sqlite`. Fixture holds occupy the chosen time on subsequent runs. Use a fresh database path for a fresh demonstration.

## What the loop owns

1. Store the request and its start time. Extract dinner, week, duration, time and requested operation. Reject unsupported constraints or uncertain evidence.
2. Weigh the next action. Split into two calendar reads, join their free times, and keep the earliest common hour on each Sydney evening. The scheduling window is next Monday through Sunday. The live calendar checks half-hour starts from 6:30 to 9 pm.
3. Weigh the results. A read-only search reports the shared evenings. A hold request with several matches asks for a choice. A single match becomes a proposal. An empty intersection finishes with that result.
4. Bind approval to the actor, revision and one exact slot. Recheck availability before writing. A changed slot triggers a new decision and a fresh proposal.
5. Persist an intent key before the write. After interruption, look for the calendar receipt. A verified receipt completes the goal. Repeated uncertain outcomes pause for a manual receipt check.

The runtime validates the model's chosen action against the observed state. Its action vocabulary is deliberately small. A structured trace at `/api/state` records decisions, confidence, receipts and reported model usage. The chat's Activity panel shows the steps. The previous Loom experiment is available in [legacy](legacy/README.md).

## Run the acceptance checks

```sh
npm test
node mvp/evaluate.mjs
npm ci --prefix mvp
npm run verify
```

The five synthetic evaluation cases cover zero, one and several shared evenings, read-only search and an unsupported request. Passing requires every case to reach its expected state with the expected number of holds. The unit and integration suites also exercise concurrent reads, cancellation, stale approval, uncertain writes, cold restart and forced Durable Object eviction.

## Live inference

The local host selects Workers AI when both `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are present. The token needs Workers AI access for that account. Supply these through the environment or a private env file.

```sh
node --env-file=/path/to/private.env mvp/evaluate.mjs --live
node --env-file=/path/to/private.env mvp/server.mjs
```

The live evaluation sends the five synthetic cases to Clairic and Clef and uses in-memory calendar fixtures. It outputs JSON with stage outcomes, elapsed time, actual token usage when reported and standard-rate cost estimates. The price estimate excludes account credits and promotional pricing. Use the live results to decide whether to expand the action vocabulary.

## Live calendar on the local host

For a single operator, set `CALENDAR_MODE=google`, `GOOGLE_ACCESS_TOKEN`, `GOOGLE_FIRST_CALENDAR`, `GOOGLE_SECOND_CALENDAR` and `GOOGLE_FAMILY_CALENDAR`. The bearer token needs free/busy access for all three calendars and event read/write access for the family calendar. Use a test family calendar for a first run. The operator supplies a fresh token when it expires. The web app displays Sydney times; the provider receives exact instants. All calendar references are configured server-side.

Google checks availability again immediately before event insertion. Another calendar client can still book the time between those calls. Reconciliation uses the same Google event ID across retries.

## Cloudflare target

The Worker serves the same assets and application through a SQLite-backed Durable Object per verified Access subject. Set `ACCESS_TEAM` to the team slug and `ACCESS_AUD` to the Access application's audience. A protected hostname and a route must be configured before deployment. The Worker checks the signed Access JWT and keeps each operator's fixture state private. It uses the Workers AI binding for inference. Real Google access is scoped to the local host until per-person credentials are implemented.

The Worker integration check bundles the application and runs it in workerd with signed test identities, isolated storage, fixture inference and forced eviction. Public deployment and household Google sign-in are separate stages.
