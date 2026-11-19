# guard.output set provenance

Fixed before provider runs. Split unit: `scenario_id`; a scenario never crosses the tune/holdout boundary. Question wording is supplied by production site builders, not stored or paraphrased in these fixtures.

**Synthetic.** Gold author: Codex (WHC-P10 author). Cases and gold labels authored offline before any provider run. Related cases are grouped into a scenario; odd scenarios tune, even scenarios holdout. No provider labels are used.

State size is capped using the conservative estimate `ceil(serialized_state_chars / 3) <= 4000`; all committed states satisfy it. Source selection is deterministic SHA-256 ordering within strata. Teacher distributions are excluded from provider state.

## tune

18 items, 9 scenarios. Gold question-label counts: `{"false": 9, "true": 9}`.

Case kinds: `{"clear_pass": 6, "clear_violation": 6, "near_miss": 6}`. For input guards one case answers four different semantic rules. Labels include overlapping scope violations: secret exfiltration and destructive actions beyond a read-only grant also broaden scope.

Scenario ids: `syn-guard.output-01`, `syn-guard.output-03`, `syn-guard.output-05`, `syn-guard.output-07`, `syn-guard.output-09`, `syn-guard.output-11`, `syn-guard.output-13`, `syn-guard.output-15`, `syn-guard.output-17`

Row ids: `syn-guard.output-01-1`, `syn-guard.output-01-2`, `syn-guard.output-03-1`, `syn-guard.output-03-2`, `syn-guard.output-05-1`, `syn-guard.output-05-2`, `syn-guard.output-07-1`, `syn-guard.output-07-2`, `syn-guard.output-09-1`, `syn-guard.output-09-2`, `syn-guard.output-11-1`, `syn-guard.output-11-2`, `syn-guard.output-13-1`, `syn-guard.output-13-2`, `syn-guard.output-15-1`, `syn-guard.output-15-2`, `syn-guard.output-17-1`, `syn-guard.output-17-2`

Exact `tune.jsonl` SHA-256: `f7b45cdb0f396482c2d392ab7a9f91f7fbad0e23bd56afb217c07d79f5db28c7`.

## holdout

18 items, 9 scenarios. Gold question-label counts: `{"false": 9, "true": 9}`.

Case kinds: `{"clear_pass": 6, "clear_violation": 6, "near_miss": 6}`. For input guards one case answers four different semantic rules. Labels include overlapping scope violations: secret exfiltration and destructive actions beyond a read-only grant also broaden scope.

Scenario ids: `syn-guard.output-02`, `syn-guard.output-04`, `syn-guard.output-06`, `syn-guard.output-08`, `syn-guard.output-10`, `syn-guard.output-12`, `syn-guard.output-14`, `syn-guard.output-16`, `syn-guard.output-18`

Row ids: `syn-guard.output-02-1`, `syn-guard.output-02-2`, `syn-guard.output-04-1`, `syn-guard.output-04-2`, `syn-guard.output-06-1`, `syn-guard.output-06-2`, `syn-guard.output-08-1`, `syn-guard.output-08-2`, `syn-guard.output-10-1`, `syn-guard.output-10-2`, `syn-guard.output-12-1`, `syn-guard.output-12-2`, `syn-guard.output-14-1`, `syn-guard.output-14-2`, `syn-guard.output-16-1`, `syn-guard.output-16-2`, `syn-guard.output-18-1`, `syn-guard.output-18-2`

Exact `holdout.jsonl` SHA-256: `e504fe8843592e72f24acd75789966efec7f0114856507fa7488d9599d7ab3c3`.

Set digest (SHA-256 of exact tune bytes followed by exact holdout bytes): `e825b7d1aed528fb9a5fbefb363a675478a86b89c5d575e77ff0423481ade07c`. Digests are also frozen in `../DIGESTS.json`.
