# WV-234 review follow-up

Contract: when a file claim vanishes between `lstatSync` and reading its token,
rescan the reclaim generation instead of reporting an unverifiable owner.
Existing claims with malformed or foreign tokens still fail closed. The claim-slot
protocol, liveness rules, permissions, and wait bounds remain unchanged.

The regression tests remove either the file claim or its whole reclaim generation
immediately after `lstatSync`, before the token read. Both must allow recovery
without sleeping, using an injected, non-advancing clock. Both failed with
`blockedReclaim` before the implementation change.

Accepted residual for review finding 2: backing out still checks our token before
unlinking our claim slot by pathname. A concurrent replacement of the reclaim
generation between that check and unlink can redirect the path to a successor's
slot. The invariant remains **never delete another owner's claim**; this window
is a known limitation, not permission to delete a foreign claim. Comparing the
directory's device/inode before unlink would narrow the window but would not
make the operation atomic. Closing it fully needs a separate design for deletion
relative to a stable directory identity; this follow-up retains the existing
protocol and records the residual in the cleanup code as well.

The existing conservative assumption remains: a foreign boot or PID namespace,
including after reboot or container restart, leaves ownership unknown and requires
operator intervention.

Validation: both new cases demonstrated red with `blockedReclaim`, then green.
The full Fabric store test file, `npm run fmt:check`, every `checks/*.mjs` script,
all typechecks, and the web build passed. `npm run verify` was executed but stopped
at unchanged check-fixture tests: captured Node subprocesses report `EPERM` and
empty output in this sandbox, while the same checks pass when run directly.
Running every remaining verify stage separately found the previously documented
subprocess and loopback-listener restrictions: `npm test` passed 96 of 103 test
files; `task-acceptance:offline` and `test:decision-sites` also fail subprocess
tests. The remaining stages passed. No checks or permissions were weakened.
