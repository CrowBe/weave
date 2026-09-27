# BEV Decision Mix: 24-case local smoke test

This is a small exploratory check that [BEV 150K Decision Mix](https://huggingface.co/datasets/avbiswas/bev-decision-150K)
can be sampled, passed through a native typed-decision interface, and scored
without giving the model the reference labels. It is **not** a protected Weave
benchmark or evidence for routing `capability.match` or `result.evaluate`.
The [dataset audit](../../../docs/research/bev-decision-150k-audit.md) records
source-text injection exposure, train/test overlap, label imbalance, missing
row-level source provenance, and the release's unknown blanket license.

## Frozen sample and data review

`select.py` checks the pinned Parquet SHA-256 files at dataset revision
`f83fe8b97094112fa305bfc793be07c8f8742282` and selects from its published
test split. It deterministically ranks candidates by a fixed seed, taking four
cases from each of six domain/type cells: support choice, workflow choice,
reading NOUL, workflow NOUL, retail invoice Score, and movie sentiment Score.
It filters long states, contact/URL and explicit override patterns, invalid
typed questions, and exact NFKC-normalized train-state matches. The reading
and invoice cells are label-balanced by design. Two first-ranked examples
were excluded after manual review: an airport-location question whose false
label is ambiguous, and a restaurant-booking question where the available
place-search tool could plausibly help despite a false label.

All 24 selected states, questions, criteria, and labels were inspected. The
four invoice labels were independently checked by multiplying each quantity
by its unit price, summing absolute line values, and applying the stated GBP
bands. This review does not establish source-family independence or resolve
every subjective label. In particular, service-domain intent labels depend on
the upstream taxonomy, and sentiment levels are ordinal judgments.

`cases.json` (state plus allowlisted `type`, `instructions`, `criteria`) and
`labels.json` are separate files under ignored
`.local/bev-decision-150k/<revision>/sample-v1/`. Their raw public-source text
is kept out of the repository because the mixed-source release does not grant
a blanket redistribution license. The checked-in [result](kev-results.json)
records selected IDs, labels, probability outputs, and metrics without source
text. Dataset text is untrusted input; no tool was made available to the model.

## Local Kev result

The pinned Kev 4B local predictor completed all **24/24** requests on CPU with
strict state encoding; all distributions had the requested option keys and
valid probability sums. Kev's native continuous Score is the distribution's
expected level; our exact-decision scorer rounds it to the nearest ordinal
(half up). The modal option gives a different answer on one invoice case.
The result pins the local adapter, pointer head, training-config hashes, and
backbone revision in addition to the dataset hashes.

| Cell | N | Decision exact (Score rounded) | First-option baseline |
| --- | ---: | ---: | ---: |
| Support choice | 4 | 2 | 3 |
| Workflow choice | 4 | 3 | 1 |
| Reading NOUL | 4 | 3 | 2 |
| Workflow NOUL | 4 | 4 | 2 |
| Retail invoice Score | 4 | 2 | 2 |
| Movie sentiment Score | 4 | 3 | 0 |
| **Total** | **24** | **17 (70.8%)** | **10 (41.7%)** |

For Score alone, rounded exact accuracy was **5/8**, total ordinal absolute
error was **3 levels**, and the continuous expected-level mean absolute error
was **0.516 levels**. Modal-option accuracy was 4/8, making the
overall modal-option total 16/24. The sample's in-sample per-cell majority
baseline was also 10/24; it is descriptive and optimistic, not an independent
predictor. Two support taxonomy errors, a `grande` size error, one reading
distinction, two invoice-band errors, and one sentiment level account for the
seven native misses. These 24 hand-reviewed cases show a workable harness and
some discriminating examples; they cannot estimate general decision quality.

The full process took **170.08 s** wall clock. Per-case model latency was
**6.03 s median** and **6.58 s mean**, with **19.18 GiB** peak process RSS,
four CPU threads, and offline pinned weights. Loading is included in
wall clock and excluded from the per-case model latency.

## Hosted Jev paired probe — 12 cases

`jev-probe.ts` freezes 12 of the same IDs, two per cell. It takes positions 0
and 2 in the reading and invoice cells so both known labels are represented;
the other cells use positions 0 and 1. The selected IDs and hashes of the
cases/labels files are recorded in `jev-results.json`. The model-visible
payload is limited to state and one typed question; labels are loaded separately
to verify pairing and are never included in the request. They are used for
offline scoring. The sample state remains untrusted input.

The first sandboxed request failed before DNS resolution; that diagnostic is
kept separately under ignored `.local/`. Gateway accounting recorded **336
micros** on that failed attempt, which does not establish that Jev was reached.
With network access enabled, the
12-case run completed through `typesafe-ai/jev` on the Vercel AI Gateway. All
12 responses reported the expected route and model identity, and each had one
accepted attempt. The runner did not route directly to TypeSafe or retry.

| Cell | N | Jev correct | Kev correct |
| --- | ---: | ---: | ---: |
| Support and intent routing / choice | 2 | 1 | 2 |
| Tool and workflow decisions / choice | 2 | 2 | 1 |
| Reading comprehension / NOUL | 2 | 2 | 2 |
| Tool and workflow decisions / NOUL | 2 | 2 | 2 |
| Retail invoice / Score | 2 | 2 | 1 |
| Sentiment / Score | 2 | 2 | 2 |
| **Total** | **12** | **11 (91.7%)** | **10 (83.3%)** |

There were nine cases both models got right, two Jev-only, one Kev-only, and
no cases both missed. Both invoice Score cases were correct for Jev; Kev got
one. Across all four Score cases, Jev rounded the expected values half up and
matched **4/4** labels, while Kev matched **3/4**. The sample is tiny and
selected from a reviewed smoke set, so these counts are descriptive only.
They do not support a general Jev-versus-Kev quality claim.

The Vercel gateway reported **200.802 micros** total (about **0.000201** in
the configured price's currency unit), at **448 ms mean** per request.
`preferFree` is a throttle policy, not a guarantee of free inference. Per-case
raw answers, statuses, model identity, latency, reported spend, labels, and
paired Kev outcomes are in `jev-results.json`.

Reproduce the same paired subset:

```sh
node --env-file-if-exists=.env.local --experimental-strip-types \
  benchmarks/inference/bev-sample/jev-probe.ts
```

The probe has a hard one-attempt-per-case setting and no direct TypeSafe route.
`preferFree` controls gateway throttle routing; it does not guarantee zero
spend. Reported costs use the gateway's microcurrency accounting.

## Reproduce and extend

Use the existing pinned local Parquet files and Kev environment:

```sh
/home/bencrow/.local/share/weave/kev/src/.venv/bin/python \
  benchmarks/inference/bev-sample/select.py
HF_HOME=/home/bencrow/.local/share/weave/kev/hf HF_HUB_OFFLINE=1 \
  TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=4 \
  /home/bencrow/.local/share/weave/kev/src/.venv/bin/python \
  benchmarks/inference/bev-sample/runner.py \
  --output .local/bev-decision-150k/reproduction-kev-results.json
```

Run `--limit 2` first on a new machine to check input acceptance and peak
resources. The runner uses upstream `kev.benchmark.LocalPredictor`, checks the
model-visible payload's allowlisted keys, validates probability distributions,
stops on the first failed record, and writes results atomically after each
case. The separate scorer checks pass with:

```sh
/home/bencrow/.local/share/weave/kev/src/.venv/bin/python -m unittest discover \
  -s benchmarks/inference/bev-sample -p 'test_*.py'
```

For a broader exploratory BEV benchmark, freeze source-family and normalized
input grouping before a train/test claim, add a label review and per-cell
baselines, and keep protected Weave-purpose cases separate. This smoke sample
does not justify fine-tuning or admitting a new routed judgment site.
