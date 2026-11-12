# Policy refusal

Loom enforces authority deterministically: a goal source the goal has no read authority for still forms a candidate, but it is prohibited before weighing, never dispatched, and the goal blocks with a reason that names the missing authority; the Fabric host independently refuses any invocation without a matching grant, and a goal with no judgment budget never weighs or dispatches.

## Sub-features

- `prohibited-candidate` the unauthorised `gamma` inspection is `prohibited` with weight `null`.
- `excluded-before-weighing` the `weights.recorded` payload lists only the two allowed candidates.
- `never-started` no `action.started` targets `gamma`.
- `blocked-honestly` the last cycle is `blocked` with reason `no read authority for <gamma handle>` and `weights_ref: null`; the goal stays `active` with no report and no `report.assemble`.
- `host-denied` `host.invoke(null, 'source.inspect', {source: gamma})` and `host.invoke(<alpha grant>, ...)` both return `rejected` / `DENIED`; no new host invocation, two new rejections.
- `no-judgment-budget` with `budget.judgments: 0`, no `weights.recorded`, no `action.started`, no host invocation.
- `trace-complete` no unexplained `action.started`.

## How to get to it (user POV)

- Open a goal whose `sources` include a resource absent from `authority.read`.
- Call the capability host directly without a grant (a misbehaving or compromised caller).
- Open a goal with `budget: { actions: n, judgments: 0 }`.

## Driving it with loom-verify

Preconditions:

- Baseline launched and doctor green; goal over `alpha`, `beta`, `gamma` with read authority on `alpha`, `beta` only.

- **Prohibit.** Run `$H drive policy-refusal`. `PASS prohibited: ...` three times; `trace.json` cycle 1 has three candidates, `gamma`'s eligibility `prohibited`.
- **Block.** `PASS blocked: ...` twice; `result.json` shows `{ status: "blocked", reason: "no read authority for ref_3" }`.
- **Host refusal.** `PASS host: an ungranted or mis-granted invocation is rejected DENIED and never runs`; `host-rejections.json` lists the reason `grant is not issued by this authority` for the null grant.
- **Budget.** `PASS budget: no judgment budget means no weighing and no dispatch`; `no-judgment-budget.trace.json` holds the trace.
- **Proof.** `PASS policy-refusal: 8/8 checks` and the `policy-refusal/` evidence files.

## Gotchas

- Prohibition is not approval: no candidate in this drive is ever `approval_required`. Publication approval (M1) is a different path and is not mapped yet.
- The blocked goal stays `active`, not `failed`. Do not wait for a terminal status; the helper settles until no host invocation is open.
- The alpha grant reused for gamma is refused by the host too. Both refusals come from the host, independent of Loom's eligibility check.
