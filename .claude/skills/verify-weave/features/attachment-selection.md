# Attachment selection

Navigation lists the project's attachments with their kind. Choosing one marks it as the session's selection, with a highlighted row and `aria-pressed=true`, without disclosing its body or submitting anything.

## Sub-features

- `select-attachment`: choosing `Brief` sets the selection to `Brief`.
- `select-move`: choosing `Field repository` moves the selection, and only one row is pressed.
- `select-idempotent`: choosing the selected row again keeps it selected. There is no deselect.
- `select-survives-fixture`: the selection survives a Fixture or Theme switch.

## How to get to it (user POV)

- Click an attachment row under `Attachments` in Navigation.
- From a fresh page, press Tab five times to focus `Field repository` (six times for `Brief`), then press Enter.

## Driving it with weave-verify

Preconditions:

- Baseline state (`$H browser goto`): `shell.selection` is `""`, and both rows have `pressed` `"false"`.

- **Select Brief.** `$H browser click --role button --name "Brief document"`. `$H browser state` has `shell.selection` `Brief`, and `attachments` `[{"label":"Field repository","pressed":"false"},{"label":"Brief","pressed":"true"}]`.
- **Select again.** `$H browser click --role button --name "Brief document"`. `shell.selection` is still `Brief`.
- **Move selection.** `$H browser click --role button --name "Field repository repository"`. `shell.selection` is `Field repository`, and only that row has `pressed` `"true"`.
- **Survives fixture switch.** `$H browser click --role button --name "Recorded observations"`. `shell.selection` is still `Field repository`.
- **No disclosure or submission.** The Conversational surface content is unchanged by selection (compare `observations` before and after), and `$H browser network` shows `foreign` `[]`.
- **Proof.** `$H browser snapshot --path attachment-selection/selected.aria.txt` shows `button "Field repository repository" [pressed=true]`. `$H browser screenshot --path attachment-selection/selected.png` shows the accent bar on that row.

## Gotchas

- The accessible name includes the kind (`"Brief document"`), because the kind text is inside the button.
- The rows have no `data-testid`. Use role and name.
- There is no way to clear a selection except `goto` or a reload.
