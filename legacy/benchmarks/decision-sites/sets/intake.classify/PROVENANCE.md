# intake.classify set provenance

Fixed before provider runs. Split unit: `scenario_id`; a scenario never crosses the tune/holdout boundary. Question wording is supplied by production site builders, not stored or paraphrased in these fixtures.

Source (read-only): `/workspace/amos/ft/sites/intake_flat/data/test_codex.jsonl`. Source SHA-256: `786a0fc50499fa739061bc268ad81468294eaf4e4b06a09ea1a99a178bd932eb`. Original source row ids are retained as `id` and `source_row_id`; source `sid` is retained as `scenario_id`. Gold comes from Codex-authored labels, not the teacher predictions.

Teacher metadata: `/workspace/amos/ft/sites/intake_flat/data/TEACHER.json` (SHA-256 `a8681d577215b9a94b609c2d918360b8768fb53e9dcbe7c2a1b94198e0e277c2`):

```json
{
  "teacher": "typesafe jev-1.13.0 (jev-latest, before weave PR #115)",
  "gold": "claude (train/dev/test_claude), codex (test_codex)"
}
```

State size is capped using the conservative estimate `ceil(serialized_state_chars / 3) <= 4000`; all committed states satisfy it. Source selection is deterministic SHA-256 ordering within strata. Teacher distributions are excluded from provider state.

## tune

60 items, 5 scenarios. Gold question-label counts: `{"continue_thread": 10, "interrupt": 10, "new_thread": 10, "queue": 10, "steer": 10, "stop": 10}`.

Scenario ids: `cx-1`, `cx-3`, `cx-5`, `cx-7`, `cx-9`

Row ids: `cx-1-10`, `cx-1-12`, `cx-1-14`, `cx-1-16`, `cx-1-17`, `cx-1-2`, `cx-1-22`, `cx-1-23`, `cx-1-3`, `cx-1-4`, `cx-1-5`, `cx-1-9`, `cx-3-49`, `cx-3-50`, `cx-3-54`, `cx-3-55`, `cx-3-57`, `cx-3-58`, `cx-3-60`, `cx-3-63`, `cx-3-64`, `cx-3-67`, `cx-3-70`, `cx-3-71`, `cx-5-102`, `cx-5-103`, `cx-5-105`, `cx-5-107`, `cx-5-108`, `cx-5-110`, `cx-5-114`, `cx-5-115`, `cx-5-116`, `cx-5-119`, `cx-5-98`, `cx-5-99`, `cx-7-144`, `cx-7-146`, `cx-7-149`, `cx-7-151`, `cx-7-153`, `cx-7-154`, `cx-7-158`, `cx-7-159`, `cx-7-160`, `cx-7-162`, `cx-7-165`, `cx-7-167`, `cx-9-192`, `cx-9-194`, `cx-9-198`, `cx-9-199`, `cx-9-202`, `cx-9-203`, `cx-9-204`, `cx-9-206`, `cx-9-209`, `cx-9-210`, `cx-9-212`, `cx-9-214`

Exact `tune.jsonl` SHA-256: `7929c08f9299bdfe5275993ff9411d1d1a06d0a543c6685dc6e819b30e4812b2`.

## holdout

60 items, 5 scenarios. Gold question-label counts: `{"continue_thread": 10, "interrupt": 10, "new_thread": 10, "queue": 10, "steer": 10, "stop": 10}`.

Scenario ids: `cx-10`, `cx-2`, `cx-4`, `cx-6`, `cx-8`

Row ids: `cx-10-216`, `cx-10-219`, `cx-10-221`, `cx-10-222`, `cx-10-224`, `cx-10-227`, `cx-10-228`, `cx-10-231`, `cx-10-233`, `cx-10-234`, `cx-10-236`, `cx-10-238`, `cx-2-25`, `cx-2-26`, `cx-2-29`, `cx-2-30`, `cx-2-33`, `cx-2-34`, `cx-2-37`, `cx-2-39`, `cx-2-41`, `cx-2-42`, `cx-2-45`, `cx-2-47`, `cx-4-72`, `cx-4-75`, `cx-4-76`, `cx-4-78`, `cx-4-80`, `cx-4-83`, `cx-4-86`, `cx-4-87`, `cx-4-88`, `cx-4-91`, `cx-4-92`, `cx-4-93`, `cx-6-121`, `cx-6-123`, `cx-6-126`, `cx-6-127`, `cx-6-129`, `cx-6-130`, `cx-6-132`, `cx-6-134`, `cx-6-137`, `cx-6-139`, `cx-6-140`, `cx-6-141`, `cx-8-169`, `cx-8-171`, `cx-8-173`, `cx-8-174`, `cx-8-177`, `cx-8-179`, `cx-8-182`, `cx-8-183`, `cx-8-185`, `cx-8-187`, `cx-8-190`, `cx-8-191`

Exact `holdout.jsonl` SHA-256: `8f8b2b33e686014844349ad6bb386dd11439ed625025fda496cdaf5619f8b9f1`.

Set digest (SHA-256 of exact tune bytes followed by exact holdout bytes): `60ab0c325c4a61d14be31f1e2424d4062adb35091ee7d6eacd2597eb059cd7c6`. Digests are also frozen in `../DIGESTS.json`.
