# loop.preselect set provenance

Fixed before provider runs. Split unit: `scenario_id`; a scenario never crosses the tune/holdout boundary. Question wording is supplied by production site builders, not stored or paraphrased in these fixtures.

Source (read-only): `/workspace/amos/ft/sites/preselect/data/test_codex.jsonl`. Source SHA-256: `e68cb2aeddc10487dafa208f5eccef32833e40d2a9ce521325c162be4ce36f91`. Original source row ids are retained as `id` and `source_row_id`; source `sid` is retained as `scenario_id`. Gold comes from Codex-authored labels, not the teacher predictions.

Teacher metadata: `/workspace/amos/ft/sites/preselect/data/TEACHER.json` (SHA-256 `a8681d577215b9a94b609c2d918360b8768fb53e9dcbe7c2a1b94198e0e277c2`):

```json
{
  "teacher": "typesafe jev-1.13.0 (jev-latest, before weave PR #115)",
  "gold": "claude (train/dev/test_claude), codex (test_codex)"
}
```

All seven available multi-tool steps are retained (four 2-tool and three 3-tool); source indexes contain 24 entries. This does not replace a future full-index, outcome-labelled multi-tool set (#140). Required entries are not injected from gold.

State size is capped using the conservative estimate `ceil(serialized_state_chars / 3) <= 4000`; all committed states satisfy it. Source selection is deterministic SHA-256 ordering within strata. Teacher distributions are excluded from provider state.

## tune

20 items, 7 scenarios. Gold question-label counts: `{"false": 456, "true": 24}`.

Gold tool-count strata: `{"1": 17, "2": 2, "3": 1}`.

Scenario ids: `cx-1`, `cx-10`, `cx-2`, `cx-3`, `cx-5`, `cx-6`, `cx-9`

Row ids: `cx-1-2`, `cx-1-3`, `cx-1-4`, `cx-10-54`, `cx-10-56`, `cx-10-57`, `cx-2-11`, `cx-3-16`, `cx-3-17`, `cx-5-24`, `cx-5-26`, `cx-5-27`, `cx-5-29`, `cx-6-30`, `cx-6-33`, `cx-6-35`, `cx-9-49`, `cx-9-50`, `cx-9-52`, `cx-9-53`

Exact `tune.jsonl` SHA-256: `3df43e160c310e8b649741f6d22b01e020a03c44a5c0d3a0ccf73507d257e384`.

## holdout

20 items, 7 scenarios. Gold question-label counts: `{"false": 454, "true": 26}`.

Gold tool-count strata: `{"1": 16, "2": 2, "3": 2}`.

Scenario ids: `cx-11`, `cx-12`, `cx-13`, `cx-14`, `cx-4`, `cx-7`, `cx-8`

Row ids: `cx-11-60`, `cx-11-61`, `cx-12-66`, `cx-12-67`, `cx-12-68`, `cx-13-73`, `cx-13-75`, `cx-13-76`, `cx-13-77`, `cx-14-78`, `cx-14-79`, `cx-14-82`, `cx-4-21`, `cx-4-23`, `cx-7-36`, `cx-7-39`, `cx-7-41`, `cx-8-42`, `cx-8-46`, `cx-8-47`

Exact `holdout.jsonl` SHA-256: `aa037729b22e087f0fc37ac4cd97100ae666d96bd44ed4fb0f7673510630ae96`.

Set digest (SHA-256 of exact tune bytes followed by exact holdout bytes): `b8231051b1cdafd247d46b7e4b5acb492e7df2ec5125b8be7a7d7fafdf8ea51d`. Digests are also frozen in `../DIGESTS.json`.
