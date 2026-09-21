# M5 — Improve one operating strategy

This is the behavioral contract for the milestone in
[ARCHITECTURE.md §10](../ARCHITECTURE.md). It extends
[M4](m4-measure-reuse.md). Terms follow
[CONTEXT.md](../CONTEXT.md). The checks below are requirements, not claims of
implemented behavior. Demonstrate red before implementation and retain the
M0–M4 checks when proving green.

## 1. Outcome and scope

From the M4 baseline, change one operating strategy: the framing context
profile. Compare `profile.frame.narrow@1` with `profile.frame@1` on a
protocol that was recorded before the comparative results. Promote it only
for the declared workload, with an operator observation. A cheaper profile
that misses the quality bar is not promoted. After promotion, a regression
on a protected case rolls future goals back to the baseline profile.

M5 proves:

- The candidate is a versioned profile record the runtime already selects.
  It is not a patch to scheduling, policy, admission, or the procedure union.
- The experiment protocol, protected cases, quality bar, and promotion
  conditions are observations recorded before any comparative result.
- Quality and human corrections are part of the comparison, not only latency
  and cost.
- Promotion is not admission and does not issue an execution grant. It does
  not change the goal's success evidence.
- In-flight work keeps the profile recorded on its framing view. Rollback
  changes future selection and does not undo a completed effect.
- The author of the candidate does not edit the protected cases or the
  quality bar to make the candidate pass.

No general experiment platform and no control-core release path are required.
Refusing a core patch is part of the proof.

## 2. The candidate

`profile.frame@1` is the M4 baseline (catalogue budget 32). The candidate is
a different record, for example:

```text
FrameProfile {
  id:                "profile.frame.narrow@1"
  version:           1
  catalogue_budget:  8
}
```

It must still disclose every operation the recorded composition needs. A
profile that omits `text.normalize` or `source.inspect` fails the quality
bar even if it is cheaper. The renderer already takes the profile as data;
selecting the narrow record is not an edit to the control core.

An experiment whose candidate is a change to the scheduler, the policy
checks, the admission checks, or the procedure union is refused before
evaluation.

## 3. Protocol before results

Record this observation before any comparative measurement:

```text
Experiment {
  weakness:            "framing discloses more catalogue than the composition uses"
  baseline:            "profile.frame@1"
  candidate:           "profile.frame.narrow@1"
  workload:            M4's repeated goals, including the failing case
  protected_cases:     [case ids]
  quality_bar:         M4 success evidence, unchanged
  measures:            [quality, human_corrections, latency_ticks, cost_micros]
  promotion:           quality holds AND human_corrections do not increase
                       AND (latency_ticks or cost_micros improves)
  budget:              { judgments, cost }
  rollback:            "profile.frame@1"
}
```

Results recorded before this observation cannot support promotion. Changing
the quality bar, the protected cases, or the success evidence after results
exist invalidates the comparison. Deleting a protected case that the
candidate fails is rejected.

## 4. Promotion and rollback

Promotion is an operator ingress observation naming the experiment and the
workload scope. A model judgment cannot promote. Promotion activates the
candidate profile for later goals in that scope. It does not:

- admit an implementation
- issue an execution grant
- change success evidence
- rewrite an in-flight goal's recorded profile
- modify runtime source

A protected case that misses the quality bar after promotion is a regression.
Rollback records the baseline profile as the one future goals select. It
does not reverse a completed report or publication. If the baseline profile
record is missing, affected new work pauses; it does not fall through to an
unversioned default.

A candidate that reduces cost or latency and misses the quality bar, or that
increases human corrections, is not promoted. The baseline stays active.

## 5. Required deterministic checks

Retain every M0–M4 check. Comparative runs use fixture profiles and injected
ticks.

| ID | Scenario | Required evidence |
| --- | --- | --- |
| M5-T01 | Protocol recorded, then the narrow profile compared with the M4 baseline | The protocol observation's sequence is earlier than every comparative result. The candidate profile id is `profile.frame.narrow@1`. No scheduler, policy, admission, or procedure-union source change is part of the candidate. |
| M5-T02 | Narrow profile still discloses the composition's operations and meets the promotion rule | Operator promotion activates it for the declared workload. Later goals frame with that profile. Success evidence is unchanged. No execution grant is issued by the promotion. |
| M5-T03 | Candidate is cheaper and misses the quality bar, or increases human corrections | Promotion is refused. The active profile remains `profile.frame@1`. |
| M5-T04 | Protected case removed or quality bar lowered after results exist | The comparison is invalid and cannot promote. |
| M5-T05 | Promotion, then a protected case regresses | Future goals use the baseline profile. The in-flight goal keeps the profile on its recorded framing view. Completed publication is not reversed. |
| M5-T06 | Candidate is presented as a patch to admission or the procedure union | Evaluation does not start. The patch is not applied. |
| M5-T07 | Replay of the promoted run | Observations match. Replay uses the profile recorded on the view, not today's active profile. The host and gateway are not invoked. |

Record demonstrated red and green against the exact contract revisions.

## 6. Assumptions recorded

- One profile record is the whole operating-strategy change. Routing,
  scheduling, and information-gathering experiments are later milestones.
- The gating suite compares fixture measurements. It does not call a live
  model to decide promotion.
- Human promotion is the only promotion authority in this milestone.
