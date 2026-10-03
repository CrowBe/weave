# Task acceptance report

Template for `task-acceptance.score@1`. A row is one frozen task. The three
scores are `single_facts`, `validation_agrees`, and `disagreement`.

`disagreement` is null when the pipeline agrees with the hand label. Otherwise
it is `criteria`, `agent`, or `low_confidence_noul`. A filled disagreement is a
successful eval. It is not a promotion of either outcome.

The offline command prints this shape as JSON and sets `live_comparison` to
`not_run`. It does not call Jev.

The live command is separate. A missing agent transcript is:

```json
{ "status": "skip", "reason": "agent transcript missing", "live_comparison": "skip" }
```

That skip is not a pass. A configured run sets `live_comparison` to `ran` and
`status` to `recorded`.

## Template example

This row is the shape of a recorded disagreement. It is not a measured live
result.

| id | split | single_facts | validation_agrees | disagreement | disposition | label_done | agent_stop |
| --- | --- | --- | --- | --- | --- | --- | --- |
| example-criteria | tune | false | true | criteria | fail | false | not_done |

Read it as: the hand label says the line was one fact, the criteria gate kept
it out, validation therefore had nothing to pass, and the disagreement is
attributed to the criteria rather than to the agent or to a low-confidence Noul.

## Columns

- `single_facts` — entered acceptance facts match the hand label.
- `validation_agrees` — code's done / not-done disposition matches `label_done`.
- `disagreement` — `criteria`, `agent`, `low_confidence_noul`, or null.
- `disposition` — `done`, `fail`, `escalate`, `escape`, or `malformed`.
- `agent_stop` — the external coding agent's own stop, when a transcript
  recorded one. Null means that comparison was not supplied. On the live
  command a task with no transcript entry is `agent_comparison: "skip"`.
