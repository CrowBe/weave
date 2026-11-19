# eval.output set provenance

Fixed before provider runs. Split unit: `scenario_id`; a scenario never crosses the tune/holdout boundary. Question wording is supplied by production site builders, not stored or paraphrased in these fixtures.

**Synthetic.** Gold author: Codex (WHC-P10 author). Cases and gold labels authored offline before any provider run. Related cases are grouped into a scenario; odd scenarios tune, even scenarios holdout. No provider labels are used.

State size is capped using the conservative estimate `ceil(serialized_state_chars / 3) <= 4000`; all committed states satisfy it. Source selection is deterministic SHA-256 ordering within strata. Teacher distributions are excluded from provider state.

## tune

12 items, 6 scenarios. Gold question-label counts: `{"false": 6, "true": 6}`.

Scenario ids: `syn-eval.output-01`, `syn-eval.output-03`, `syn-eval.output-05`, `syn-eval.output-07`, `syn-eval.output-09`, `syn-eval.output-11`

Row ids: `syn-eval.output-01-1`, `syn-eval.output-01-2`, `syn-eval.output-03-1`, `syn-eval.output-03-2`, `syn-eval.output-05-1`, `syn-eval.output-05-2`, `syn-eval.output-07-1`, `syn-eval.output-07-2`, `syn-eval.output-09-1`, `syn-eval.output-09-2`, `syn-eval.output-11-1`, `syn-eval.output-11-2`

Exact `tune.jsonl` SHA-256: `a57b0cab71b6842a7bb3d18a66e2063862c33c9f079b3ba5c5c3e5819455e8be`.

## holdout

12 items, 6 scenarios. Gold question-label counts: `{"false": 6, "true": 6}`.

Scenario ids: `syn-eval.output-02`, `syn-eval.output-04`, `syn-eval.output-06`, `syn-eval.output-08`, `syn-eval.output-10`, `syn-eval.output-12`

Row ids: `syn-eval.output-02-1`, `syn-eval.output-02-2`, `syn-eval.output-04-1`, `syn-eval.output-04-2`, `syn-eval.output-06-1`, `syn-eval.output-06-2`, `syn-eval.output-08-1`, `syn-eval.output-08-2`, `syn-eval.output-10-1`, `syn-eval.output-10-2`, `syn-eval.output-12-1`, `syn-eval.output-12-2`

Exact `holdout.jsonl` SHA-256: `0e056e5e1dcc9a33d182745f31fdd9ac34062597e884d451fab113c144ab79ae`.

Set digest (SHA-256 of exact tune bytes followed by exact holdout bytes): `1466ada861652fae093818f27cf3d62389d5ba0cffd2546ce49f06d179c75fe8`. Digests are also frozen in `../DIGESTS.json`.
