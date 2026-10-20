# Monty as an execution boundary for Fabric capabilities and Thread work

Research date: 2026-10-19. Answers the exploration questions in #21 (Monty as
the boundary between generated orchestration code and Fabric) and #29
(Monty-backed isolation for Thread work), read with #28 (Thread and process
lifecycle) and #30 (composable stack). Read against `VISION.md`,
`GLOSSARY.md`, `ARCHITECTURE.md` §5, §7, §8 and §11,
[agentfabric-concepts.md](../agentfabric-concepts.md),
[M3](../m3-fill-a-capability-gap.md), [M7 P7](../m7-p7-shell-run.md) and
`packages/agentfabric/src/isolate.ts`. This is an exploration note. It does
not change a contract, add a dependency, or decide a build.

Vocabulary. The issues say *AgentFabric resolver* and *sandbox*. In this note
they are a Fabric **implementation** reached through the **capability host**,
and an **execution tier** whose containment must be shown, not labelled.
*Thread* in #29 means the planned Thread with its own operating process from
#28. That process model is not yet specified. *Jev* is a model type that may
answer a **judgment site**; it is not the site.

## Evidence and limits

- **Source.** [pydantic/monty](https://github.com/pydantic/monty) at commit
  `e8db9aef41aa` ("v1.2.0 release prep", 2026-10-18), its `README.md` and
  `docs/` tree (security, host functions, snapshots, resource limits,
  filesystem, JavaScript quickstart, alternatives, limitations). Links below
  are pinned to that commit. The published docs site was not reachable from
  this environment.
- **Packages.** `@pydantic/monty@1.2.0` (npm, published 2026-10-18; 1.0.0 was
  2026-09-25) with its `@pydantic/monty-linux-x64-gnu@1.2.0` platform package,
  and `pydantic-monty==1.2.0` (PyPI). Installed only under a scratch
  directory, never in this repository:
  `npm install @pydantic/monty@1.2.0` in an empty project, and
  `uv venv && uv pip install pydantic-monty==1.2.0`.
- **Measured.** Nine small scripts (E1–E7 below, plus a Python cross-check)
  against the npm binding on Node v22.22.0, Linux x86_64, 4 vCPU, 16 GB RAM.
  The container ran as root. Other agents share the machine, so timings are
  indicative. Load average was 0.79 at the start of E7. The scripts are not
  committed. Each experiment below states enough to repeat it.
- **Not measured.** Full Monty, which is closed source and commercial. The
  WebAssembly build, macOS and Windows. Any attempt to escape the
  interpreter: no fuzzing, no adversarial review of the heap or mount code.
  Long-running soak. Jev or any routed unit producing Monty code. No live
  provider exists in this environment.
- **Labels.** *Measured* means observed here. *Documented* means Monty's own
  docs claim it and we did not verify it. The answer, mapping and
  recommendation sections are our inference from both, and cite which.

## Answer in brief

Monty is a **language-level** isolation layer. It is an interpreter for a
Python 3.14 subset, written in Rust, that implements no operation on the host.
Each session runs in a `monty` worker subprocess. Code reaches the host only
through what the embedding process hands it: host functions, wrapped host
objects, filesystem mounts and an `os` callback.

- **#21: a good fit for generated orchestration code.** Every capability call
  from the generated code stops the interpreter. The host sees the function
  name, the arguments and the source range before anything happens (measured,
  E2 and E3). That is the brokered resolver context that
  agentfabric-concepts §4.1 and M3 §5 ask for. Fabric stays the authority
  when each host function is a thin adapter over the capability host's
  `invoke` with a Loom-issued grant. Pause, persist, approve and resume at a
  call is cheap: a 4.3 KB dump, released worker, restore in a fresh session
  (measured, E3).
- **#29: only a partial fit for Thread work.** Monty can hold a Thread's
  orchestration state and pause it at capability calls. It cannot be the
  process boundary for code work. Running tests or builds executes the edited
  code natively through `shell.run@1` and `repo.test`, which Monty does not
  contain. It also runs no third-party packages and only a subset of Python
  (documented). Mutable work still needs an OS-level execution tier.
- **OS isolation is still required around the worker itself.** The worker
  has an empty environment but runs as the same user, with the same
  capabilities and namespaces, and no seccomp filter (measured, E1). Monty's
  docs say an escape gives the attacker that worker on the application host.

## What Monty is (documented)

| Property | Claim | Source |
| --- | --- | --- |
| Model | "A language-level sandbox, not an OS-level one. There is no container, no seccomp filter and no virtual machine." | [Security model](https://github.com/pydantic/monty/blob/e8db9aef41aa/docs/security.md) |
| Host reach | Opt-in only: host functions (`externalLookup`, `externalModules`), `ClassInstance`/`ClassType` wrappers, mounts plus an `os` callback. Each runs host code "with your process's full authority". | Security model; [host functions](https://github.com/pydantic/monty/blob/e8db9aef41aa/docs/host-functions.md) |
| Language | Python 3.14 subset. No class inheritance, generators, `del`, user exception classes, `compile`, `__import__` or third-party packages. Partial stdlib; `socket`, `subprocess`, `threading`, `ctypes` absent by design. | [Limitations](https://github.com/pydantic/monty/blob/e8db9aef41aa/docs/limitations/index.md) |
| Process | Native Python and Node bindings run each session in a `monty` worker subprocess. Workers spawn with an empty environment. The parent treats worker frames as untrusted. The Rust `monty` crate can run in-process. | Security model, crash isolation |
| Snapshots | `feedStart` suspends at every host call. `dump()` serializes the interpreter, paused stack included. Dumps are versioned CBOR behind a `MONTY\0` magic and are **not authenticated**. | [Snapshots](https://github.com/pydantic/monty/blob/e8db9aef41aa/docs/snapshots.md) |
| Limits | `maxMemory` (allocator bytes, not RSS), `maxFeedDurationSecs` and `maxTurnDurationSecs` (execution time only, paused during host calls), `maxRecursionDepth`, `maxSuspensions` (default 1000), `maxTotalSleepSecs`. Host backstops: `requestTimeout`, duration-limit grace. No session-lifetime budget. | [Resource limits](https://github.com/pydantic/monty/blob/e8db9aef41aa/docs/resource-limits.md) |
| Distribution | MIT. npm package depends on `@opentelemetry/api`, `@opentelemetry/api-logs` and `@bytecodealliance/preview2-shim`; unpacked sizes 25.2 MB plus 42.4 MB for the Linux x64 platform package. Full Monty (remote WebSocket workers with OS isolation) is a closed-source container image, and the TypeScript package cannot dial it. | npm registry; [Full Monty](https://github.com/pydantic/monty/blob/e8db9aef41aa/docs/server.md) |

## Experiments (measured)

### E1. Ambient reach and the worker process

One session, no host functions, no mounts. `E1_HOST_SECRET` was set in the
host's environment first. Then each probe was fed in turn, and the host read
`/proc/<workerPid>` for the worker's process facts.

| Probe | Result |
| --- | --- |
| `open('/etc/hostname')`, `Path('/etc/passwd').exists()`, `os.listdir('/')` | `PermissionError` |
| `os.getenv('HOME')`, `os.getenv('E1_HOST_SECRET')`, `os.environ`, `os.urandom(4)` | `RuntimeError: '…' is not supported in this environment` |
| `import socket`, `subprocess`, `urllib`, `ctypes` | `ModuleNotFoundError` |
| `__import__('os')`, `compile(...)` | `NameError` |
| `exec('y = 2')` | runs, inside the same limits |
| `class B(A)` | `NotImplementedError` at parse |
| `time.time()` | readable: the wall clock is on by default |
| Worker environment | empty (0 variables) |
| Worker uid, effective capabilities | identical to the host process (root, full capability set here) |
| Worker seccomp, `NoNewPrivs` | `0`, `0` |
| Worker net, mnt, pid, user, ipc namespaces | all shared with the host |
| Worker RSS after the probes | 10.8 MB |

The Python binding gave the same denials for `open`, `os.getenv` and
`import socket` (P1).

### E2. Capability calls as host functions

A toy host stood in for Fabric. It held a grant per session, issued opaque
`ref:` handles and exposed one `fabric` host module whose `invoke(capability,
input)` checked the grant held in its closure. Session A was granted
`doc.read`; session B, `doc.read` and `doc.write`, in the same pool.

- A read succeeded. A write was `PermissionError: DENIED doc.write`.
- A passed a grant-shaped keyword argument. The host saw the argument
  (`kwargs: ["grant"]`), ignored it, and denied the write.
- A passed `/etc/passwd` as a ref: `INVALID_INPUT`. An unknown ref was
  `DENIED`, the same as unauthorised, so refs are not an existence oracle.
- A could catch the denial as an ordinary `PermissionError`.
- A name the session was not given (`shell(...)`) was `NameError`; an
  unoffered module was `ModuleNotFoundError`. No host code ran.
- B's write, then A's read, showed one host and two capability sets.
- Python `dict` arguments arrive in JavaScript as `Map`. A Fabric adapter
  must convert them and reject unknown fields.
- With `typeCheck: true` and a `.pyi` stub on the module, a wrongly typed
  call was rejected before execution, with zero host calls.

### E3. Pause at a consequential call, persist, approve or refuse

The program read a document, built a draft and called
`fabric.invoke('doc.write', …)`. The host drove `feedStart` with
`resumeAuto()` until a `doc.write` call, dumped the snapshot and closed the
session.

- Suspensions seen before the pause: the `import fabric` OS call, then
  `doc.read`, then `doc.write`. The paused call carried its full input and
  its source text.
- Dump: 4,262 bytes in 6.8 ms. Restore into a fresh session: 18.4 ms, first
  in process. Only `doc.read` had run while paused.
- The restored session **re-announced** the same `doc.write` call. The host
  performed the write itself and resumed. Output: `wrote revision 2: HELLO!`.
- The same bytes restored into a second session (a fork) and resumed with
  `resumeError(PermissionError)`. The uncaught error ended the feed.
- A second `resume` of one snapshot: `Error: snapshot has already been
  resumed`.
- An idle-session dump (1,000-item list) was 7.8 KB and restored correctly.
- A flipped byte and a truncated blob were refused as malformed.
- **E3b.** We replaced `HELLO!` with `PWNED!` and `ref:doc-1` with
  `ref:doc-9` inside a dump without changing its length. The edited dump
  loaded, and the restored session re-announced
  `doc.write {ref: 'ref:doc-9', content: 'PWNED!'}`. Integrity is entirely
  the host's job, as the docs say.

### E4. Filesystem mounts

A temporary directory held a file and three symlinks: an absolute one and a
relative `../` one, both to a file in a sibling directory outside the mount,
and a relative one to the file inside. It was mounted at `/repo`.

| Case | Result |
| --- | --- |
| Read-only read | content returned |
| Read-only write | `PermissionError: [Errno 30] Read-only file system` |
| `/repo/../outside/secret.txt` | `PermissionError` (`..` collapsed in the virtual namespace) |
| Absolute symlink; relative symlink escaping the mount | `PermissionError` |
| Relative symlink inside the mount | followed |
| `Path('/repo').glob('*')` | escaping symlinks omitted |
| `resolve()` | virtual path `/repo/README.md`; no host path leaked |
| Overlay write, then read | read back within the feed; host directory untouched |
| Read-write write | written through to the host |

Overlay writes are discarded at the end of each feed and are not carried by
a dump (documented). We found no API to read them back. The JavaScript
`MountDir` documentation warns that a read-write mount inside a project lets
sandboxed code plant `.git/hooks/*`, `Makefile`, `.env`, CI config or
`node_modules` entries that trusted tools later execute.

### E5. Resource limits

| Setting | Program | Result |
| --- | --- | --- |
| `maxMemory` 10 MB | `[0] * 100_000_000` | `MemoryError` in 5 ms, pre-checked before allocating |
| `maxMemory` 10 MB | append in a loop | `MemoryError` in 12 ms. The next feed `1 + 1` also failed with `MemoryError`. |
| `maxFeedDurationSecs` 0.5 | `while True: pass` | `TimeoutError` at 500.6 ms. The next feed ran. |
| `maxSuspensions` 5 | ten host calls | five calls reached the host, then an uncatchable `RuntimeError` |
| `maxRecursionDepth` 50 | unbounded recursion | `RecursionError`, catchable |
| `maxFeedDurationSecs` 0.2 | `await slow()`, host waits 600 ms | completed at 609 ms: host time is not charged |
| pool `requestTimeout` 1 s, no limits | `while True: pass` | worker killed at 1,008 ms; `MontyCrashedError(timedOut=true)` |

Monty's docs say that after a memory or time limit fires, heap state carries
no guarantees and the session must be discarded. The pool does not do this.

### E6. Stopping running code, and capacity

- The JavaScript API has no cancel call for running bytecode. With a 30 s
  feed budget, `session.close()` during `while True: pass` did not stop the
  worker. Neither did `pool.close()`, 2 s later. Killing the worker by PID
  ended the feed as `MontyCrashedError(timedOut=false)`. `workerPid` is
  documented as a diagnostic that may be unavailable during a turn.
- In one run with no limits, our script called `process.exit()` while a
  runaway feed ran. Its worker was left re-parented to PID 1 at about 60% CPU,
  and was gone about 3 s after we sent it `SIGTERM`.
- Stopping at a suspension is clean: do not resume, then close. The worker
  returns to the pool (E3).
- `checkout()` waits forever by default once `maxProcesses` sessions are open.
  Two of our scripts hung on this until `checkoutTimeout` was set.

### E7. Overhead

Node binding, Linux x64, medians unless stated.

| Measure | Result |
| --- | --- |
| Pool create (one worker spawned and handshaken) | 4.7 ms first, 0.9 ms after |
| Checkout + `1 + 1` + close, warm pool, back to back | 0.28 ms (p90 0.54) |
| Same after 1 s idle | 0.89 ms (p90 1.15) |
| Feed on an open session | 0.09 ms |
| Feed with one host call | 0.20 ms; ten host calls 1.41 ms |
| Idle-session dump / load (12.6 KB) | 0.25 ms / 0.37 ms |
| Type checking on: first feed / later feeds / worker RSS | 838 ms / 0.64 ms / 23.1 MB (off: 0.66 ms / 0.25 ms / 8.0 MB) |
| Python binding: checkout + `1 + 1`, back to back | 0.14 ms (pool create, one sample: 449 ms) |

Concurrent sessions, one worker each. The workload was a 200,000-step loop,
a 2,000-item comprehension and one host call, about 31 ms on one worker.

| Sessions | Pool create | Check out all | Workload wall | Worker RSS idle (sum) | After work (sum) |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.6 ms | 2.4 ms | 31 ms | 5.4 MB | 10.0 MB |
| 4 | 9.8 ms | 3.8 ms | 87 ms | 22 MB | 39 MB |
| 16 | 73 ms | 9.1 ms | 181 ms | 87 MB | 158 MB |
| 64 | 180 ms | 8.4 ms | 1,047 ms | 352 MB | 631 MB |

Each worker is about 5.5 MB idle and about 10 MB after this small workload.
Work is CPU-bound, so beyond the core count throughput is shared, not added.
Monty's published figures (0.77 ms new sandbox, 5 ms new pool, about 2 MB per
worker) were measured on an Apple M3 Max. Ours are the same order of magnitude
for latency. Worker memory is higher here.

## #21: answers

**How cleanly can implementations be exposed as host functions?** Cleanly,
if the host function is never the implementation. Expose one host module per
session, generated from the offered contracts. Each function is a closure
that calls the capability host's `invoke` with the grant Loom issued for this
run, then returns the result or raises an exception carrying the AgentSOP
failure code. E2 showed the needed properties. The grant is bound host-side.
Arguments are plain data that the adapter validates as closed contract input.
References stay opaque. Un-offered names fail inside the interpreter. A
`.pyi` stub generated from the contract rejects ill-typed calls before they
run. Passing an implementation, a `read_file(path)` helper or a `ClassInstance`
over host state straight in would run that code with the host's full
authority and skip Fabric's pipeline. Mounts and the `os` callback are
path-level and bypass references, effect declarations and effect locks
(ARCHITECTURE §5). Leave them out of the first slice.

**Where should capability selection live?** See "Where capability selection
lives" below. In short: Fabric supplies eligibility facts and enforces each
call. Loom computes the deterministic eligible set within the goal's ceiling
and issues the grant. A judgment site may propose a narrower subset. Monty
only exposes what it is handed.

**Can Jev propose a least-surprising capability set?** Not measured here.
There is no Jev access and no labelled set of tasks with their right
capability sets. The shape that keeps it safe already exists in the D3
preselect policy: a closed offered set, top k with an optional floor,
required entries always kept, a margin gate that falls back to the full
index, and a selection record that confers no grant. Its answer can only
narrow what Loom offered. Whether it is *reliable* needs a benchmark with a
tune split and holdout, recorded as a Gauge evaluation result before any
default depends on it.

**How do approvals compose with a suspended execution?** Well (E3), with six
host obligations:

1. Bind the pending approval to the exact call: action, capability, contract
   revision, input digest and snapshot digest.
2. Store dumps in host-owned storage under a MAC. E3b shows an edited dump
   restores and asks for a different effect.
3. On restore, compare the re-announced call with the bound digest before
   dispatching anything.
4. Record the invocation identity before dispatch. A dump taken while the
   host was answering re-announces the call on restore, so a restore after a
   crash must go to outcome lookup, not run the effect again (ARCHITECTURE §5).
5. Track cumulative budgets outside Monty. The suspension count resets on
   restore, while the time budget travels (documented).
6. Re-supply what does not travel, and pin what does. Mounts, host objects,
   overlay writes and pending async futures are not in a dump. Record the
   Monty version in evidence: a dump-format bump refuses older dumps.

**What escape hatch is needed for discovery and crystallization?** None
inside Monty. Code there can only do what it was offered. The supervised
high-permission path in #21's lifecycle already exists as an ordinary action:
`shell.run@1` and the repo commands under an approved grant, in an OS-level
execution tier, and frontier inference under policy and budget. The concepts
doc already rejects a shell fallback inside Fabric. Monty adds useful gap
evidence. A `NameError` or `ModuleNotFoundError` at the host boundary, or a
denied call, comes with a name, an argument shape and a source range. Recorded
with a stable signature, that is the seed of an opportunity notice and a
capability gap. It is an observation of what generated code reached for.
Crystallization still begins with a contract.

**What OS-level isolation is still needed around host implementations?**
See "OS-level isolation still required" below. Monty narrows what generated
orchestration code can ask for. It does nothing for code that answers those
requests. Host implementations run in the embedding process.

## #29: answers

**Process and environment model.** One worker subprocess per checked-out
session, with an empty environment, a pool with `minProcesses`,
`maxProcesses` and recycling, and a `workerId`. State lives in the
interpreter's heap and persists across feeds. There are no file descriptors,
sockets or threads (documented; the empty environment and worker memory
were measured in E1 and E7). That maps well onto a
Thread's operating process from #28: explicit idle (between feeds), running
(in a feed), waiting (suspended at a host call) and paused (dumped, worker
released).

**Pause, resume and inspection ergonomics.** These are Monty's strongest
features for Loom. Every host call is an inspectable stop with name,
arguments and source position. A paused Thread costs a few kilobytes and no
process (E3, E7). One snapshot can fork several continuations.
Inspection between stops is limited: the host sees calls, results and printed
output, not the heap. To inspect variables, feed code that reports them.

**Filesystem, network and permission controls.** Nothing by default (E1).
Mounts are structurally confined (E4), but they are path-level. Read-write
mounts write untrusted files into the host tree, and overlay writes vanish at
feed end. Network exists only as host functions. The wall clock and entropy
are on by default and must be fixed through `osPolicy` for replay, consistent
with the no-ambient-clock rule.

**Overhead for several concurrent Threads.** Low per Thread: sub-millisecond
checkout, about 5.5–10 MB RSS per live worker, and zero processes for a paused
Thread (E7). Type checking costs about 0.8 s and about 15 MB extra on a
session's first feed. CPU-bound work shares the cores. Loom must treat worker
slots as a scheduler resource and set `checkoutTimeout` (E6).

**Can Loom reach into or expand a session without bypassing Fabric?** Yes,
if expansion happens only at a suspension and only through Fabric. An
`externalModules` record is read live, so a module added later is importable
by the next feed (documented). Our design does not rely on that. To widen a
running program's capability set, Loom should end the run at a suspension,
record the request as an observation, decide it through policy or approval,
and start the next feed with a new grant and module set. Reaching in with
`inputs`, mounts or the `os` callback would hand the program host state
outside Fabric and must not be used for capability expansion.

**Cheap isolation for mutable code and documents.** Partly. Document edits
expressed as Fabric `read` and `write` calls over references with
revision preconditions fit well. That is the existing `ResolverContext`
shape (`read(ref)`, `write(ref, expected_revision, content)`). Code work
needs builds and tests. Those are native processes in an OS-level tier, and a
read-write mount of the repository would let generated code plant files that
those processes then execute.

## Where capability selection lives

| Layer | Owns | Must not |
| --- | --- | --- |
| Fabric | Contracts, resolution status, maturity, declared effects and resources; enforcing the grant on **every** call from the program; failure codes; opportunity notices | Choose capabilities for a goal, or import Loom concepts |
| Loom | The goal's authority ceiling; the deterministic eligible set (admitted, resolved, effects within the ceiling); the grant for the program-run action; approvals; budgets; snapshot custody | Let a judgment answer issue or widen a grant |
| Judgment site (Jev may answer) | A proposed subset of the offered eligible ids, recorded as an observation | Add ids, mark anything as approved, or bypass approval gates on high-risk effects |
| Execution provider (Monty adapter) | Running the program; surfacing each call as a suspension; limits; dump and restore | Know Fabric contracts, grants or Loom goals; expose host state the provider was not given |

Pre-enabling in #21's sense is Loom issuing one grant that covers the
selected set. `delete`, publication, `process.spawn` and destructive repo
operations stay behind explicit approval whatever the proposal says. Per #30,
the provider sits behind a small seam: start a program with named functions
and stubs, surface suspensions, resume, dump, restore and close. No Monty
type crosses it, and a container or remote provider could satisfy the same
seam.

One open architectural point follows from code mode. VISION issues an
execution grant per action. A generated program makes many capability calls.
The option that keeps Fabric enforcing per call is one program-run action
whose grant names the offered capabilities, resources and effects, with each
call checked against it. This mirrors how `repo.test` runs nested
`shell.run@1` under its parent's grant. Calls that need approval suspend and
become their own pending decision. ARCHITECTURE should decide this before
anything is built.

## OS-level isolation still required

1. **Around the Monty worker.** E1: same uid and capabilities, shared
   namespaces, no seccomp. An interpreter escape lands on the host with the
   host's privileges. For untrusted generated code, run workers as a
   dedicated unprivileged user with no network namespace, a seccomp filter,
   a read-only root and cgroup limits on memory, CPU and pids. `maxMemory`
   counts allocator bytes, not RSS. Pin `binaryPath`. Whether the pool
   accepts a wrapper that launches the worker under such a jail is
   unverified.
2. **Around host implementations.** These run in the host process at full
   authority. Trusted implementations are host code. Generated
   implementations stay on M3's untrusted tier. Monty could in principle be
   one such tier for Python-subset implementations, but only with item 1 in
   place and an isolation report that states it. No containment may be
   claimed from the label.
3. **Around process work.** `shell.run@1`, `repo.test`, `repo.build` and
   `repo.lint` execute code a Thread edited. They need an OS-level tier
   (namespaces, container or microVM) whatever runs the orchestration.
4. **Host-side bounds Monty leaves to the host.** Mount I/O has no timeout.
   Host-function waits are uncharged. There is no session-lifetime budget, and
   running bytecode has no cancel. Set duration limits and `requestTimeout` on
   every untrusted session, and discard a session after a terminal limit. Kill
   a worker that outlives its budget, and make sure workers die with the host.

## Open questions that block a build decision

1. **Thread lifecycle (#28).** What is paused, who stores snapshots, how long
   they are retained, and what a Thread's process contains are not specified.
   #29 asks to stay exploratory until they are.
2. **Language.** Weave is TypeScript. Generated orchestration code would be
   Monty-subset Python. Which routed units write it reliably, and whether the
   subset is enough for real tasks, are unmeasured.
3. **Grant granularity.** Program-run envelope grant, or one action per call
   (above).
4. **Dependency.** `@pydantic/monty` brings native binaries (about 68 MB
   unpacked on Linux x64) and three runtime dependencies. AGENTS.md forbids
   speculative dependencies. Adopting it needs a recorded decision, and it
   should sit in an adapter package that neither Loom nor Fabric imports.
5. **Jailing the worker.** Whether OS isolation can wrap pool workers through
   `binaryPath`, or needs the Rust `monty-pool` crate, is unverified. Full
   Monty is the vendor's answer but is closed source and not reachable from
   TypeScript.
6. **Replay.** Fix the clock and random seed per session, record the Monty
   version with each run, and replay a recorded run without invoking
   anything.
7. **Telemetry.** `MontyInstrumentation` records source, inputs, outputs,
   host calls and printed text. A Weft record carries content only as class
   and digest. Keep it off, or adapt it at the edge.
8. **Capability-set proposals.** No reliability evidence yet for a judgment
   site choosing capability sets.

## Recommended next slice (contract first, not implemented)

Write a contract document for one vertical case: **run one generated
orchestration program against granted capabilities**. Show red with an
execution-provider double, as M3 did with an isolation double, before choosing
Monty or adding any dependency.

Contract surface:

- **Execution-provider seam.** `start(program, offered, limits)` returns
  `suspended { call_id, capability, input, position }`, `completed`, or
  `failed { code }`. Then `resume(call_id, outcome)`, `dump()` to opaque
  bytes, `restore(bytes)` and `close()`. It also produces an isolation report
  naming `os_isolation`, so a provider without it fails closed for untrusted
  programs.
- **Fabric adapter.** Each suspension becomes `invoke(grant, capability,
  input)`. Outcomes resume as values or as exceptions carrying AgentSOP
  failure codes.
- **Loom.** A program-run action, its grant, approval suspension, snapshot
  custody with a MAC and bound digests, and recovery by invocation identity.

Red checks to write first:

| ID | Scenario | Required evidence |
| --- | --- | --- |
| X-T01 | Program calls an un-offered capability | Fails inside the program. No `invoke`. A gap observation is recorded with a stable signature. |
| X-T02 | Program passes a grant-shaped argument | Ignored. The call is judged on the host-bound grant only. |
| X-T03 | Program reaches an approval-gated call | Suspends. The provider holds no worker while paused. Approval invokes once. Refusal raises `DENIED` into the program. |
| X-T04 | Stored snapshot bytes are edited | Restore is refused before the provider sees them (red against plain Monty: E3b). |
| X-T05 | Crash after dispatch, then restore re-announces the call | Outcome lookup by invocation identity. No second effect. |
| X-T06 | Runaway program; memory trip | Ends within the limit. The session is discarded, not fed again. |
| X-T07 | Provider reports no OS isolation | Untrusted program refused. No downgrade to trusted. |
| X-T08 | Replay a recorded run | Same observations. Provider and host invocation counts are zero. Clock and seed come from records. |
| X-T09 | Cancellation while suspended, and while running | Suspended: not resumed, `cancelled`. Running: worker killed, `cancelled` or `uncertain`. Locks held until the outcome is recorded. |
| X-T10 | Two Threads' programs run concurrently with different grants | Neither sees the other's capabilities. Both progress. Worker slots are a scheduler resource with a checkout deadline. |

Do not include mounts, the `os` callback, host objects or process work in this
slice. Code work stays on `shell.run@1` and an OS-level tier.
