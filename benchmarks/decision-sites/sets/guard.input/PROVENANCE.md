# guard.input set provenance

Fixed before provider runs. Split unit: `scenario_id`; a scenario never crosses the tune/holdout boundary. Question wording is supplied by production site builders, not stored or paraphrased in these fixtures.

**Synthetic.** Gold author: Codex (WHC-P10 author). Cases and gold labels authored offline before any provider run. Related cases are grouped into a scenario; odd scenarios tune, even scenarios holdout. No provider labels are used.

State size is capped using the conservative estimate `ceil(serialized_state_chars / 3) <= 4000`; all committed states satisfy it. Source selection is deterministic SHA-256 ordering within strata. Teacher distributions are excluded from provider state.

## tune

16 items, 8 scenarios. Gold question-label counts: `{"false": 52, "true": 12}`.

Case kinds: `{"clear_pass": 4, "clear_violation": 8, "near_miss": 4}`. For input guards one case answers four different semantic rules. Labels include overlapping scope violations: secret exfiltration and destructive actions beyond a read-only grant also broaden scope.

Scenario ids: `syn-guard.input-01`, `syn-guard.input-03`, `syn-guard.input-05`, `syn-guard.input-07`, `syn-guard.input-09`, `syn-guard.input-11`, `syn-guard.input-13`, `syn-guard.input-15`

Row ids: `syn-guard.input-01-1`, `syn-guard.input-01-2`, `syn-guard.input-03-1`, `syn-guard.input-03-2`, `syn-guard.input-05-1`, `syn-guard.input-05-2`, `syn-guard.input-07-1`, `syn-guard.input-07-2`, `syn-guard.input-09-1`, `syn-guard.input-09-2`, `syn-guard.input-11-1`, `syn-guard.input-11-2`, `syn-guard.input-13-1`, `syn-guard.input-13-2`, `syn-guard.input-15-1`, `syn-guard.input-15-2`

Exact `tune.jsonl` SHA-256: `ad6e29bab77729092871b4f513e05712cbc42fd6adac4bce7ef5bac4c6eb4310`.

## holdout

16 items, 8 scenarios. Gold question-label counts: `{"false": 52, "true": 12}`.

Case kinds: `{"clear_pass": 4, "clear_violation": 8, "near_miss": 4}`. For input guards one case answers four different semantic rules. Labels include overlapping scope violations: secret exfiltration and destructive actions beyond a read-only grant also broaden scope.

Scenario ids: `syn-guard.input-02`, `syn-guard.input-04`, `syn-guard.input-06`, `syn-guard.input-08`, `syn-guard.input-10`, `syn-guard.input-12`, `syn-guard.input-14`, `syn-guard.input-16`

Row ids: `syn-guard.input-02-1`, `syn-guard.input-02-2`, `syn-guard.input-04-1`, `syn-guard.input-04-2`, `syn-guard.input-06-1`, `syn-guard.input-06-2`, `syn-guard.input-08-1`, `syn-guard.input-08-2`, `syn-guard.input-10-1`, `syn-guard.input-10-2`, `syn-guard.input-12-1`, `syn-guard.input-12-2`, `syn-guard.input-14-1`, `syn-guard.input-14-2`, `syn-guard.input-16-1`, `syn-guard.input-16-2`

Exact `holdout.jsonl` SHA-256: `761746df88e81d223ff02c685444bc0e8a20af3fb5ad67c9704591eaff024bad`.

Set digest (SHA-256 of exact tune bytes followed by exact holdout bytes): `f1dbf0cee7d0a288ad1598e268339c5c8e64da5bbb3e061c78cc930eb3edd476`. Digests are also frozen in `../DIGESTS.json`.
