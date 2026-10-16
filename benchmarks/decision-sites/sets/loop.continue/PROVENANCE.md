# loop.continue set provenance

Fixed before provider runs. Split unit: `scenario_id`; a scenario never crosses the tune/holdout boundary. Question wording is supplied by production site builders, not stored or paraphrased in these fixtures.

**Synthetic.** Gold author: Codex (WHC-P10 author). Cases and gold labels authored offline before any provider run. Related cases are grouped into a scenario; odd scenarios tune, even scenarios holdout. No provider labels are used.

State size is capped using the conservative estimate `ceil(serialized_state_chars / 3) <= 4000`; all committed states satisfy it. Source selection is deterministic SHA-256 ordering within strata. Teacher distributions are excluded from provider state.

## tune

12 items, 6 scenarios. Gold question-label counts: `{"progressing": 4, "regressing": 4, "stalled": 4}`.

Scenario ids: `syn-loop.continue-01`, `syn-loop.continue-03`, `syn-loop.continue-05`, `syn-loop.continue-07`, `syn-loop.continue-09`, `syn-loop.continue-11`

Row ids: `syn-loop.continue-01-1`, `syn-loop.continue-01-2`, `syn-loop.continue-03-1`, `syn-loop.continue-03-2`, `syn-loop.continue-05-1`, `syn-loop.continue-05-2`, `syn-loop.continue-07-1`, `syn-loop.continue-07-2`, `syn-loop.continue-09-1`, `syn-loop.continue-09-2`, `syn-loop.continue-11-1`, `syn-loop.continue-11-2`

Exact `tune.jsonl` SHA-256: `a3008a876b810ea0dd7a5ffcfeac9f7e0a42464f27b7d6886bcf4a1166ee872d`.

## holdout

12 items, 6 scenarios. Gold question-label counts: `{"progressing": 4, "regressing": 4, "stalled": 4}`.

Scenario ids: `syn-loop.continue-02`, `syn-loop.continue-04`, `syn-loop.continue-06`, `syn-loop.continue-08`, `syn-loop.continue-10`, `syn-loop.continue-12`

Row ids: `syn-loop.continue-02-1`, `syn-loop.continue-02-2`, `syn-loop.continue-04-1`, `syn-loop.continue-04-2`, `syn-loop.continue-06-1`, `syn-loop.continue-06-2`, `syn-loop.continue-08-1`, `syn-loop.continue-08-2`, `syn-loop.continue-10-1`, `syn-loop.continue-10-2`, `syn-loop.continue-12-1`, `syn-loop.continue-12-2`

Exact `holdout.jsonl` SHA-256: `4b0beacc8d326dc0153c2ddb8eb02571ddd22f5b8d36831b0e9120ef831c43e0`.

Set digest (SHA-256 of exact tune bytes followed by exact holdout bytes): `5e03d854c1f3c38433adb63e4aef975559b5918649ed4deee4eba75e5be8b1f1`. Digests are also frozen in `../DIGESTS.json`.
