# Scoring rule `task-acceptance.score@1`

This rule was written before any result from the frozen set. Thresholds are not
fit on the tune split or the holdout split. Editing them after reading a
result is a different rule, not a rerun of this one.

## Declared policy

| field | value |
| --- | --- |
| contract | `acceptance.line@2` |
| model | `jev-1.13.0` |
| probability threshold | `0.8` |
| confidence floor | `0.9` |

The contract row moved from `acceptance.line@1` to `acceptance.line@2` with
#201. `@2` adds predicate lines and changes nothing else: a free-text line is
admitted, asked and scored as it was under `@1`, and no threshold moved.

`0.9` sits above the 0.8–0.9 band already noted for hosted Jev, where a naive
cutoff overstates what the model can support. These numbers are that prior.
They are not estimated from `frozen-set.json`.

A boolean probability is P(the fact holds). Provider confidence is the separate
statistic beside it. Confidence is not a quality score and is not a weight.
Missing confidence is below the floor.

The model id is the concrete System One id already recorded in the gateway
fixture. `jev-latest` and `typesafe-ai/jev` are floating aliases and are not
used here.

## What is scored

For each frozen task, three scores:

1. **single_facts** — the line ids that entered the run are exactly
   `label_single_facts`. A free-text line enters only when code admits it as
   one observable fact and the criteria gate admits it: probability at or
   above `0.8` and confidence at or above `0.9`. A low-confidence criteria
   answer sends the line back. It does not enter. A predicate line enters
   when code admits it: the predicate is one of the closed kinds and fits its
   evidence kind. The criteria gate is not asked about it.
2. **validation_agrees** — code's disposition agrees with `label_done`.
   - `done` agrees only with `label_done: true`
   - `fail` and `escape` agree only with `label_done: false`
   - `escalate` and `malformed` agree with neither
3. **disagreement** — null when both scores are true. Otherwise one
   attribution, in this order:
   1. `low_confidence_noul` when the validation disposition is `escalate`, or
      the criteria gate sent a line back for low confidence
   2. `criteria` when `single_facts` is false
   3. `agent` when the facts match the label, the Nouls were confident, and
      the done bit still disagrees with the label

Code decides a predicate fact from the recorded evidence: `pass` or `fail`
on an exact comparison, `escape` when the artifact, the command or its exit
status is missing. Those verdicts combine with the Noul verdicts under the same
dispositions: any `fail` fails the task, then `escalate`, then `escape`.

A write-up is not an input to any score. A passing write-up cannot override a
failed fact.

## Facts decided in code

The report also carries a measure that is not one of the three scores and
does not change any attribution:

- `facts` — acceptance facts that entered validation, summed over tasks.
- `facts_decided_in_code` — of those, the predicate facts code decided
  without a Noul.
- `share_decided_in_code` — `facts_decided_in_code / facts`, or null when no
  fact entered.

Each task row carries its own `facts` and `facts_decided_in_code`. A line the
criteria gate kept out is not a fact and is not counted.

`t17-exit-status`, `t18-literal-absent`, `t19-mixed` and `h09-exit-fail` were
added with #201 so the measure has predicate facts to count. Their labels
follow from the task statement and the recorded exit status or body. No
earlier task or label changed, and no threshold applies to a predicate.

Hard constraints are code, not Nouls. Each task declares `constraints` and
`authority` before scoring. `do_not_send` and `do_not_delete` fail a command
only when that constraint is declared and the task's authority does not include
the effect. They are not bans on every task. `asked` permits a consequential
command when `ask_before_effect` is declared. It does not authorize send or
delete. A task whose authority includes `send` or `delete` may push, publish,
or delete without that command becoming a hard-constraint failure. A declared
constraint still fails the task when every Noul passes.

## Splits

`split: "tune"` is the development split. `split: "holdout"` is smaller and is
scored with the same declared policy. `scoreFrozenSet` has no threshold
argument. The offline report sets `holdout_used_for_tuning` to false.

The hand field `label_disagreement` is the attribution this rule produces for
the recorded fixtures. If a code change makes the computed attribution differ,
the offline command fails. That is drift, not a new label.

## Commands

Offline, no network, part of `npm run verify`:

```text
npm run task-acceptance:offline
```

Live comparison, not part of verify. A missing transcript skips. A skip is not
a pass. This command does not vendor an external coding agent.

```text
npm run task-acceptance:live -- --transcript path/to/transcript.json
```

The transcript is JSON: `{ "agent": "name", "tasks": [{ "id", "stop": "done" | "not_done", "write_up"? }] }`.
Set `TYPESAFE_API_KEY` (preferred); `TYPESAFE_AI_API_KEY` is accepted as a legacy
fallback. Without either key, the command skips with
`jev route not configured`. Jev is asked at `jev-1.13.0` only. Fixture
probabilities are not reused. A recorded disagreement is a completed eval.
The report status is `recorded`. It does not promote either outcome.

Replay of a stored Noul record does not call Jev. A record written under
`acceptance.line@1` replays under `@1`: every fact in it is a Noul fact, even
if the record were edited to name a predicate.

## Assumptions

- The month name "may" is not a date signal.
- A git or npm subcommand is argv[1]. Flags before the subcommand are not read.
- `contains_literal` is an exact, case-sensitive substring. It establishes
  only that the literal occurs: "README.md documents `--dry-run`" stays a
  free-text fact for a Noul.
- An exit status that was not recorded, or is null because the process ended
  without one, cannot show an `exit_status` predicate. The fact escapes.
- TypeSafe publishes no confidence for a Noul. A live answer without
  confidence escalates. That is fail-closed, not a claim that this site is
  calibrated against `frontier.weigh`.
