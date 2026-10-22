# Decision-site benchmark: live-20261015

Non-gating. Thresholds are fitted on tune only; runtime thresholds and guard behavior are unchanged.
Scoring rule: decision-sites.score@2 (D3 all-needed objective correction; see SCORING.md).
Node: v22.23.3. Spend: $0.011831 / $2.00.
Models served: amos-1-2b, jev-1.14.0.

D3 headline accuracy is all-needed recall among covered steps: every needed entry is kept, and extra entries are permitted. Exact-set agreement remains secondary. Full-index fallbacks remain uncovered.

| Site            | Provider         | Tuned thresholds                                                                 | Holdout n | Tuned accuracy / D3 all-needed recall | Tuned coverage | Production accuracy / D3 all-needed recall | Production coverage | Exact-set tuned | Exact-set production |
| --------------- | ---------------- | -------------------------------------------------------------------------------- | --------: | ------------------------------------: | -------------: | -----------------------------------------: | ------------------: | --------------: | -------------------: |
| audit.dispose   | amos-small       | conf≥0.75; selected                                                              |        12 |                                100.0% |           8.3% |                                     100.0% |                8.3% |               — |                    — |
| audit.dispose   | openai-decisions | conf≥0.75; no_tune_data                                                          |         0 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| audit.dispose   | typesafe-jev     | conf≥0.95; selected                                                              |        12 |                                100.0% |          50.0% |                                      88.9% |               75.0% |               — |                    — |
| eval.output     | amos-small       | conf≥0.9; p≥0.8; minimum_coverage_unmet                                          |        12 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| eval.output     | openai-decisions | conf≥0.9; p≥0.85; fail-p≤0.15; openai-provisional-probability-band; no_tune_data |         0 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| eval.output     | typesafe-jev     | conf≥0.9; p≥0.8; minimum_coverage_unmet                                          |        12 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| guard.input     | amos-small       | conf≥0.9; p≥0.3; minimum_coverage_unmet                                          |        16 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| guard.input     | openai-decisions | conf≥0.9; p≥0.3; no_tune_data                                                    |         0 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| guard.input     | typesafe-jev     | conf≥0.9; p≥0.3; minimum_coverage_unmet                                          |        16 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| guard.output    | amos-small       | conf≥0.9; p≥0.3; minimum_coverage_unmet                                          |        18 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| guard.output    | openai-decisions | conf≥0.9; p≥0.3; no_tune_data                                                    |         0 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| guard.output    | typesafe-jev     | conf≥0.9; p≥0.3; minimum_coverage_unmet                                          |        18 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| intake.classify | amos-small       | conf≥0.5; selected; not_applied: looser than production (report only)            |        60 |                                 87.9% |          55.0% |                                     100.0% |               26.7% |               — |                    — |
| intake.classify | openai-decisions | conf≥0.8; minimum_coverage_unmet                                                 |         0 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| intake.classify | typesafe-jev     | conf≥0.75; selected; not_applied: looser than production (report only)           |        60 |                                 94.9% |          65.0% |                                      97.1% |               56.7% |               — |                    — |
| loop.continue   | amos-small       | conf≥0.5; selected; not_applied: looser than production (report only)            |        12 |                                100.0% |          75.0% |                                     100.0% |               66.7% |               — |                    — |
| loop.continue   | openai-decisions | conf≥0.7; no_tune_data                                                           |         0 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| loop.continue   | typesafe-jev     | conf≥0.7; selected                                                               |        12 |                                100.0% |         100.0% |                                     100.0% |              100.0% |               — |                    — |
| loop.preselect  | amos-small       | conf≥0.75; k=3; floor=0; excluded≤0.4; best_kept gap≥0.3; minimum_coverage_unmet |        20 |                                100.0% |          65.0% |                                     100.0% |               65.0% |            0.0% |                 0.0% |
| loop.preselect  | openai-decisions | conf≥0.75; k=3; floor=0; excluded≤0.4; best_kept gap≥0.3; no_tune_data           |         0 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| loop.preselect  | typesafe-jev     | conf≥0.75; k=3; floor=0; excluded≤0.4; best_kept gap≥0.3; minimum_coverage_unmet |        20 |                                100.0% |          85.0% |                                     100.0% |               85.0% |            5.9% |                 5.9% |
| loop.route      | amos-small       | conf≥0; selected; not_applied: looser than production (report only)              |        12 |                                 41.7% |         100.0% |                                       0.0% |                8.3% |               — |                    — |
| loop.route      | openai-decisions | conf≥0.75; no_tune_data                                                          |         0 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| loop.route      | typesafe-jev     | conf≥0.6; selected; not_applied: looser than production (report only)            |        12 |                                100.0% |          50.0% |                                     100.0% |               16.7% |               — |                    — |
| loop.triage     | amos-small       | conf≥0; top-p≥0.7; selected; not_applied: looser than production (report only)   |        50 |                                 72.7% |          44.0% |                                      71.4% |               28.0% |               — |                    — |
| loop.triage     | openai-decisions | conf≥0.8; top-p≥0.6; no_tune_data                                                |         0 |                                     — |           0.0% |                                          — |                0.0% |               — |                    — |
| loop.triage     | typesafe-jev     | conf≥0; top-p≥0.6; selected; not_applied: looser than production (report only)   |        50 |                                 97.5% |          80.0% |                                     100.0% |               56.0% |               — |                    — |

Production thresholds are imported from the site policies (D1 top-p .6 and D6 confidence .75 follow their production transitions). Missing confidence counts below the floor except production D3 (unknown) and the explicitly provisional OpenAI D5 probability band (pass ≥.85, fail ≤.15). The OpenAI band is a benchmark assumption from docs §4b; its deferred adapter has no runtime production policy. Supplied D5 confidence still meets the floor.

| Site            | Provider         | Brier |   ECE | Mean confidence | Missing confidence | Violation recall | Needed recall / all needed | Multi-entry steps | Best / kth gap | p50 / p90 ms        | Input / output tokens |      USD |
| --------------- | ---------------- | ----: | ----: | --------------: | -----------------: | ---------------: | -------------------------- | ----------------: | -------------- | ------------------- | --------------------- | -------: |
| audit.dispose   | amos-small       | 0.156 | 0.306 |           0.541 |                  0 |                — | — / —                      |                 0 | — / —          | 359.000 / 418.000   | 1616 / 0              | 0.000000 |
| audit.dispose   | openai-decisions |     — |     — |               — |                  0 |                — | — / —                      |                 0 | — / —          | — / —               | 0 / 0                 | 0.000000 |
| audit.dispose   | typesafe-jev     | 0.130 | 0.131 |           0.828 |                  0 |                — | — / —                      |                 0 | — / —          | 42.000 / 44.000     | 4440 / 689            | 0.000186 |
| eval.output     | amos-small       | 0.083 | 0.096 |               — |                 12 |                — | — / —                      |                 0 | — / —          | 367.000 / 435.000   | 1657 / 0              | 0.000000 |
| eval.output     | openai-decisions |     — |     — |               — |                  0 |                — | — / —                      |                 0 | — / —          | — / —               | 0 / 0                 | 0.000000 |
| eval.output     | typesafe-jev     | 0.070 | 0.075 |               — |                 12 |                — | — / —                      |                 0 | — / —          | 42.000 / 48.000     | 4374 / 288            | 0.000184 |
| guard.input     | amos-small       | 0.182 | 0.183 |               — |                 64 |             0.0% | — / —                      |                 0 | — / —          | 482.000 / 553.000   | 3328 / 0              | 0.000000 |
| guard.input     | openai-decisions |     — |     — |               — |                  0 |                — | — / —                      |                 0 | — / —          | — / —               | 0 / 0                 | 0.000000 |
| guard.input     | typesafe-jev     | 0.148 | 0.231 |               — |                 64 |             0.0% | — / —                      |                 0 | — / —          | 43.000 / 67.000     | 6117 / 1344           | 0.000257 |
| guard.output    | amos-small       | 0.070 | 0.233 |               — |                 18 |             0.0% | — / —                      |                 0 | — / —          | 353.000 / 389.000   | 1975 / 0              | 0.000000 |
| guard.output    | openai-decisions |     — |     — |               — |                  0 |                — | — / —                      |                 0 | — / —          | — / —               | 0 / 0                 | 0.000000 |
| guard.output    | typesafe-jev     | 0.014 | 0.097 |               — |                 18 |             0.0% | — / —                      |                 0 | — / —          | 42.000 / 46.000     | 5651 / 360            | 0.000237 |
| intake.classify | amos-small       | 0.171 | 0.075 |           0.579 |                  0 |                — | — / —                      |                 0 | — / —          | 602.000 / 720.000   | 15277 / 0             | 0.000000 |
| intake.classify | openai-decisions |     — |     — |               — |                  0 |                — | — / —                      |                 0 | — / —          | — / —               | 0 / 0                 | 0.000000 |
| intake.classify | typesafe-jev     | 0.117 | 0.102 |           0.763 |                  0 |                — | — / —                      |                 0 | — / —          | 44.000 / 58.000     | 30512 / 3755          | 0.001282 |
| loop.continue   | amos-small       | 0.081 | 0.217 |           0.704 |                  0 |                — | — / —                      |                 0 | — / —          | 441.000 / 673.000   | 1268 / 0              | 0.000000 |
| loop.continue   | openai-decisions |     — |     — |               — |                  0 |                — | — / —                      |                 0 | — / —          | — / —               | 0 / 0                 | 0.000000 |
| loop.continue   | typesafe-jev     | 0.004 | 0.032 |           0.950 |                  0 |                — | — / —                      |                 0 | — / —          | 44.000 / 86.000     | 4009 / 536            | 0.000168 |
| loop.preselect  | amos-small       | 0.047 | 0.120 |               — |                480 |                — | 100.0% / 100.0%            |                 4 | 0.611 / 0.088  | 3975.000 / 4759.000 | 40673 / 0             | 0.000000 |
| loop.preselect  | openai-decisions |     — |     — |               — |                  0 |                — | — / —                      |                 0 | — / —          | — / —               | 0 / 0                 | 0.000000 |
| loop.preselect  | typesafe-jev     | 0.026 | 0.104 |               — |                480 |                — | 100.0% / 100.0%            |                 4 | 0.726 / 0.118  | 59.000 / 68.000     | 50887 / 9000          | 0.002137 |
| loop.route      | amos-small       | 0.314 | 0.269 |           0.506 |                  0 |                — | — / —                      |                 0 | — / —          | 313.000 / 336.000   | 1310 / 0              | 0.000000 |
| loop.route      | openai-decisions |     — |     — |               — |                  0 |                — | — / —                      |                 0 | — / —          | — / —               | 0 / 0                 | 0.000000 |
| loop.route      | typesafe-jev     | 0.084 | 0.268 |           0.594 |                  0 |                — | — / —                      |                 0 | — / —          | 43.000 / 48.000     | 3984 / 456            | 0.000167 |
| loop.triage     | amos-small       | 0.228 | 0.145 |           0.581 |                  0 |                — | — / —                      |                 0 | — / —          | 804.000 / 961.000   | 18921 / 0             | 0.000000 |
| loop.triage     | openai-decisions |     — |     — |               — |                  0 |                — | — / —                      |                 0 | — / —          | — / —               | 0 / 0                 | 0.000000 |
| loop.triage     | typesafe-jev     | 0.069 | 0.122 |           0.770 |                  0 |                — | — / —                      |                 0 | — / —          | 46.000 / 54.000     | 29932 / 3023          | 0.001257 |

## Probability-only safety diagnostics

**descriptive only, not applied (#142)**. Holdout questions with valid probabilities only; confidence is ignored. Block at P(violation) ≥ .3. For D5, violation means an unsatisfied criterion: P(violation) = 1 − P(satisfied). AUC gives ties half credit and is undefined without both classes. Production gates above are unchanged.

| Site         | Provider         | Violation recall | False-block rate |   AUC | Probability coverage |
| ------------ | ---------------- | ---------------: | ---------------: | ----: | -------------------: |
| eval.output  | amos-small       |            83.3% |             0.0% | 0.861 |               100.0% |
| eval.output  | openai-decisions |                — |                — |     — |                 0.0% |
| eval.output  | typesafe-jev     |            83.3% |             0.0% | 1.000 |               100.0% |
| guard.input  | amos-small       |            75.0% |            28.8% | 0.845 |               100.0% |
| guard.input  | openai-decisions |                — |                — |     — |                 0.0% |
| guard.input  | typesafe-jev     |           100.0% |            34.6% | 0.989 |               100.0% |
| guard.output | amos-small       |           100.0% |            55.6% | 1.000 |               100.0% |
| guard.output | openai-decisions |                — |                — |     — |                 0.0% |
| guard.output | typesafe-jev     |           100.0% |             0.0% | 1.000 |               100.0% |

## Competitors

Holdout only; no threshold tuning. Provider-level skips are not attempted inference calls. Self-reported confidence is separate from probability calibration. Competitor served model ids are unobserved; chatgpt-sign-in is an authentication profile, not a served model id.

| Competitor | Site            | Attempted | Accuracy | Parse-failure rate | Confidence coverage | Answer coverage | Skip reason   |
| ---------- | --------------- | --------: | -------: | -----------------: | ------------------: | --------------: | ------------- |
| fx-ask     | audit.dispose   |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| pi         | audit.dispose   |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| fx-ask     | eval.output     |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| pi         | eval.output     |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| fx-ask     | guard.input     |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| pi         | guard.input     |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| fx-ask     | guard.output    |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| pi         | guard.output    |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| fx-ask     | intake.classify |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| pi         | intake.classify |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| fx-ask     | loop.continue   |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| pi         | loop.continue   |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| fx-ask     | loop.preselect  |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| pi         | loop.preselect  |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| fx-ask     | loop.route      |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| pi         | loop.route      |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| fx-ask     | loop.triage     |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |
| pi         | loop.triage     |         0 |        — |               0.0% |                0.0% |            0.0% | auth_required |

## Provider statuses

- `{"type":"provider_status","provider":"fx-ask","persistent":true,"result":{"status":"skipped","reason":"auth_required"}}`
- `{"type":"provider_status","provider":"openai-decisions","result":{"status":"skipped","reason":"no_credential"}}`
- `{"type":"provider_status","provider":"pi","persistent":true,"result":{"status":"skipped","reason":"auth_required"}}`

## Frozen set digests

| Set                     | SHA-256                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| audit.dispose/holdout   | 6e89e6a6ad8ddf1b186201c223d7052be8431fa0c51667368700229da488eaee |
| audit.dispose/set       | f2e0617dbbabe5cb0bee71a9031808701e3d18e004883d52769f3b761e8f5476 |
| audit.dispose/tune      | 1417d65d286e67ac61604a1cde7e08fef909ff156ef415340e82cd44e2f0cfd1 |
| eval.output/holdout     | 0e056e5e1dcc9a33d182745f31fdd9ac34062597e884d451fab113c144ab79ae |
| eval.output/set         | 1466ada861652fae093818f27cf3d62389d5ba0cffd2546ce49f06d179c75fe8 |
| eval.output/tune        | a57b0cab71b6842a7bb3d18a66e2063862c33c9f079b3ba5c5c3e5819455e8be |
| guard.input/holdout     | 761746df88e81d223ff02c685444bc0e8a20af3fb5ad67c9704591eaff024bad |
| guard.input/set         | f1dbf0cee7d0a288ad1598e268339c5c8e64da5bbb3e061c78cc930eb3edd476 |
| guard.input/tune        | ad6e29bab77729092871b4f513e05712cbc42fd6adac4bce7ef5bac4c6eb4310 |
| guard.output/holdout    | e504fe8843592e72f24acd75789966efec7f0114856507fa7488d9599d7ab3c3 |
| guard.output/set        | e825b7d1aed528fb9a5fbefb363a675478a86b89c5d575e77ff0423481ade07c |
| guard.output/tune       | f7b45cdb0f396482c2d392ab7a9f91f7fbad0e23bd56afb217c07d79f5db28c7 |
| intake.classify/holdout | 8f8b2b33e686014844349ad6bb386dd11439ed625025fda496cdaf5619f8b9f1 |
| intake.classify/set     | 60ab0c325c4a61d14be31f1e2424d4062adb35091ee7d6eacd2597eb059cd7c6 |
| intake.classify/tune    | 7929c08f9299bdfe5275993ff9411d1d1a06d0a543c6685dc6e819b30e4812b2 |
| loop.continue/holdout   | 4b0beacc8d326dc0153c2ddb8eb02571ddd22f5b8d36831b0e9120ef831c43e0 |
| loop.continue/set       | 5e03d854c1f3c38433adb63e4aef975559b5918649ed4deee4eba75e5be8b1f1 |
| loop.continue/tune      | a3008a876b810ea0dd7a5ffcfeac9f7e0a42464f27b7d6886bcf4a1166ee872d |
| loop.preselect/holdout  | aa037729b22e087f0fc37ac4cd97100ae666d96bd44ed4fb0f7673510630ae96 |
| loop.preselect/set      | b8231051b1cdafd247d46b7e4b5acb492e7df2ec5125b8be7a7d7fafdf8ea51d |
| loop.preselect/tune     | 3df43e160c310e8b649741f6d22b01e020a03c44a5c0d3a0ccf73507d257e384 |
| loop.route/holdout      | 0a6e5a5e689e746c32cb9addcddd36a8e2237ca03764bd70169a7bf4f0df1eb2 |
| loop.route/set          | 72a0aea7b660002290dca5610cf7dc1f7794b60d51fc873df1117a12ea539bae |
| loop.route/tune         | 0edaec11527d0e88530295cad8ac289c45c7ed45b48acaf124db142c55c4c2e6 |
| loop.triage/holdout     | afe4e7f248efd9f2cfbf7b6a3c9f683776963351f54b3bbc29e71ad3e23337e5 |
| loop.triage/set         | 9ddae6f34801a33ea5a42c95f4b788c5332752626829af5f3e6264b903ba7971 |
| loop.triage/tune        | c5a5696c2be58eb489f743efac581bbd0f0ea747e5bd706cfabcbff4613b5750 |

See [SCORING.md](SCORING.md) for the predeclared objective, denominators and threshold grids.

Ledger spend (including pending reservations): $0.01183098
