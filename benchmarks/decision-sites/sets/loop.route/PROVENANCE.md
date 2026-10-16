# loop.route set provenance

Fixed before provider runs. Split unit: `scenario_id`; a scenario never crosses the tune/holdout boundary. Question wording is supplied by production site builders, not stored or paraphrased in these fixtures.

**Synthetic.** Gold author: Codex (WHC-P10 author). Cases and gold labels authored offline before any provider run. Related cases are grouped into a scenario; odd scenarios tune, even scenarios holdout. No provider labels are used.

State size is capped using the conservative estimate `ceil(serialized_state_chars / 3) <= 4000`; all committed states satisfy it. Source selection is deterministic SHA-256 ordering within strata. Teacher distributions are excluded from provider state.

## tune

12 items, 6 scenarios. Gold question-label counts: `{"flash": 4, "standard": 4, "strong": 4}`.

Scenario ids: `syn-loop.route-01`, `syn-loop.route-03`, `syn-loop.route-05`, `syn-loop.route-07`, `syn-loop.route-09`, `syn-loop.route-11`

Row ids: `syn-loop.route-01-1`, `syn-loop.route-01-2`, `syn-loop.route-03-1`, `syn-loop.route-03-2`, `syn-loop.route-05-1`, `syn-loop.route-05-2`, `syn-loop.route-07-1`, `syn-loop.route-07-2`, `syn-loop.route-09-1`, `syn-loop.route-09-2`, `syn-loop.route-11-1`, `syn-loop.route-11-2`

Exact `tune.jsonl` SHA-256: `0edaec11527d0e88530295cad8ac289c45c7ed45b48acaf124db142c55c4c2e6`.

## holdout

12 items, 6 scenarios. Gold question-label counts: `{"flash": 4, "standard": 4, "strong": 4}`.

Scenario ids: `syn-loop.route-02`, `syn-loop.route-04`, `syn-loop.route-06`, `syn-loop.route-08`, `syn-loop.route-10`, `syn-loop.route-12`

Row ids: `syn-loop.route-02-1`, `syn-loop.route-02-2`, `syn-loop.route-04-1`, `syn-loop.route-04-2`, `syn-loop.route-06-1`, `syn-loop.route-06-2`, `syn-loop.route-08-1`, `syn-loop.route-08-2`, `syn-loop.route-10-1`, `syn-loop.route-10-2`, `syn-loop.route-12-1`, `syn-loop.route-12-2`

Exact `holdout.jsonl` SHA-256: `0a6e5a5e689e746c32cb9addcddd36a8e2237ca03764bd70169a7bf4f0df1eb2`.

Set digest (SHA-256 of exact tune bytes followed by exact holdout bytes): `72a0aea7b660002290dca5610cf7dc1f7794b60d51fc873df1117a12ea539bae`. Digests are also frozen in `../DIGESTS.json`.
