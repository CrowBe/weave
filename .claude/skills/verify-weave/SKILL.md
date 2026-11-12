---
name: verify-weave
description: Launch and drive Weave's Tapestry web workspace (the read-only browser UI served by `npm run host:workspace`, packages/tapestry-web) in an isolated Vite dev server and headless Chrome, then capture screenshots, accessibility snapshots, and DOM state as proof. Use this to prove a change to packages/tapestry, packages/tapestry-web, or the workspace view works in the real UI. Do not use it for runtime, gateway, or benchmark behavior, which have no UI.
---

# Verify Weave (Tapestry web workspace)

Weave is a TypeScript agent-runtime monorepo. The only surface a user touches in a browser is the **Tapestry web workspace**: one page titled `Weave Tapestry` that paints fixture `WorkspaceView`s through `@weave/tapestry`. It is read-only by design. It has no backend, persistence, auth, or network calls beyond its own Vite origin. All UI state (theme, fixture, selection) lives in React memory and resets on reload.

Other surfaces are not covered here. They are the `npm run example:*` CLIs (most need provider API keys; `example:crystallize` runs offline), the library packages (proved by `npm test`), and `benchmarks/` (see `AGENTS.md` "Benchmark evidence" before running any).

Everything goes through one helper, a dependency-free Node script that speaks the Chrome DevTools Protocol:

```bash
H=.claude/skills/verify-weave/bin/weave-verify.mjs   # run from the repo root
```

Requirements: Node >= 22.18 (it uses the global `WebSocket` and `fetch`), `npm ci` already done, Linux `/proc` (for port and process ownership), and Chrome or Chromium on `PATH` (`google-chrome-stable`, `google-chrome`, `chromium`, or `chromium-browser`; override with `WEAVE_VERIFY_CHROME=/path`).

## Launch

```bash
$H launch                 # or: $H launch --run my-run-id
export WEAVE_VERIFY_RUN=<RUN printed on the first line>
```

`launch`:

1. Runs `npm run build` (`tsc -b`). The web host resolves `@weave/tapestry` from `packages/tapestry/dist`, so a stale or missing build would paint old code.
2. Starts the repo's own workspace host command on a free loopback port, in its own process group: `npm run dev -w @weave/tapestry-web -- --host 127.0.0.1 --port <free> --strictPort`.
3. Starts headless Chrome with a disposable profile and a DevTools port, both on free loopback ports, at a 1440x900 viewport.
4. Navigates to the app and waits until the page is usable. The tab title must be `Weave Tapestry`, `[data-testid="shell"]` must exist, and `[data-testid="project-name"]` must have text. An HTTP 200 alone is not enough.

Ready signal: the last stdout line is `READY url=http://127.0.0.1:<port>/ vitePid=… chromePort=… chromePid=…`, and the exit code is 0. A typical launch takes 2–5 s. There is no data dir, migration, or seed step: the seed data is the two built-in fixtures in `packages/tapestry-web/src/fixtures.ts`.

If launch exits non-zero, it prints the cleanup command. Run it before you retry.

Teardown is `$H cleanup` (see Cleanup).

## Doctor

Run it first, and again whenever anything looks off. It only reads.

```bash
$H doctor        # exit 0 = worth driving; exit 1 = read the failed check
```

It checks that:

- The vite process is alive.
- The vite port's listener belongs to this run's process group, not to someone else's server.
- The URL serves `<title>Weave Tapestry</title>`.
- `git HEAD` still equals the launch HEAD.
- `packages/tapestry/dist` is not older than `packages/tapestry/src`.
- Chrome is alive and owns its DevTools port.
- The page tab is on this run's URL, and the shell rendered.

A failed HEAD or dist check means you are about to prove the wrong build: clean up and relaunch.

## Drive

Each `browser` call attaches to this run's tab, performs one action, prints JSON, and appends `{at, action, flags, result}` to the run's `actions.jsonl`. The tab persists between calls.

| Action           | Command                                                                                        | Notes                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh page       | `$H browser goto`                                                                              | Reloads. Resets theme, fixture, and selection to Default, Omitted slice, and none.                                                                                                                                                                                                                                            |
| Click            | `$H browser click --role button --name "Daylight"`, or `--testid theme-daylight`               | Real mouse events at the element centre, after scrolling it into view. Prints the element's `aria-*`/`data-*`/`disabled` attributes and focus before and after. Add `--nth N` when a handle matches more than one element.                                                                                                    |
| Keyboard         | `$H browser press --key Tab` (`--shift`), `Enter`, `Space`, `Escape`                           | Prints the newly focused element.                                                                                                                                                                                                                                                                                             |
| Read state       | `$H browser state`                                                                             | JSON with: project, session, revision, theme; shell `data-theme`/`data-density`/`data-selection`; regions (the resolved tree); the pressed Theme and Fixture segments; observation rows (aria-hidden marks excluded); withheld conditions; approval count; digests open; decision controls disabled; operator input disabled. |
| Read one element | `$H browser text --testid project-name`, or `$H browser attr --testid shell --attr data-theme` |                                                                                                                                                                                                                                                                                                                               |
| Wait             | `$H browser wait --testid observation --nth 2`, or `$H browser wait --text "3 observations"`   | `--timeout ms`, default 10000.                                                                                                                                                                                                                                                                                                |
| AX snapshot      | `$H browser snapshot --path <name>.aria.txt`                                                   | Indented `role "name" [pressed= disabled= expanded=]` tree.                                                                                                                                                                                                                                                                   |
| Screenshot       | `$H browser screenshot --path <name>.png`                                                      | Viewport PNG.                                                                                                                                                                                                                                                                                                                 |
| Viewport         | `$H browser viewport --width 900 --height 1000`                                                | Resizes the window, and the size persists across calls and `goto`. Below 1024 px (`lg`), the layout stacks: header, Drawer and Cut-through, Navigation, Conversational surface. Restore with `--width 1440 --height 900`.                                                                                                     |
| Network          | `$H browser network`                                                                           | Every origin the page loaded from. `foreign` must be `[]`.                                                                                                                                                                                                                                                                    |

Relative `--path` values land in the run's evidence dir.

Stable handles, preferred in this order:

1. ARIA role and name, which appear in `snapshot` output.
2. `data-testid`, listed in `packages/tapestry-web/src/host.tsx` and `src/paint/*.tsx`.

Never use coordinates. The feature map has the exact handles per journey: [features/README.md](features/README.md).

## Evidence

Evidence lives in `.local/verify-weave/<RUN>/` at the repo root. `.local/` is git-ignored, and cleanup never deletes this directory. Each run produces:

- `launch.json`: HEAD, dirty flag, ports, PIDs, Chrome version, ready time.
- `build.log`: `npm run build` output and exit code.
- `actions.jsonl`: every doctor/browser/cleanup call with its result. This is the action-and-result log.
- `vite.log` and `chrome.log`: copied in at cleanup.
- `cleanup.json`: what was stopped and whether the ports were released.
- Whatever you write with `--path`, for example `<feature>/<step>.png` and `.aria.txt`.

Proof standards:

- Drive the real user path: clicks and keys on the rendered controls. Do not call React setters, edit `fixtures.ts`, or run page JS to mutate state. `state` and `network` only read.
- Capture the action and the resulting state. For each step, record a `state` JSON (or `attr`/`text`) before and after, plus an AX snapshot and a screenshot of the end state. A final screen alone is not proof.
- Side effects: this UI has no persistence or outbound effects by contract (`Decision controls are unavailable…`, `Input is unavailable…`). Prove the absence: `network` shows no foreign origin, and the decision controls stay `disabled`.
- No mocks are involved. The fixtures are the app's own shipped seed data.

## Cleanup

```bash
$H cleanup       # uses WEAVE_VERIFY_RUN or --run
ls .local/verify-weave/$WEAVE_VERIFY_RUN   # evidence must still be there
```

Cleanup works only from the run's `state.json`. It sends SIGTERM (then SIGKILL after 8 s) to the vite and Chrome process groups that this run started. It refuses any PID that is not a group leader or whose command line lacks this run's marker. It never kills by name. It then copies the logs into the evidence dir, deletes the scratch dir (`$TMPDIR/weave-verify/<RUN>/`, which holds the Chrome profile, state, and logs), and verifies that no listener from those groups remains. It exits non-zero if anything was refused or still listening. A listener that belongs to someone else on a reused port is reported under `foreignListeners` and left alone.

Run cleanup after every failed attempt too. Use `$H runs` to list leftover scratch runs and whether their processes are alive.

## Isolation

- Parallel runs are safe. Each run gets its own free ports, Chrome profile, and scratch dir. Never pass `--port 5173`, and never drive a workspace you did not launch: the user's `npm run host:workspace` uses 5173, and `doctor` fails if the port is not owned by your run.
- Two things are shared with the checkout. `launch` runs `npm run build` into the shared `dist/` folders, so do not launch while another agent is mid-build. The Vite dev server also hot-reloads source edits from the checkout. If someone edits `packages/tapestry*` during your run, your page changes under you. Re-run `doctor` and `goto` after any edit, and capture evidence after the last edit.

## Helpers

- `bin/weave-verify.mjs` (executable). Usage: `weave-verify.mjs launch|doctor|browser <action>|cleanup|runs [--run <id>]`, with flags as shown above. It has no dependencies. Its header comment repeats the usage.
