# Workspace shell

The workspace shell is the single page a user lands on. It names the project, session, revision, and theme in the header, and lays out five regions: Navigation, the Conversational surface, the Secondary strip, the Drawer, and Cut-through. The layout stacks on narrow windows.

## Sub-features

- `shell-identity`: the header shows `Field notes`, `session session-field`, `revision 18`, and `theme theme.weave-default`.
- `shell-regions`: Navigation holds the attachments, the Conversational surface holds the thread, the Secondary strip reads `Nothing in the secondary strip`, the Drawer reads `collapsed`, and Cut-through reads `1 pending`.
- `shell-pending-link`: the `Pending authority requests 1` link in Navigation jumps to Cut-through.
- `shell-responsive`: below 1024 px the regions stack in this order: header, Drawer and Cut-through, Navigation, Conversational surface.

## How to get to it (user POV)

- Open the workspace URL printed by `launch`, which is the same page as `npm run host:workspace` on 5173.
- Choose the `Pending authority requests` link in Navigation.
- Narrow the browser window below 1024 px.

## Driving it with weave-verify

Preconditions:

- Baseline state (`$H browser goto`), with `$H doctor` passing.

- **Identity.** Read the header: `$H browser state`. The output has `title` `Weave Tapestry`, `project` `Field notes`, `session` `session-field`, `revision` `18`, and `theme` `theme.weave-default`.
- **Regions.** Use the same `state`. `regions` is `nav` `project.index@1`, `main.primary` `conversation.thread@1`, `main.bottom` empty with `Nothing in the secondary strip`, `right.drawer` `collapsed`, and `cut-through` holding one `approval.pending@1` with `request_id` `req-publish`. Confirm these are painted with `$H browser snapshot --path workspace-shell/regions.aria.txt`, which shows the `banner`, `navigation`, `main`, and `complementary` landmarks and the headings `Conversational surface` and `Cut-through`.
- **Pending link.** Choose the link: `$H browser click --role link --name "Pending authority requests 1"`. `$H browser state` then has a `url` ending in `#cut-through`.
- **Responsive.** Narrow the window: `$H browser viewport --width 900 --height 1000`, then `$H browser screenshot --path workspace-shell/narrow.png`. The screenshot shows Drawer and Cut-through above Navigation, with the Conversational surface last. Restore the window: `$H browser viewport --width 1440 --height 900`.
- **No outbound traffic.** Run `$H browser network`. `foreign` is `[]`.
- **Proof.** `$H browser screenshot --path workspace-shell/baseline.png` and `$H browser snapshot --path workspace-shell/baseline.aria.txt`.

## Gotchas

- At 1440 px the pending link changes only the URL hash. Cut-through is already visible, so a screenshot alone does not prove the jump. Assert `url`.
- `viewport` resizes the real window and persists across `goto`. Restore 1440x900 before the next journey.
- The AX tree announces the raw region JSON as a `StaticText` under `banner`, from the screen-reader-only `tree-key` span. That is current behavior, not a driver artifact.
- The drawer always reads `collapsed` with the shipped fixtures. No user control expands it.
