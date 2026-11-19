# Working on the Weave MVP

The active application is in `mvp/`. Read the acceptance cases and authority boundaries in the root README before changing the loop. The previous experiment and its vocabulary are in `legacy/` for reference.

Keep model output as evidence. The runtime owns every transition and the authenticated operator approves one exact effect. Preserve scoped reads, stale-result handling, durable intent and receipt reconciliation. Demonstrate a failing behavioural check before implementing a change. Run the deterministic tests and the local workerd integration check before sign-off.
