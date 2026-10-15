# Decision-site scoring rule `decision-sites.score@1`

Declared before any benchmark run. This benchmark is non-gating and never changes
runtime policy. Frozen scenario ids are disjoint between tune and holdout.

Tune uses only observations explicitly marked `tune`. For each provider and site,
select the grid candidate with accuracy on covered items maximised, subject to
item coverage >= 0.5. Guards first maximise violation recall, then covered
accuracy. Ties prefer coverage, then the production candidate, then stable grid
order. If no candidate meets minimum coverage, retain production thresholds and
report `minimum_coverage_unmet`; an empty tune split is `no_tune_data`.

Confidence grid: 0, .5, .6, .7, .75, .8, .85, .9, .95, 1 plus production.
D1 top-p: 0, .4, .5, .6, .7, .8, .9. Boolean probability cutoffs: .1, .2,
.3, .4, .5, .6, .7, .8, .9. D3 grids k=1,3,5,8; floor=0,.2,.5;
max excluded=.2,.4,.6; margin=0,.1,.2,.3,.4; and both
`best_kept` (production #145) and `kth_kept` minus best-excluded margins.
Unknown confidence is below every tuned floor. Production D3 uniquely allows
absent confidence at its boundary, matching runtime; published invalid confidence
fails. D3 includes deterministic required entries in addition to k other entries,
uses the capped top-k slice, and is covered only when its margin, max-excluded,
and boundary-confidence gates pass. A full-index fallback is uncovered.

Item coverage is items with every gold question valid and admitted divided by
all attempted items. A failed call, refusal, invalid/missing answer, or unknown
choice remains in the denominator. Item accuracy is exact agreement with all
gold labels among covered items; empty coverage has null accuracy. D3 additionally
reports needed-entry recall and the proportion of covered steps retaining every
needed entry, plus both best-kept and kth-kept gap means. Multi-entry steps are
counted explicitly. Guard violation recall counts each gold-positive rule, and
uncovered positive rules are misses. Threshold comparisons use >=.

Brier and ten equal-width bin ECE use every valid supplied probability, including
uncovered items: boolean P(true) versus gold, and choice selected probability
versus selected-choice correctness (top-label Brier, as in the Jev harness).
Calibration does not silently substitute self-reported confidence for probability.
Missing probability yields null calibration. Mean confidence and missing-confidence
count are separate. Latency quantiles use sorted nearest-rank positions
floor(q*(n-1)); tokens and cost sum recorded completed calls.

Holdout is evaluated once with tune-selected and production thresholds. A looser
guard block threshold (> .3), a lower guard confidence floor, or a lower D5
probability/confidence floor is reported as `not_applied: needs captain (#142)`.
All tuning is descriptive: even stricter candidates are never applied to runtime.

Competitors use holdout only, at most 40 calls each, no tuning or confidence gate.
Their accuracy is exact item agreement among parseable successful calls, with
coverage, parse-failure rate and self-reported-confidence coverage reported.
Provider failures and skipped providers are visible in the report. All tables
are sorted by site then provider; identifiers and set/model bindings come from
the durable journal, not a new model judgment.
