# Observation disclosure

The Conversational surface shows the recorded observations of the workspace view only when that slice is disclosed. The header `Fixture` control switches between `Omitted slice`, where the slice is withheld by policy and a withheld condition is shown, and `Recorded observations`, which shows a table of sequence, type, provenance, validation, and cause. The operator input below it is always unavailable.

## Sub-features

- `disclosure-omitted`: with `Omitted slice`, the surface shows `Withheld: observations (policy)` and no observation count.
- `disclosure-recorded`: with `Recorded observations`, the header reads `3 observations` and the table has rows `1 goal.opened operator accepted none`, `4 source.registered untrusted accepted none`, and `9 action.started runtime accepted a:1:1`.
- `disclosure-back`: switching back to `Omitted slice` withholds the slice again, and no rows remain.
- `disclosure-keeps-other-slices`: project, attachments, and the pending request are identical in both fixtures.
- `operator-input-unavailable`: the `Operator input` textbox is disabled and explains `operator.input has no trusted ingress contract`.

## How to get to it (user POV)

- Click `Omitted slice` or `Recorded observations` in the header group labelled `Fixture`.
- From a fresh page, press Tab four times to focus `Recorded observations`, then press Enter.

## Driving it with tapestry-verify

Preconditions:

- Baseline state (`$H browser goto`): fixture `Omitted slice`.

- **Withheld state.** `$H browser state`. `pressedFixture` is `["Omitted slice"]`, `withheld` is `[{"id":"observations-omitted","text":"Withheld: observations (policy)"}]`, `observations` is `[]`, and `observationCount` is `null`. Capture `$H browser snapshot --path observation-disclosure/omitted.aria.txt` and `$H browser screenshot --path observation-disclosure/omitted.png`.
- **Disclose.** `$H browser click --role button --name "Recorded observations"`. In the click output, `after.attrs.aria-pressed` is `"true"`. Then run `$H browser wait --text "3 observations"`.
- **Recorded state.** `$H browser state`. `pressedFixture` is `["Recorded observations"]`, `withheld` is `[]`, and `observationCount` is `3 observations`. `observations` equals `[["1","goal.opened","operator","accepted","none"],["4","source.registered","untrusted","accepted","none"],["9","action.started","runtime","accepted","a:1:1"]]`. The `project`, `attachments`, and `approvals: 1` values are unchanged from the withheld state. Capture `$H browser snapshot --path observation-disclosure/recorded.aria.txt` and `$H browser screenshot --path observation-disclosure/recorded.png`.
- **Withhold again.** `$H browser click --testid fixture-omitted`. `state` has the `observations-omitted` withheld entry and `observations` `[]` again.
- **Operator input.** `state` has `operatorInputDisabled` `true`. The snapshot shows `textbox "Operator input" [disabled=true]` and the text `has no trusted ingress contract.`
- **No outbound traffic.** `$H browser network` shows `foreign` `[]`.

## Gotchas

- Provenance and validation cells carry `aria-hidden` marks (`op`, `??`, `rt`, `yes`). `state` excludes them. Raw `textContent` would read `opoperator`, so do not assert on it.
- `observationCount` is the header count text. In the withheld state it is absent (`null`), not `0 observations`.
- The `Fixture` control is a developer fixture switch that ships in the host page. It is how a user reaches the disclosed view today, because there is no runtime-backed view in the web host.
- The operator textbox is disabled, so typing into it is not a valid journey. Assert the disabled state and its description instead.
