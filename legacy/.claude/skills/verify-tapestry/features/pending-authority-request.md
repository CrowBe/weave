# Pending authority request

Cut-through shows each pending authority request as a card. The card shows the operation, contract revision, destination, effects, expected revision, reservation, valid ticks, and the binding and report digests, which can be expanded. Approve and Deny are visible but disabled, because the component has no bound submission path.

## Sub-features

- `approval-facts`: the card shows `Pending authority request`, `sequence 12`, `report.publish`, `r1`, `ref_3`, `write ref_3`, expected revision `1`, `1 action · 0 judgments`, and `0–8`.
- `approval-digest-toggle`: each digest summary toggles between a short preview (`aaaaaaaa…aaaaaaaa`) with `show` and the full 64-character value in 8-character chunks with `hide`.
- `approval-decision-unavailable`: Approve and Deny are disabled, and the card explains `Decision controls are unavailable. This component has no bound submission path.`
- `approval-count`: the Cut-through header reads `1 pending`, matching the Navigation link count.

## How to get to it (user POV)

- Look at the Cut-through column on the right at 1440 px (it is at the top of the page below 1024 px).
- Choose `Pending authority requests` in Navigation.
- Keyboard: from a fresh page, press Tab eight times to focus the `Binding digest` summary (nine times for `Report digest`), then press Enter to toggle it.

## Driving it with tapestry-verify

Preconditions:

- Baseline state (`$H browser goto`). Both fixtures carry the same request, so either fixture works.

- **Facts.** Run `$H browser snapshot --path pending-authority-request/card.aria.txt`. It contains `heading "Pending authority request"`, term and definition pairs `Operation` / `report.publish`, `Contract revision` / `r1`, `Destination` / `ref_3`, `Expected revision` / `1`, `Reservation` / `1 action · 0 judgments`, and `Valid ticks` / `0–8`. `$H browser state` has `approvals` `1`.
- **Expand a digest.** `$H browser click --role DisclosureTriangle --nth 0`. `state.digests` has the `Binding digest` entry with `open` `true`. The snapshot names that summary `"Binding digest hide"`, with `[expanded=true]`.
- **Collapse it.** `$H browser click --role DisclosureTriangle --nth 0` again. `open` is `false`.
- **Keyboard toggle.** `$H browser goto`, then `$H browser press --key Tab` nine times, until the last output shows focus on a `summary` starting `Report digest`. Then `$H browser press --key Enter`. `state.digests` has the `Report digest` entry with `open` `true`.
- **Decisions unavailable.** `$H browser click --testid approve` and `$H browser click --testid deny`. Each click output still shows `disabled` in `after.attrs`, `state.decisionControls` shows both `disabled: true`, `approvals` is still `1`, and `$H browser network` shows `foreign` `[]`. `$H browser text --testid decision-unavailable` prints the explanation.
- **Proof.** `$H browser screenshot --path pending-authority-request/card.png` with the card and the expanded digest visible.

## Gotchas

- A digest summary's accessible name includes its current preview and `show` or `hide` text, so it changes when toggled. Address it with `--role DisclosureTriangle --nth 0` (Binding) or `--nth 1` (Report), not by name.
- Clicking a disabled button dispatches real mouse events but does nothing. That is the expected proof, so do not report it as a driver failure.
- The request is fixture data (`req-publish`). There is no runtime-backed approval flow in the web host to approve against. M1's approval flow is proved by package tests, not by this UI.
