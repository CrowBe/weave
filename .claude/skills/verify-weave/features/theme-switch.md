# Theme switch

The Theme segment control in the header lets a user repaint the workspace in `Default` (dark, comfortable density) or `Daylight` (light, compact density) without ending the session or losing the current fixture or selection.

## Sub-features

- `theme-daylight`: choosing `Daylight` sets theme `theme.weave-daylight` and density `compact`, and presses the `Daylight` segment.
- `theme-default`: choosing `Default` restores `theme.weave-default` and density `comfortable`.
- `theme-keeps-session`: switching theme keeps the fixture, the selection, and `sessionEnded=false`.
- `theme-keyboard`: Tab to a segment, then press Enter.

## How to get to it (user POV)

- Click `Default` or `Daylight` in the header group labelled `Theme`.
- From a fresh page, press Tab twice to focus `Daylight`, then press Enter.

## Driving it with weave-verify

Preconditions:

- Baseline state (`$H browser goto`): theme `Default`.

- **Before.** Run `$H browser state`. `theme` is `theme.weave-default`, `shell.density` is `comfortable`, and `pressedTheme` is `["Default"]`.
- **Choose Daylight.** `$H browser click --role button --name "Daylight"`. In the click output, the `after.attrs.aria-pressed` value is `"true"`. `$H browser state` then has `theme` and `shell.theme` `theme.weave-daylight`, `shell.density` `compact`, and `pressedTheme` `["Daylight"]`.
- **Keeps session.** `$H browser click --role button --name "Recorded observations"`, then `$H browser click --role button --name "Brief document"`. `state` still has `theme.weave-daylight`, with `shell.selection` `Brief` and `shell.sessionEnded` `false`.
- **Back to Default.** `$H browser click --testid theme-default`. `state` has `theme.weave-default` and `density` `comfortable`, and the selection is still `Brief`.
- **Keyboard.** `$H browser goto`, `$H browser press --key Tab` (focus moves to `theme-default`), `$H browser press --key Tab` (focus moves to `theme-daylight`), then `$H browser press --key Enter`. `state` has `theme.weave-daylight`.
- **Proof.** `$H browser screenshot --path theme-switch/daylight.png` and `$H browser snapshot --path theme-switch/daylight.aria.txt`. The snapshot shows `button "Daylight" [pressed=true]`, and the screenshot shows the light palette with `theme theme.weave-daylight` in the header.

## Gotchas

- Theme is in-memory session paint state. `goto` or a reload returns to `Default`, so do not use a reload to "confirm persistence".
- `data-theme` on the shell and the `theme-id` header text both change. Assert both, because a CSS-only change would update neither.
- Two different groups each contain a pressed segment. Read `pressedTheme`, not `pressedFixture`.
