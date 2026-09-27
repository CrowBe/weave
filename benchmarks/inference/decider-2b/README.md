# Decider-2B local transfer probe — 2026-09-25

This is an exploratory, paired CPU comparison of the public
[`Mapika/decider-2b`](https://huggingface.co/Mapika/decider-2b) **v11** checkpoint
at revision `533964dae8be954c5b5e19fa4948e48408094c1e`. The pinned main
revision identifies itself as `decider-2b-v11`; it is not a test of v10 or of
Decider 4B. The model was loaded locally with its native `Decider.system_one`
interface, with one typed question per state. No remote inference or fallback
was used.

## Paired results

The 125 records are exactly the IDs previously measured for Jev and Kev 4B in
the local transfer comparison. They cover 72 `choice`, 43 `noul`, and 10
`score` decisions. `choice` uses the returned key, `noul` uses probability
`>= 0.5`, and `score` rounds the native expected value to the nearest ordinal
level. The [runner](transfer.py) checks suite and paired ID hashes and keeps
the native response in [raw results](transfer-results.json).

| Slice | N | Decider-2B | Jev | Kev 4B |
| --- | ---: | ---: | ---: | ---: |
| Overall | 125 | **83 (66.4%)** | 104 (83.2%) | 97 (77.6%) |
| Choice | 72 | 47 | 59 | 57 |
| Noul | 43 | 34 | 36 | 34 |
| Score | 10 | 2 | 9 | 6 |

On the exact paired items, Decider and Jev both got 76 right; Decider alone
got 7, Jev alone 28, and neither 14. Exact two-sided McNemar p = 0.000508.
Against Kev the corresponding counts are 79, 4, 18, and 24 (p = 0.00434).
These tests detect paired differences on this suite; they do not establish
deployment quality on Weave's judgment purposes.

| Source | N | Decider-2B | Jev | Kev 4B |
| --- | ---: | ---: | ---: | ---: |
| MMLU | 20 | 6 | 16 | 10 |
| Emotion | 18 | 12 | 10 | 14 |
| Offensive tweet | 13 | 9 | 9 | 9 |
| QNLI | 13 | 11 | 11 | 11 |
| PAWS | 13 | 10 | 12 | 10 |
| SciQ | 18 | 17 | 18 | 18 |
| Authorization contrasts | 4 | 4 | 4 | 4 |
| Deadline score contrasts | 10 | 2 | 9 | 6 |
| Held composition (and/or) | 8 | 6 | 7 | 7 |
| Held composition (or/not) | 8 | 6 | 8 | 8 |

The score miss is systematic on this ten-case set: every native expected
score rounded to level 1, including labels at levels 0 and 2. The MMLU gap is
also material here. Emotion is a relative bright spot. We should not route a
generic Jev judgment to this checkpoint based on the aggregate 66.4%.

The model ran on an i7-1355U CPU, four PyTorch threads, bfloat16, with no
resident GPU model. Median per-case native-call time was 15.3 s; process peak
RSS was 3.42 GiB. Latency is exploratory: question shapes and ordinal scoring
work differ, and the user prioritized quality for this comparison.

## Reproduce and limits

From the repository root, with the pinned model and its inference package in
`.local/decider-2b/model` and the existing Kev transfer files available:

The 3.76 GB `model.safetensors` local copy was removed after the completed run
on 2026-09-25 to avoid retaining a checkpoint we do not plan to route. The
revision and raw answers remain recorded above; rerunning requires fetching
that exact revision again.

```sh
PYTHONPATH=.local/decider-2b/model HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .local/openjev/venv/bin/python benchmarks/inference/decider-2b/transfer.py
python3 benchmarks/inference/decider-2b/analyse.py
python3 -m unittest discover -s benchmarks/inference/decider-2b -p 'test_*.py'
```

The 125 cases are a small mixed transfer suite, not a protected test for this
checkpoint. Some public source families could overlap with model training;
we have not proven otherwise. The composition cases are held relative to the
local suite construction, not necessarily to Decider training. A separate
Weave-specific, frozen `capability.match` / `result.evaluate` set and
calibration review are needed before assigning an inference type to it.
