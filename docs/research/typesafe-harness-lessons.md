# TypeSafe harness notes: what Weave should take

Research date: 2026-09-21. Read against `VISION.md`, `CONTEXT.md`, `ARCHITECTURE.md`,
and the M0–M5 and H1 contracts on `main` at `6e4a662`. This note is research-time
evidence and recommendations. It is not a specification, and it does not change
a milestone contract.

## Decision

Keep Weave's runtime-owned state, per-consumer state views, and gateway routing.
Diogo Almeida's working notes argue that a coding agent built as one growing
transcript is stuck with that transcript's KV cache, and that the cache is why
routing, compaction, restarts, and subagents behave badly. That is evidence for
the design Weave already has: observations are state, a state view is a bounded
rendering, and a model does not own the loop.

Four consequences are not yet acceptance cases:

1. A later routing experiment must price a model switch as a context reload, and
   must price staying on a cached prefix as a discount. Today's gateway prices
   every attempt as a full cold context.
2. A capability index (short purpose lines) and a full input schema are different
   slices. Loading a schema for one judgment does not copy it into later views.
3. Permitted destinations can tighten from an action's declared read set.
   A model's guess about which files a task might touch does not.
4. Several read-only consumers of one state revision — review, explanation,
   evaluation — are threads over a shared read set. They are not a second agent
   product.

M5 already compares two framing profiles and records a fixture cache-miss delta
when the stable prefix bytes change. H1 already refuses session compaction.
None of the four items above belongs in those contracts. Routing and
information-gathering experiments are explicitly later work in
[M5 §6](../m5-improve-an-operating-strategy.md).

No change to `VISION.md`. The acceptance boundary is unchanged.

## Evidence and limits

Source: Diogo Almeida (CEO, TypeSafe AI), working notes titled "Why yet another
agent?", Google Doc `1G61uUB0FifUnmmrPzFQojZ3KpczYKmXGpgEXDJ2l_Zg`, exported as
plain text on 2026-09-21. The export is unversioned. Treat it as notes, not a
published design.

Checked against the export, not against a TypeSafe implementation:

- The routing arithmetic is internally consistent for the numbers written in the
  note. With input/output prices of 5/25 and 3/15, and a token mix of
  `X = 0.65`, `Y = 0.12`, `Z = 0.23`, the single-model path is about two thirds
  the cost of the handoff path (`4.15 / 6.19`). The note labels that mix as
  produced by asking a chatbot, and it does not cite a measured trace. Use the
  structural claim. Do not use the ratio as a measured saving.
- The [recursive language model](https://alexzhang13.github.io/blog/2025/rlm/)
  post was read. Almeida's one-line gloss ("more variables / explicit state")
  is narrower than the post. The post is a model-owned Python REPL that stores
  the prompt as a variable and recursively calls models. See lesson 7.
- `https://github.com/microsoft/fastcontext` returned 404. The note's claim that
  reading and searching are 56.2% of tool-use turns and 46.5% of main-agent
  tokens is unverified. Do not plan around that percentage.
- The "SLOP" subtask list and Appendix 3 are empty in the export (a heading and
  a tweet URL). They contribute nothing.
- Appendix tool links (`headroom`, `rtk`, `ast-grep`, `ast-outline`, `fff`) were
  not audited. They are examples of capabilities, not evidence that those
  programs should ship inside Weave.

Local facts used below:

- `worstCaseCost` in `packages/gateway/src/routing.ts` charges
  `max_context_tokens` at the route's input price plus the output cap at the
  output price. The gateway has no cache-hit term and no reload term for a
  change of model.
- [M5-T08](../m5-improve-an-operating-strategy.md) records `prefix_stable` from
  view bytes and adds one fixture cache-miss delta. The same section says M5
  does not integrate a provider's prompt-cache bill, and that routing
  experiments are later milestones.
- [H1](../h1-bound-the-log.md) states that session compaction is not part of
  that step. The log grows by accepted observations and rejects oversize
  payloads. It is not summarized in place.
- Destination filtering is per request: `destination_not_permitted` in the
  gateway, with the caller supplying `terms.destinations`. It is not computed
  from an action's read set.

## Lessons

### 1. Price the cache, or the cheaper model can cost more

**Claim in the notes.** Handing a long session to a cheaper model and back can
cost more than staying on the expensive model, because the expensive model
re-reads the prefix. The suggested design question is: how would the harness
work if the KV cache did not exist?

**Where Weave already agrees.** A state view is rebuilt from slices for a
named consumer. It is not the session transcript. M5 treats a change to the
stable prefix as a cost, and it refuses to bill the same tokens twice because
a cache also read them. VISION already says caching is part of state and
routing, and that a cheaper path is preferred only when it meets the quality
bar.

**What is still open.** Gateway routing compares expected cost from a cold full
window. It cannot yet represent two real differences:

- staying on a model whose prefix is already cached, which should cost less
  than `worstCaseCost`;
- switching models, or rebuilding a view whose prefix bytes differ, which
  should include one reload of the new view and no second charge for tokens
  the cache served.

A routing experiment after M5 should record that comparison on fixture prices
before any live provider bill. The decision layer still does not select the
model. A weight can say a candidate looks easy. The gateway still selects the
routed unit inside policy, privacy, and the quality bar. A missing cache
measurement is uncertainty, and the conservative route stands, which is the
rule `route()` already follows when evidence is thin.

### 2. Disclose a capability in two slices

**Claim in the notes.** Tools declared in full, up front, spend context and
are a poor fit for a large catalogue. A useful middle layer is a short
description of what exists, plus the full schema only when a judgment needs
it, without that schema remaining in later context. Skills are cited as
evidence that progressive disclosure works, and as a different mechanism from
tools.

**Where Weave already agrees.** `profile.frame@1` discloses catalogue ids and
input shapes up to `catalogue_budget` and records the rest as omissions.
M5's narrow profile is a smaller budget of that same slice. Admission of a
capability does not put it in every view, and it does not grant execution.
[M4](../m4-measure-reuse.md) already says a reused conclusion is not copied
into the next view unless the active profile selects that slice.

**What is still open.** Budget truncation of full shapes is one slice. The
notes describe two:

- an availability index: id and a one-line purpose, cheap enough to include
  whenever the consumer is choosing an operation;
- a schema slice: full input shape for the operations that judgment needs.

The schema slice is filled for that view only. The next profile omits it
unless it selects the slice again. A loaded schema is not an observation that
later cycles inherit. M5 can stay a budget change on the current slice. A
second slice is a later profile experiment, and an empty index or a missing
required operation already fails M5's quality bar.

### 3. Do not compact the log into one shared summary

**Claim in the notes.** Compaction assumes every future turn wants the same
compressed state. Compression aimed at a known query is easier, and a summary
written for no particular consumer throws away detail that consumer needed.

**Where Weave already agrees.** H1 refuses session compaction. Observations
stay in the log. A view discloses truncation. A cached conclusion keeps its
read set, evidence, and invalidation conditions, and a stale dependency is
not reused.

**What to keep refusing.** A later response to log growth should keep
rejecting or spanning by observation bounds, as H1 does. If a summary is
useful, it is a cached conclusion produced for a named slice, invalidated
with its read set, and omitted from views that did not select it. It is not
a rewrite of the observation log and it is not the only state the next cycle
can see.

### 4. Parallel work is threads and effect locks

**Claim in the notes.** Subagents underperform because someone must choose
which context goes in and which context comes back. If that were cheap,
more parallel work would be worth doing. A later section adds shared state
and locks so concurrent writers do not collide. The same notes are unsure
that models will parallelize well on their own.

**Where Weave already agrees.** The action frontier runs independent actions
together. A thread is the causal sequence. An effect lock reserves resources.
Read-only work does not take the write lock. The scheduler, not a model, forms
the frontier. Nested work shares the caller's authority and budget.

**What to keep refusing.** A subagent is not a new primitive. Spawning one
would reintroduce a model-owned loop, a private transcript, and a merge
problem the runtime already solves by recording observations. Synchronization
for writers is the effect lock that M1 already requires. Deduplicating a
repeated desired operation against work already in state is a scheduler rule
for a later milestone, using the existing candidate identity, not a subgoal
store.

### 5. Re-render relevant state; do not restart the session

**Claim in the notes.** Restarting makes sense when one stateful transcript
has gone bad. The alternative is to load the relevant prior state when it is
needed.

**Where Weave already agrees.** Replay reconstructs history without executing.
Recovery continues unfinished work under current authority and does not renew
a budget or an approval. A state view is rendered from current slices at the
revision the judgment is bound to.

**What to keep.** A corrupted or oversized transcript is not a reason to add
a restart action that drops the log. The response to a bad view is a different
profile or a rejected observation, with the log intact for replay.

### 6. A large catalogue is affordable when views stay small

**Claim in the notes.** Batteries-included harnesses are easy and limited;
power-user harnesses are capable and empty. If disclosure is nearly free,
the harness can carry many capabilities and documents and pay only for what
a view selects. The notes also observe that third-party compression CLIs
often fail because the model has no contract for them, and that a hook
installed by a skill currently stays for the rest of the session.

**Where Weave already agrees.** The registry can hold capabilities the current
view does not disclose. A retained procedure can inform a proposal. Retention
is not admission, and admission is not an execution grant. A generative
implementation declares an inference kind and a context profile; a raw
executable dropped into the process is not a capability.

**What to keep refusing.** Do not vendor a trending CLI into the control core
to borrow attention. If a search or compression program is worth having, it
becomes a capability through the M3 gates: contract, corpus, demonstrated red,
isolation, green, admission. A behavioral hook that remains in force for later
cycles is a policy or procedure change. It needs the same authority as any
other policy change. A skill document cannot install one.

Conditional guidance — a style rule for one part of the tree, a gotcha for one
resource — is durable knowledge selected by the read set of the work in
flight. The profile includes that slice when the read set intersects the
resource, and omits it otherwise. The source of the guidance stays outside
the view, so a narrower profile cannot delete it. That is a later slice, not
an `AGENTS.md` interpreter in the core.

### 7. Keep bulk context out of the root call; keep the model out of the loop

**Claim in the notes, and what the linked post actually says.** The notes
summarize recursive language models as explicit variables. The post defines
a replacement for a model call: the root model sees the query, the prompt
lives in a REPL variable, and the model writes code that partitions that
variable and calls models recursively. Reported gains are on long-context
benchmarks, at recursive depth 1, with the model choosing the decomposition.

**What Weave should take.** Bulk observations stay in state. A judgment
receives the slice its profile selected. Search, partition, and extraction
are capabilities or further bounded judgments, each with a read set and a
budget.

**What Weave should not take.** The REPL is not the runtime. Letting the model
decide the recursion, hold the context object, and call models from code it
just wrote gives that model the loop, the disclosure decision, and a fresh
budget at every depth. Nested inference already shares the caller's authority
and reservation. Depth does not create a new principal.

### 8. Tighten destinations from the read set

**Claim in the notes.** Some models are cheap and should not see every file.
A task could carry a likelihood of touching sensitive files, and policy could
send only some tasks to those models. Other reasons to avoid a provider are
named as well, including the subject of the work.

**Where Weave already agrees.** The caller supplies permitted destinations.
A route whose destination is absent from that list is excluded before price
is considered. A local route is the one that names no vendor. Adding a hosted
route to the table does not make it reachable. Sensitive candidate content is
filtered before a model sees it. Cost never relaxes a privacy filter.

**What is still open.** The filter is a property of the request terms, chosen
before the specific action's read set is applied. A later routing experiment
can intersect `terms.destinations` with a deterministic policy on the
candidate's declared resources and effects: an action whose read set includes
a restricted resource loses the destinations that policy forbids for that
resource. The surviving set is then ranked by expected cost, including the
reload term from lesson 1.

A model score for "might touch a secret" can be recorded as a weight. It
cannot add a destination, and it cannot remove one that policy still permits.
The declared read set is the input to the filter. Likelihood is not.

### 9. Read-only side work shares one revision

**Claim in the notes.** Several popular workflows run beside the main edit
and only read the current tree: a live explanation, a background eval, a
second model reviewing the change. The notes' point is that explicit read
state can be assembled once and reused by all of them.

**Where Weave already agrees.** M0 runs independent reads concurrently. A
shared read set does not conflict. Each consumer gets its own state view,
bound to the revisions it rendered. A review is another judgment site with
its own routed unit and its own acceptance record. It does not share the
framing site's evidence.

**What is still open.** Nothing in M0–M5 schedules a fan-out of read-only
consumers of one revision as a named operating strategy. When that experiment
exists, the cost comparison is: one assembly of the shared slices, then N
views, against N independent reconstructions. Writers still take effect locks.
A background consumer cannot widen the goal, lower the completion bar, or
promote its own findings. Cross-model review is a judgment observation. The
runtime decides whether it changes the frontier.

## What not to build from this note

- A model router inside the decision layer, or a default of "cheap model first"
  that ignores reload cost and the quality bar.
- A compaction pass, a session restart action, or a summary that replaces the
  log.
- A subagent type, a message bus between agents, or a REPL the model controls.
- MCP, a skill installer, or any of the appendix CLIs as a runtime dependency.
- A hype-tracking feed of third-party tools. That is distribution, not a
  control-core requirement.
- An M5 amendment. M5's candidate remains one narrower profile record. The
  cache-miss delta remains a fixture constant.

## Later acceptance cases

When a routing or information-gathering milestone is written, the failing
checks to demonstrate first are:

1. Two fixture routes, same view bytes, one with a recorded warm prefix: the
   warm route's expected cost is below its cold `worstCaseCost`, and the cold
   reload is not also charged.
2. A handoff that reloads a long prefix onto the expensive route costs more
   than staying, so the handoff is not selected. A short view, where the
   reload is cheaper and quality holds, may select the cheaper route.
3. The framing view includes the availability index and omits full schemas.
   The next view after a schema was loaded does not contain that schema unless
   its profile selects it. Dropping an operation the composition needs still
   misses the quality bar.
4. A candidate whose read set names a restricted resource cannot be sent to a
   destination policy forbids for that resource, even when that destination is
   cheaper and present in the goal's destination list.
5. Two read-only judgments over one revision share the slice assembly cost
   once. A write still conflicts. Neither judgment promotes an operating
   strategy or issues a grant.

These are proposals for a future contract. They are not M5 work, and they are
not authorization to start that contract in this change.
