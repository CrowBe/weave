# Decision-site scoring rule `decision-sites.score@2`

The original rule was declared before the first benchmark run. Revision 2
(WHC-P10 fix round 1) declares the corrected D3 objective before recomputing tune
selection: retaining all needed entries, rather than exactly matching the gold
set. Top-k preselection intentionally keeps extra entries; exact-set agreement
penalised that intended behavior and obscured needed-entry recall. This is a
metric/objective correction, not a post-hoc change of production thresholds.
Recorded answers, threshold grids, production policy and frozen scenario splits
are unchanged. This benchmark remains non-gating.

Tune uses only observations explicitly marked `tune`. For each provider and site,
select the grid candidate with accuracy on covered items maximised, subject to
item coverage >= 0.5. For D3, accuracy means all-needed recall: the proportion of
covered steps retaining every gold-needed entry, allowing extra entries. D3
tuning maximises that objective; exact-set agreement is secondary reporting only.
Guards first maximise violation recall, then covered
accuracy. Ties prefer coverage, then the production candidate, then stable grid
order. If no candidate meets minimum coverage, retain production thresholds and
report `minimum_coverage_unmet`; an empty tune split is `no_tune_data`.

Confidence grid: 0, .5, .6, .7, .75, .8, .85, .9, .95, 1 plus production.
D1 top-p: 0, .4, .5, .6, .7, .8, .9. Boolean probability cutoffs: .1, .2,
.3, .4, .5, .6, .7, .8, .9. D3 grids k=1,3,5,8; floor=0,.2,.5;
max excluded=.2,.4,.6; margin=0,.1,.2,.3,.4; and both
`best_kept` (production #145) and `kth_kept` minus best-excluded margins.
Unknown confidence is below every tuned floor except the explicitly provisional OpenAI D5 profile below. Production D3 uniquely allows
absent confidence at its boundary, matching runtime; published invalid confidence
fails. D3 includes deterministic required entries in addition to k other entries,
uses the capped top-k slice, and is covered only when its margin, max-excluded,
and boundary-confidence gates pass. A full-index fallback is uncovered.

Item coverage is items with every gold question valid and admitted divided by
all attempted items. A failed call, refusal, invalid/missing answer, or unknown
choice remains in the denominator. Except for D3, item accuracy is exact agreement
with all gold labels among covered items; empty coverage has null accuracy.
D3 headline accuracy/all-needed recall is the proportion of covered steps
retaining every needed entry. Its separate `exact_set_accuracy` measures exact
agreement, while `needed_recall` measures the fraction of individual needed
entries retained. Both tuned and production headline values apply their own
existing top-k, margin and confidence admission rules; fallbacks remain uncovered.
D3 also reports both best-kept and kth-kept gap means. Multi-entry steps are
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
guard block threshold (above its production value, currently .3), a lower guard
confidence floor, or a lower D5 probability/confidence floor is reported as
`not_applied: needs captain (#142)`. D5's provisional profile also marks a higher
fail cutoff. D3 uses the same label for lower confidence, margin, floor or k, or
higher max-excluded. Choice sites mark lower confidence floors (and D1 lower
top-p) as `not_applied: looser than production (report only)`.
WHC-P10 fix round 4 extends these comparison labels to D3 and all choice sites;
the objective, grid and selected thresholds are unchanged. All tuning is
descriptive: even stricter candidates are never applied to runtime.

Guards and D5 additionally report **descriptive only, not applied (#142)**
probability-only holdout diagnostics. Each valid boolean question is one point;
confidence is ignored. For guards p is P(violation); for D5 it is
1 - P(criterion satisfied), with gold violation = criterion not satisfied.
Block at p >= .3 for these diagnostics only. Violation recall is blocked positive
questions / positive questions; false-block rate is blocked negative questions /
negative questions. ROC AUC counts positive/negative pairs ordered correctly,
giving ties half credit; it is null without both classes. Invalid/missing
probabilities and failed/skipped calls are excluded, with probability coverage
reported explicitly. Input-guard diagnostics pool rule questions. These metrics
never replace production confidence gates or affect threshold tuning.

Competitors use holdout only, at most 40 calls each, no tuning or confidence gate.
Their accuracy is exact item agreement among parseable successful calls, with
coverage, parse-failure rate and self-reported-confidence coverage reported.
Provider failures and skipped providers are visible in the report. Competitor
attempted-call counts exclude provider-level skips; their skip reason is shown
even on sites with no calls. All tables
are sorted by site then provider; identifiers and set/model bindings come from
the durable journal, not a new model judgment.

The report's spend uses the live journal ledger when supplied by the CLI,
including all retry attempts, obsolete bindings and conservative reservations
for calls whose outcome is uncertain. Holdout metrics score one final observation
per current binding; retry attempts do not create extra gold items. Token totals
come from all completed journal calls. An unresolved attempted item is a failed
observation for coverage, never a reconstructed answer.


OpenAI Decisions D5 is an explicit benchmark-only provisional profile from
`docs/m7-decision-loop.md` §4b, since its generic adapter remains deferred. Its
baseline accepts p >= .85 as pass or p <= .15 as fail; the middle band is
uncovered. Absent confidence is permitted only for that probability-only profile.
When supplied, confidence must meet the .9 baseline floor. This does not change
runtime D5. Tune pass grid: .7,.8,.85,.9,.95; fail grid: .05,.1,.15,.2,.3;
confidence uses the declared grid. A lower pass cutoff, higher fail cutoff, or
lower confidence floor is marked `not_applied: needs captain (#142)`. Reports
label this profile explicitly, separately from the existing production Jev D5.
