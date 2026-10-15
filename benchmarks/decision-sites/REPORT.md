# Decision-site benchmark: offline-dry-run

Non-gating. Thresholds are fitted on tune only; runtime thresholds and guard behavior are unchanged.
Node: v22.23.3. Spend: $0.000000 / $2.00.
Models served: offline-fake.

| Site | Provider | Tuned thresholds | Holdout n | Tuned accuracy | Tuned coverage | Production accuracy | Production coverage |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| audit.dispose | fake | conf≥0.75; selected | 12 | 25.0% | 100.0% | 25.0% | 100.0% |
| eval.output | fake | conf≥0.9; p≥0.8; selected | 12 | 50.0% | 100.0% | 50.0% | 100.0% |
| guard.input | fake | conf≥0.9; p≥0.1; selected | 16 | 0.0% | 100.0% | 50.0% | 100.0% |
| guard.output | fake | conf≥0.9; p≥0.1; selected | 18 | 50.0% | 100.0% | 50.0% | 100.0% |
| intake.classify | fake | conf≥0.8; selected | 60 | 16.7% | 100.0% | 16.7% | 100.0% |
| loop.continue | fake | conf≥0.7; selected | 12 | 33.3% | 100.0% | 33.3% | 100.0% |
| loop.preselect | fake | conf≥0.75; k=1; floor=0; excluded≤0.2; best_kept gap≥0; selected | 20 | 5.0% | 100.0% | — | 0.0% |
| loop.route | fake | conf≥0.75; selected | 12 | 33.3% | 100.0% | 33.3% | 100.0% |
| loop.triage | fake | conf≥0.8; top-p≥0.6; selected | 50 | 20.0% | 100.0% | 20.0% | 100.0% |

Production thresholds are imported from the site policies (D1 top-p .6 and D6 confidence .75 follow their production transitions). Missing confidence counts below the floor except production D3 (unknown) and the explicitly provisional OpenAI D5 probability band (pass ≥.85, fail ≤.15). The OpenAI band is a benchmark assumption from docs §4b; its deferred adapter has no runtime production policy. Supplied D5 confidence still meets the floor.

| Site | Provider | Brier | ECE | Mean confidence | Missing confidence | Violation recall | Needed recall / all needed | Multi-entry steps | Best / kth gap | p50 / p90 ms | Input / output tokens | USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | --- | ---: |
| audit.dispose | fake | 0.750 | 0.750 | 0.950 | 0 | — | — / — | 0 | — / — | 0.000 / 0.000 | 0 / 0 | 0.000000 |
| eval.output | fake | 0.410 | 0.400 | 0.950 | 0 | — | — / — | 0 | — / — | 0.000 / 0.000 | 0 / 0 | 0.000000 |
| guard.input | fake | 0.160 | 0.088 | 0.950 | 0 | 100.0% | — / — | 0 | — / — | 0.000 / 0.000 | 0 / 0 | 0.000000 |
| guard.output | fake | 0.410 | 0.400 | 0.950 | 0 | 100.0% | — / — | 0 | — / — | 0.000 / 0.000 | 0 / 0 | 0.000000 |
| intake.classify | fake | 0.833 | 0.833 | 0.950 | 0 | — | — / — | 0 | — / — | 0.000 / 0.000 | 0 / 0 | 0.000000 |
| loop.continue | fake | 0.667 | 0.667 | 0.950 | 0 | — | — / — | 0 | — / — | 0.000 / 0.000 | 0 / 0 | 0.000000 |
| loop.preselect | fake | 0.053 | 0.046 | 0.950 | 0 | — | 7.7% / 5.0% | 4 | 0.000 / 0.000 | 0.000 / 0.000 | 0 / 0 | 0.000000 |
| loop.route | fake | 0.667 | 0.667 | 0.950 | 0 | — | — / — | 0 | — / — | 0.000 / 0.000 | 0 / 0 | 0.000000 |
| loop.triage | fake | 0.800 | 0.800 | 0.950 | 0 | — | — / — | 0 | — / — | 0.000 / 0.000 | 0 / 0 | 0.000000 |

## Competitors

Holdout only; no threshold tuning. Self-reported confidence is separate from probability calibration. Competitor served model ids are unobserved; chatgpt-sign-in is an authentication profile, not a served model id.

| Competitor | Site | Attempted | Accuracy | Parse-failure rate | Confidence coverage | Answer coverage |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| — | — | 0 | — | — | — | — |

## Provider statuses

No provider-status records. See per-provider attempted counts.

## Frozen set digests

| Set | SHA-256 |
| --- | --- |
| audit.dispose/holdout | 6e89e6a6ad8ddf1b186201c223d7052be8431fa0c51667368700229da488eaee |
| audit.dispose/set | f2e0617dbbabe5cb0bee71a9031808701e3d18e004883d52769f3b761e8f5476 |
| audit.dispose/tune | 1417d65d286e67ac61604a1cde7e08fef909ff156ef415340e82cd44e2f0cfd1 |
| eval.output/holdout | 0e056e5e1dcc9a33d182745f31fdd9ac34062597e884d451fab113c144ab79ae |
| eval.output/set | 1466ada861652fae093818f27cf3d62389d5ba0cffd2546ce49f06d179c75fe8 |
| eval.output/tune | a57b0cab71b6842a7bb3d18a66e2063862c33c9f079b3ba5c5c3e5819455e8be |
| guard.input/holdout | 761746df88e81d223ff02c685444bc0e8a20af3fb5ad67c9704591eaff024bad |
| guard.input/set | f1dbf0cee7d0a288ad1598e268339c5c8e64da5bbb3e061c78cc930eb3edd476 |
| guard.input/tune | ad6e29bab77729092871b4f513e05712cbc42fd6adac4bce7ef5bac4c6eb4310 |
| guard.output/holdout | e504fe8843592e72f24acd75789966efec7f0114856507fa7488d9599d7ab3c3 |
| guard.output/set | e825b7d1aed528fb9a5fbefb363a675478a86b89c5d575e77ff0423481ade07c |
| guard.output/tune | f7b45cdb0f396482c2d392ab7a9f91f7fbad0e23bd56afb217c07d79f5db28c7 |
| intake.classify/holdout | 8f8b2b33e686014844349ad6bb386dd11439ed625025fda496cdaf5619f8b9f1 |
| intake.classify/set | 60ab0c325c4a61d14be31f1e2424d4062adb35091ee7d6eacd2597eb059cd7c6 |
| intake.classify/tune | 7929c08f9299bdfe5275993ff9411d1d1a06d0a543c6685dc6e819b30e4812b2 |
| loop.continue/holdout | 4b0beacc8d326dc0153c2ddb8eb02571ddd22f5b8d36831b0e9120ef831c43e0 |
| loop.continue/set | 5e03d854c1f3c38433adb63e4aef975559b5918649ed4deee4eba75e5be8b1f1 |
| loop.continue/tune | a3008a876b810ea0dd7a5ffcfeac9f7e0a42464f27b7d6886bcf4a1166ee872d |
| loop.preselect/holdout | aa037729b22e087f0fc37ac4cd97100ae666d96bd44ed4fb0f7673510630ae96 |
| loop.preselect/set | b8231051b1cdafd247d46b7e4b5acb492e7df2ec5125b8be7a7d7fafdf8ea51d |
| loop.preselect/tune | 3df43e160c310e8b649741f6d22b01e020a03c44a5c0d3a0ccf73507d257e384 |
| loop.route/holdout | 0a6e5a5e689e746c32cb9addcddd36a8e2237ca03764bd70169a7bf4f0df1eb2 |
| loop.route/set | 72a0aea7b660002290dca5610cf7dc1f7794b60d51fc873df1117a12ea539bae |
| loop.route/tune | 0edaec11527d0e88530295cad8ac289c45c7ed45b48acaf124db142c55c4c2e6 |
| loop.triage/holdout | afe4e7f248efd9f2cfbf7b6a3c9f683776963351f54b3bbc29e71ad3e23337e5 |
| loop.triage/set | 9ddae6f34801a33ea5a42c95f4b788c5332752626829af5f3e6264b903ba7971 |
| loop.triage/tune | c5a5696c2be58eb489f743efac581bbd0f0ea747e5bd706cfabcbff4613b5750 |

See [SCORING.md](SCORING.md) for the predeclared objective, denominators and threshold grids.


Ledger spend (including pending reservations): $0.00000000
