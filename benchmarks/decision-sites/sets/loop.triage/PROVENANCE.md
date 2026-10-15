# loop.triage set provenance

Fixed before provider runs. Split unit: `scenario_id`; a scenario never crosses the tune/holdout boundary. Question wording is supplied by production site builders, not stored or paraphrased in these fixtures.

Source (read-only): `/workspace/amos/ft/sites/triage_flat/data/test_codex.jsonl`. Source SHA-256: `d11fcb97c548f2e6a11cbca4fa4cfe39771285a85816a5bc87d010d22b39fe4e`. Original source row ids are retained as `id` and `source_row_id`; source `sid` is retained as `scenario_id`. Gold comes from Codex-authored labels, not the teacher predictions.

Teacher metadata: `/workspace/amos/ft/sites/triage/data/TEACHER.json` (SHA-256 `a8681d577215b9a94b609c2d918360b8768fb53e9dcbe7c2a1b94198e0e277c2`):

```json
{
  "teacher": "typesafe jev-1.13.0 (jev-latest, before weave PR #115)",
  "gold": "claude (train/dev/test_claude), codex (test_codex)"
}
```

triage_flat has no TEACHER.json; sibling triage/data/TEACHER.json records shared site teacher, consistent with the targeted fine-tune report. Gold is the source Codex label, not teacher prediction.

State size is capped using the conservative estimate `ceil(serialized_state_chars / 3) <= 4000`; all committed states satisfy it. Source selection is deterministic SHA-256 ordering within strata. Teacher distributions are excluded from provider state.

## tune

50 items, 4 scenarios. Gold question-label counts: `{"capability": 10, "done_check": 10, "implement": 10, "needs_human": 10, "out_of_scope": 10}`.

Scenario ids: `cx-1`, `cx-2`, `cx-3`, `cx-4`

Row ids: `cx-1-10`, `cx-1-12`, `cx-1-14`, `cx-1-16`, `cx-1-17`, `cx-1-2`, `cx-1-20`, `cx-1-22`, `cx-1-23`, `cx-1-25`, `cx-1-4`, `cx-1-8`, `cx-1-9`, `cx-2-27`, `cx-2-29`, `cx-2-30`, `cx-2-33`, `cx-2-34`, `cx-2-39`, `cx-2-40`, `cx-2-41`, `cx-2-42`, `cx-2-45`, `cx-2-49`, `cx-2-50`, `cx-3-54`, `cx-3-57`, `cx-3-58`, `cx-3-59`, `cx-3-60`, `cx-3-64`, `cx-3-67`, `cx-3-70`, `cx-3-71`, `cx-3-72`, `cx-3-74`, `cx-3-76`, `cx-3-77`, `cx-4-102`, `cx-4-80`, `cx-4-82`, `cx-4-83`, `cx-4-86`, `cx-4-87`, `cx-4-91`, `cx-4-92`, `cx-4-93`, `cx-4-97`, `cx-4-98`, `cx-4-99`

Exact `tune.jsonl` SHA-256: `c5a5696c2be58eb489f743efac581bbd0f0ea747e5bd706cfabcbff4613b5750`.

## holdout

50 items, 4 scenarios. Gold question-label counts: `{"capability": 10, "done_check": 10, "implement": 10, "needs_human": 10, "out_of_scope": 10}`.

Scenario ids: `cx-5`, `cx-6`, `cx-7`, `cx-8`

Row ids: `cx-5-105`, `cx-5-107`, `cx-5-110`, `cx-5-111`, `cx-5-114`, `cx-5-116`, `cx-5-119`, `cx-5-120`, `cx-5-123`, `cx-5-124`, `cx-5-127`, `cx-5-128`, `cx-5-129`, `cx-6-132`, `cx-6-133`, `cx-6-134`, `cx-6-137`, `cx-6-139`, `cx-6-141`, `cx-6-142`, `cx-6-143`, `cx-6-147`, `cx-6-148`, `cx-6-151`, `cx-6-152`, `cx-7-160`, `cx-7-161`, `cx-7-162`, `cx-7-163`, `cx-7-165`, `cx-7-167`, `cx-7-171`, `cx-7-173`, `cx-7-174`, `cx-7-175`, `cx-7-178`, `cx-7-180`, `cx-7-181`, `cx-8-183`, `cx-8-185`, `cx-8-187`, `cx-8-190`, `cx-8-191`, `cx-8-194`, `cx-8-195`, `cx-8-196`, `cx-8-198`, `cx-8-201`, `cx-8-205`, `cx-8-207`

Exact `holdout.jsonl` SHA-256: `afe4e7f248efd9f2cfbf7b6a3c9f683776963351f54b3bbc29e71ad3e23337e5`.

Set digest (SHA-256 of exact tune bytes followed by exact holdout bytes): `9ddae6f34801a33ea5a42c95f4b788c5332752626829af5f3e6264b903ba7971`. Digests are also frozen in `../DIGESTS.json`.
