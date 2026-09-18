# Harness lessons before expanding Weave

Research date: 2026-09-18. Findings incorporated into the canonical architecture
and [M1 contract](../m1-publish-under-authority.md) following user approval.
This note retains the research-time evidence and recommendations; it is not an
independent specification or implementation proof.

## Decision

Keep Weave's runtime-owned action frontier and existing M0–M5 milestone sequence. Learn from
the operational contracts of other harnesses: interruption, recovery, authority,
bounded work, context selection and retained procedures. Most of these requirements
already exist in ARCHITECTURE.md; the immediate work is to make them executable
acceptance cases in the relevant milestone.

## Evidence and limits

Read VISION.md, CONTEXT.md and ARCHITECTURE.md in the current checkout, plus the live
[PR #4](https://github.com/CrowBe/weave/pull/4) body and full diff, especially
AgentSOP's host interface, runtime execution/replay, observation validation, and
M0-T04–T19. The PR is titled “M0: inspect and report — contract layer, runtime, and
red-green checks”; this is the first implementation slice referred to in the request.
The current checkout is an earlier architecture branch, not the PR checkout.
PR CI reported one passing check; tests were inspected, not rerun. This is an
architecture comparison, not a complete correctness review or merge approval.

External evidence is current first-party documentation, not execution verification
or pinned-source auditing. See the [OpenClaw/Hermes source notes](openclaw-hermes-lessons.md)
for detailed evidence and limitations. Recommendations below are our inference.

## Lessons mapped to Weave

| Lesson and source | Translation into Weave | When |
| --- | --- | --- |
| OpenClaw separates durable accepted input from permission to resume execution and distinguishes consumed work from delivery. [Recovery](https://docs.openclaw.ai/gateway/restart-recovery) | Separate historical replay, recovery of unfinished actions and new dispatch. A lost publication acknowledgement requires reconciliation, not blind retry. | M1 |
| OpenClaw uses ownership lanes and capacity limits; waiting schedulers do not consume their children's execution capacity. [Queue](https://docs.openclaw.ai/concepts/queue) | Serialize state transitions while executing compatible actions concurrently. Cancellation and result integration must still progress when execution slots are full. Do not adopt session-wide serialization of useful actions. | M1; nested cases when composition arrives |
| Codex exposes pending approval, decision resolution and execution completion as distinct events, scoped to work identities. [App-server approvals](https://developers.openai.com/codex/app-server#approvals) | Approval is a lifecycle bound to the exact action, inputs, effects and authority. Authenticate provenance at ingress and recheck it at dispatch. A string claiming operator origin is not authentication. | M1 |
| Codex separates sandbox controls from approval policy and documents OS enforcement and its platform constraints. [Approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security) | AgentFabric must actually enforce declared effects and granted access. A matching grant record or approved command is insufficient evidence of containment. Prove the bounded publication adapter first, then untrusted-code containment. | M1 / M3 |
| Codex offers streamed work lifecycles, steering and bounded ingress; its conversation primitives are product-specific. [App server](https://developers.openai.com/codex/app-server) | Borrow explicit operation identity and lifecycle reporting. Keep Weave's control transitions responsive during inference; do not make every arriving observation wait for a model response. Keep clients as adapters over runtime state. | M2; client protocol when needed |
| Hermes bounds memory and progressively loads skill details. [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) | Implement one bounded, versioned state view with disclosed omissions. Cache stable content while checking authority and read-set freshness. Retain useful procedures as proposals or compositions; they earn admission separately. | M2–M4 |

## Specific implications of PR #4

The PR has useful foundations: a capability host port, explicit candidates and
weights, action budget reservations, concurrent read handles, arrival-triggered
cycles, and replay checks. Preserve these seams. Four fixture assumptions should
not silently become production contracts:

1. **A Promise is insufficient for effectful invocation.** InvocationHandle exposes
   an action identity and result Promise, with a declared never-reject contract.
   M1 needs a defined cancellation/reconciliation path and normalization of host
   throws, rejected promises, disconnects and timeouts. An uncertain effect must
   retain the relevant reservations until reconciliation or a governed resolution.
2. **Replay currently depends on today's catalogue.** Runtime construction wires
   describe() to the supplied host even during replay. Store or resolve immutable
   contract revisions for historical reconstruction. Check current revocation and
   authority separately when recovering execution. Audit must remain possible
   after a capability is upgraded or revoked, without restoring its permission.
3. **Provenance is currently fixture metadata.** validate() checks source.kind,
   and grantCovers() checks structural coverage. Before external ingress or an
   enforcing host, bind identities to trusted channels and grants to trusted
   issuance. Test forged source labels and copied grants, not just wrong labels
   and missing permission entries. This need not introduce cryptography inside
   one trusted process; ownership-enforced handles may suffice.
4. **Weighing is synchronous and accepted-result accounting is insufficient for
   paid inference.** M2 must reserve before a request, record every attempt and
   charge failures or malformed responses too. A delayed judgment must bind to
   the state/candidate revisions it evaluated. Cancellation and authority changes
   must remain processable while it is in flight.

These are evolution boundaries, not claims that M0 should implement M1 and M2.

## Next acceptance cases

Before implementing M1, demonstrate red for these scenarios within its existing
publication fixture:

- Crash after external publication commits but before its result is recorded:
  recovery reconciles or reports uncertainty without duplicating the effect.
- Approval is revoked or bound inputs change while queued: dispatch is refused.
- Cancellation races with dispatch or a late result: evidence is retained and
  resource reservations are not released on the request alone.
- Execution capacity is full: result recording and cancellation still progress.
- An external payload claims operator or host origin, or reuses another action's
  grant: the authority boundary rejects it.
- A historical trace is inspected after catalogue change: reconstruction uses its
  recorded revisions; resuming work still applies current authority.

When an external client delivery surface is added, test delivery retry separately
from publication retry. Do not add a delivery platform merely for M1's fixture.

For M2, use a deliberately slow or malformed judgment to prove responsive control,
stale-result handling, bounded attempts and all-attempt spending. For M3, demonstrate
that a helpful retained skill/procedure remains unadmitted until contract, validated
corpus, demonstrated red, proven green and admission checks pass.

## What to defer

Do not copy an entire model-owned loop, channel gateway, agent hierarchy, plugin
ecosystem, vector-memory platform or automatic skill installation system. A foreign
skill can inform a proposed composition; it cannot confer execution authority.
Likewise a model-based approval heuristic cannot replace Weave's deterministic
policy. No evidence found here calls for changing VISION.md or expanding M0.
