# Scoring rule `task-acceptance.score@1`

This rule was written before any result from the frozen set. Thresholds are not
fit on the tune split or the holdout split. Editing them after reading a
result is a different rule, not a rerun of this one.

## Declared policy

| field | value |
| --- | --- |
| contract | `acceptance.line@1` |
| model | `jev-1.13.0` |
| probability threshold | `0.8` |
| confidence floor | `0.9` |

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
   `label_single_facts`. A line enters only when code admits it as one
   observable fact and the criteria gate admits it: probability at or above
   `0.8` and confidence at or above `0.9`. A low-confidence criteria answer
   sends the line back. It does not enter.
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

A write-up is not an input to any score. A passing write-up cannot override a
failed fact.

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
`TYPESAFE_AI_API_KEY` must be set or the command skips with
`jev route not configured`. Jev is asked at `jev-1.13.0` only. Fixture
probabilities are not reused. A recorded disagreement is a completed eval.
The report status is `recorded`. It does not promote either outcome.

Replay of a stored Noul record does not call Jev.

## Assumptions

- The month name "may" is not a date signal.
- A git or npm subcommand is argv[1]. Flags before the subcommand are not read.
- TypeSafe publishes no confidence for a Noul. A live answer without
  confidence escalates. That is fail-closed, not a claim that this site is
  calibrated against `frontier.weigh`.
