# audit.dispose set provenance

Fixed before provider runs. Split unit: `scenario_id`; a scenario never crosses the tune/holdout boundary. Question wording is supplied by production site builders, not stored or paraphrased in these fixtures.

**Synthetic.** Gold author: Codex (WHC-P10 author). Cases and gold labels authored offline before any provider run. Related cases are grouped into a scenario; odd scenarios tune, even scenarios holdout. No provider labels are used.

State size is capped using the conservative estimate `ceil(serialized_state_chars / 3) <= 4000`; all committed states satisfy it. Source selection is deterministic SHA-256 ordering within strata. Teacher distributions are excluded from provider state.

## tune

12 items, 4 scenarios. Gold question-label counts: `{"defer": 3, "fix_now": 3, "needs_human": 3, "reject_as_out_of_scope": 3}`.

Scenario ids: `syn-audit.dispose-01`, `syn-audit.dispose-03`, `syn-audit.dispose-05`, `syn-audit.dispose-07`

Row ids: `syn-audit.dispose-01-1`, `syn-audit.dispose-01-2`, `syn-audit.dispose-01-3`, `syn-audit.dispose-03-1`, `syn-audit.dispose-03-2`, `syn-audit.dispose-03-3`, `syn-audit.dispose-05-1`, `syn-audit.dispose-05-2`, `syn-audit.dispose-05-3`, `syn-audit.dispose-07-1`, `syn-audit.dispose-07-2`, `syn-audit.dispose-07-3`

Exact `tune.jsonl` SHA-256: `1417d65d286e67ac61604a1cde7e08fef909ff156ef415340e82cd44e2f0cfd1`.

## holdout

12 items, 4 scenarios. Gold question-label counts: `{"defer": 3, "fix_now": 3, "needs_human": 3, "reject_as_out_of_scope": 3}`.

Scenario ids: `syn-audit.dispose-02`, `syn-audit.dispose-04`, `syn-audit.dispose-06`, `syn-audit.dispose-08`

Row ids: `syn-audit.dispose-02-1`, `syn-audit.dispose-02-2`, `syn-audit.dispose-02-3`, `syn-audit.dispose-04-1`, `syn-audit.dispose-04-2`, `syn-audit.dispose-04-3`, `syn-audit.dispose-06-1`, `syn-audit.dispose-06-2`, `syn-audit.dispose-06-3`, `syn-audit.dispose-08-1`, `syn-audit.dispose-08-2`, `syn-audit.dispose-08-3`

Exact `holdout.jsonl` SHA-256: `6e89e6a6ad8ddf1b186201c223d7052be8431fa0c51667368700229da488eaee`.

Set digest (SHA-256 of exact tune bytes followed by exact holdout bytes): `f2e0617dbbabe5cb0bee71a9031808701e3d18e004883d52769f3b761e8f5476`. Digests are also frozen in `../DIGESTS.json`.
