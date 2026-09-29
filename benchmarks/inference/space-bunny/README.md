# Space Bunny Alpha through Nous Portal

Status: exploratory. Adding the model ID to the gateway options does not enable
a routed unit or grant model output authority.

The newer [60-case quality comparison with GPT-6 Sol](sol-compare/README.md)
scored Space Bunny 56/60 and Sol 60/60 on fresh, self-contained text questions.
It records the four disagreements, raw answers, and comparison limits.

## Availability

On 2026-09-25, the authenticated Nous Portal `/v1/models` catalogue listed
eight zero-priced IDs, including `stealth/space-bunny-alpha` without a `:free`
suffix. The public
[`freeRecommendedModels` endpoint](https://portal.nousresearch.com/api/nous/recommended-models)
also listed it. Space Bunny completed live inference at this catalogue-listed
zero price.
The [OpenRouter listing](https://openrouter.ai/stealth/space-bunny-alpha)
describes it as an anonymous preview, so its architecture and training data
are undisclosed. Pricing and availability can change.

The eight catalogue IDs were `stealth/space-bunny-alpha`,
`inclusionai/ling-3.0-flash-sante:free`,
`inclusionai/ling-3.0-flash-fin:free`, `poolside/laguna-s-2.1:free`,
`poolside/laguna-xs-2.1:free`, `meituan/longcat-2.0:free`,
`stepfun/step-3.7-flash:free`, and `upstage/solar-pro4:free`.
**Catalogue presence did not guarantee service:** the free LongCat ID returned
HTTP 404 with “This model is no longer free” on the first benchmark request.
The paid LongCat variant was not called. Both benchmark runners recheck exact
input and output prices in the authenticated catalogue and fail closed if
their selected model is no longer listed at zero price.

## General reasoning probe

[`general-cases.json`](general-cases.json) contains 20 self-authored,
self-contained multiple-choice questions, five each in quantitative reasoning,
logic, code, and reading. Answer positions are balanced. This is a small
easy-to-moderate sanity check, with no independent question sourcing or
contamination audit. It has a ceiling: a high score does not establish broad
reasoning ability or predict performance on difficult tasks.

[`run_general.mjs`](run_general.mjs) sent the same prompt and settings to Space
Bunny and the catalogue-listed free Step 3.7 Flash ID through the real Nous
gateway adapter. Temperature was 0; output was capped at 1,024 tokens. The
adapter does not expose reasoning effort, so each model used its provider
default. Exact option-label compliance counted toward the score. The runner
retains each response, failure, usage record, and end-to-end call latency in
[`general-results.json`](general-results.json).

| Model | Correct / 20 | Answered | Quantitative | Logic | Code | Reading | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Space Bunny Alpha | **19** | 20 | 5/5 | 4/5 | 5/5 | 5/5 | **1.95 s** |
| Step 3.7 Flash free | 12 | 12 | 5/5 | 2/5 | 2/5 | 3/5 | 4.00 s |

Space Bunny's only miss was the three-box truth-sign question: it chose
“cannot be determined” where exactly one true sign implies the blue box.
Step's eight missing answers were recorded as provider failures, not wrong
option selections. A direct raw response for one of them ended with
`finish_reason: length`: it consumed the full 1,024-token cap in reasoning and
had `content: null`. The other seven failures also reached the adapter with no
answer text, but their raw finish reasons were not inspected. Step got all
12 questions it answered correct; these observations do **not** show Space
Bunny is more intelligent than Step under a suitable Step configuration.
Latency includes network and provider work. This is one pass with no
resampling, uncertainty interval, or held-out public benchmark.

```bash
npm run build
node --env-file=.env.local benchmarks/inference/space-bunny/run_general.mjs
```

The runner resumes a partial report when its case hash, models, and settings
match. Delete `general-results.json` before a deliberate fresh pass.

## Narrow Weave judgment probe

The earlier [`run.mjs`](run.mjs) measured 18 authored synthetic validation
rows each for `capability.match` and `result.evaluate`, using the existing
GLiNER2.5-Decide seed. Space Bunny scored 18/18 and 17/18, respectively, at
1.64 s overall median end-to-end latency. Its one miss labeled missing
read-set evidence `unmet` instead of `unknown`. The scenario groups and
surface variants are correlated, and the cases are specific to Weave. These
[`results.json`](results.json) are supplementary and are **not** a general
intelligence score or a routing gate.

```bash
python3 benchmarks/inference/gliner-decide/collect.py
npm run build
node --env-file=.env.local benchmarks/inference/space-bunny/run.mjs
```

No paid fallback is configured in either runner.
