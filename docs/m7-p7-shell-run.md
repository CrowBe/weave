# M7 P7 — shell.run@1

This note records the P7 shell-out contract. It does not change the decision
sites. Terms follow [GLOSSARY.md](../GLOSSARY.md). The behavioural target
remains [m7-decision-loop.md](m7-decision-loop.md).

## Contract

`shell.run@1` is an AgentSOP contract. Fabric supplies the one implementation.
The loop shells out only through `host.invoke(grant, …)`. A decision answer is
an observation. It is not a grant, and `GrantAuthority` will not treat one as
issued.

```text
input    { argv, cwd_ref, env_allow, timeout_ms, stdin? }
output   { exit, stdout_tail, stdout_truncated, stderr_tail, duration_ms, artifacts }
effects  process.spawn, fs.write:<cwd_ref>
failures timeout | denied | spawn_failed | cancelled
```

`argv` is spawned directly (`shell: false`). There is no interpolation.
`cwd_ref` is a workspace resource reference. The locator stays in the host.
`env_allow` is a list of variable names. The composition root's env port
supplies values. The host does not copy `process.env`. A value is refused
when it already appears on `argv` or `stdin`, and it is redacted from tails,
traces, and error text. A value shorter than 8 characters, including an
empty one, is `DENIED` before any spawn. Matching it would refuse or redact
ordinary text (`1`, `test`), and skipping it would leak it. Redaction
replaces only a whole value, never a fragment of one. A name the env port does
not supply is not injected. Grant mismatch, a forged grant, and a decision-shaped
object are `DENIED` before any spawn.

Resource effects still carry `write` on `cwd_ref`, so the host locks that
workspace. Process-effect tokens are an additional exact set on the grant:
`process.spawn` and `fs.write:<cwd_ref>`. Missing either token is denial.
Adding a process effect is a vocabulary revision (`PROCESS_EFFECT_VOCABULARY_REVISION`).

Stdout and stderr tails keep the last 4096 characters (configurable up to 65,536).
`stdout_truncated` records whether stdout was discarded before redaction. New files inside the
workspace come back as resource references, not locators. `duration_ms` is
read from the injected clock. Timeout and cancel abort that same injected
timer and then signal the process group on POSIX (`SIGTERM`, then `SIGKILL`
after 30 ms). On Windows the direct child is signalled. The post-kill stdio
drain is bounded to 100 ms, so inherited pipes cannot retain the workspace lock.

`cancelled` is the failure when the invocation is cancelled. It is not a
timeout. A missing executable is `spawn_failed`. A process that runs and
returns a status, including a nonzero status, is a succeeded invocation
whose `exit` is that status.

## Derived commands

`repo.test`, `repo.lint`, and `repo.build` depend on `shell.run@1`. Their
inputs have no `argv`. The host runs the argument vector from its
configuration. An input that tries to pass `argv` is `INVALID_INPUT` and
does not spawn.

They do not take a second effect lock. The parent invocation already holds
`write` on the workspace, and a nested `shell.run` acquire would conflict
with that hold. The host runs the same spawn path under the parent grant.
The trace records both: the repo operation with `parentId: null`, and a
`shell.run@1` child whose `parentId` is the parent id. Nested authority is
the parent's grant, not a grant minted from a decision answer.

## CLI generate backends

`codex exec`, `claude -p`, and `grok` are gateway generate adapters. The
fixed vendor argv is the default (`['codex', 'exec']`, `['claude', '-p']`,
`['grok']`). The prompt, including instructions, is the stdin body. The
model id is not an argument. The adapter does not spawn. It calls a
`CliSpawn` port. `createGrantedCliSpawn` is the composition-root
implementation: one `GrantAuthority.issue` and one `host.invoke` per call.

Exit status and spawn failures map onto the gateway's existing provider
failures:

| Spawn result | Provider failure |
|---|---|
| `timeout` | `timeout` |
| `cancelled` | `cancelled` |
| `denied` | `unauthorized` |
| `spawn_failed` | `unavailable` |
| exit nonzero | `unavailable` (`exited N`) |
| exit 0, stdout truncated | `unavailable` (`cli generate stdout was truncated`), non-retryable |
| exit 0, stdout intact | completed text is the full stdout body, with `stop` |

Tests drive stub scripts. They do not execute the real `codex`, `claude`,
or `grok` binaries and they do not use the network.

## pi --mode rpc

Not included. `pi --mode rpc` is a long-lived JSONL worker: one command per
line on stdin (`{"id","type":"prompt","message"}`), responses and events on
stdout, strict LF framing, and a process that stays up until a later
command shuts it down. A generate adapter that spawned it once per call
would still need a shutdown command and an event reducer, and a worker that
lives across a step needs somewhere to hold it. That does not fit the
one-grant, one-spawn path. P8's implementation-tier step is the place for a
persistent worker.

What this PR does take from that note is the trace shape. Each shell-out is
a JSONL record, schema `shell.trace@1`, with `id` and `parentId`, fixed key
order, argument vector, environment names, and no environment values.
`shellTraceJsonl()` on the Fabric host returns that text. Loom's journal
does not yet append it. Folding these records into the loop trace stays
with the later implementation and audit work, which is outside P7.

## Where spawning lives

`child_process` is used by the Fabric host (`process-spawn.ts`) and by the
existing isolation probe. Gateway adapters and AgentSOP do not spawn.
Time enters through the host's injected clock and timer, the same rule as
the rest of the runtime.
