# Weave Tapestry workspace verification map

This directory is the maintained source for verifying the user-facing behavior of the Tapestry web workspace (`npm run host:workspace`, `packages/tapestry-web`). Read this index before you drive the app. Then use the matching feature file as the recipe.

## Baseline preconditions

- `H=.claude/skills/verify-weave/bin/weave-verify.mjs` from the repo root.
- `$H launch` printed `READY …`, and `WEAVE_VERIFY_RUN` is set to its `RUN=` value.
- `$H doctor` exits 0. Never drive an instance this run did not launch, and in particular not a user's server on port 5173.
- `$H browser goto` gives the baseline state:
  - Theme `Default` (`theme.weave-default`).
  - Fixture `Omitted slice`.
  - No attachment selected (`data-selection=""`).
  - Window 1440x900.
- Seed data is the two shipped fixtures in `packages/tapestry-web/src/fixtures.ts`. Both show project `Field notes`, revision `18`, session `session-field`, attachments `Field repository` (repository) and `Brief` (document), and one pending request `req-publish` (`report.publish`, sequence 12). `Recorded observations` also discloses observations 1, 4, and 9. Do not edit the fixtures to make a journey pass.

## Driving conventions

- Start every recipe with `$H browser goto` unless its preconditions say otherwise.
- Prefer `--role <role> --name "<accessible name>"`, as printed by `$H browser snapshot`, then `--testid`. Never use coordinates.
- Treat commands as literal. Accessible names include the trailing kind text, for example `"Field repository repository"`.
- All UI state is in memory. A `goto` resets it, and there is nothing to restore afterwards except the window size if you changed it.

## Proof and skip reporting

- Capture the user action and the resulting state. Every `browser` call is logged with its result in `.local/verify-weave/$WEAVE_VERIFY_RUN/actions.jsonl`. Also take `state` before and after, plus an end-state `snapshot` and `screenshot` under `<feature-id>/`.
- UI proof includes an AX snapshot and a screenshot with the header visible (`Field notes`, the session, revision, and theme).
- "No effect" proof: `$H browser network` shows `foreign: []`, and disabled controls stay `disabled` after a click.
- Record the feature file and entry point (mouse or keyboard) used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a keyboard entry point as verified through a mouse click.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then has exactly four H2 sections, in this order:

1. `Sub-features`: short IDs, one line per behavior.
2. `How to get to it (user POV)`: every user entry point.
3. `Driving it with weave-verify`: starts with `Preconditions:`, then labeled bullets pairing each action with an exact command and an observable result.
4. `Gotchas`: traps that can waste or invalidate a run.

## Features

- [Workspace shell](./workspace-shell.md) covers the header identity, the five regions, the pending-request link, and the responsive stacking.
- [Theme switch](./theme-switch.md) covers the Default and Daylight paint themes, by mouse and keyboard.
- [Observation disclosure](./observation-disclosure.md) covers the Fixture switch between a withheld observations slice and the recorded observation table, plus the unavailable operator input.
- [Attachment selection](./attachment-selection.md) covers selecting a project attachment in Navigation.
- [Pending authority request](./pending-authority-request.md) covers the approval card facts, digest show and hide, and the unavailable Approve and Deny controls.
