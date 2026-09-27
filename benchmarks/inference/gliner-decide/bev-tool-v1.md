# BEV tool suitability: focused GLiNER fine-tuning pilot

This is a private research run against `avbiswas/bev-decision-150K` revision
`f83fe8b97094112fa305bfc793be07c8f8742282`. Raw examples, labels, and
the LoRA adapter stay under ignored `.local/gliner-decide/bev-tool-v1/`.
Model outputs are observations; this pilot does not admit an inference route or
grant tool execution authority.

## Candidate data slices

The BEV mixture should be divided by **question purpose and upstream source
family**, rather than trained as one multi-purpose corpus. Counts below are
question counts from the pinned local Parquet files, before filtering:

| BEV question | train / test | Possible bounded purpose | Decision |
| --- | ---: | --- | --- |
| Tool `should_call_available_tool` (NOUL) | 444 / 109 | Is an offered tool suitable for a request? | **Pilot here**; a proxy for one part of `capability.match`, not its contract. |
| Tool `service_tool` + `tool_selection` (Choice) | 5,040 + 2,836 / 960 + 779 | Choose an offered service/tool | Separate later slice; audit option sets, source groups and no-tool cases first. |
| Support `support_intent` (Choice) | 1,120 / 280 | Route a support message | Separate domain specialist, not Weave capability matching. |
| Contract `claim_status` (Choice) | 1,680 / 320 | Supported, contradicted, or absent claim | Possible evidence evaluation specialist; long contracts and source rights need review. |
| Response `preferred_response` (Choice) | 4,567 / 691 | Pairwise response preference | Separate preference model; does not supervise Weave `result.evaluate`. |

The mixed BEV release has `license: unknown`, lacks row-level source IDs, and
asserts no blanket license. Its card identifies Glaive Function Calling v2
and Taskmaster-1 under the tool domain, but does not prove each row's origin.
This run is local, exploratory and unpublished; it is not a license review for
redistribution or commercial training. The source audit also found cross-split
similarities and contact/instruction-like text. See
[`docs/research/bev-decision-150k-audit.md`](../../../docs/research/bev-decision-150k-audit.md).

## Frozen pilot

[`bev_tool.py`](bev_tool.py) pins both Parquet digests, takes only the named
NOUL question, and maps its Boolean label to the two GLiNER labels `call` and
`skip`. It rejects malformed, long, contact/URL-shaped, and simple instruction
override rows. The outbound model input is the state alone; the label remains
in the local training or scoring record. Identical normalized request strings
stay together even when paired with different offered tools. The official BEV
test rows are kept out of training and validation. This does not rule out
paraphrased requests or broader upstream overlap.

A token-trigram comparison of test requests against training requests found
25/105 test rows with a maximum Jaccard similarity of at least 0.80 (48/105
at least 0.60; median maximum 0.583). This is a rough surface-overlap warning,
not proof of identical task examples. Report the lower-overlap subset as a
sensitivity check without choosing a threshold from model outcomes.

| partition | rows | distinct request groups | call / skip | SHA-256 of GLiNER JSONL |
| --- | ---: | ---: | ---: | --- |
| train | 336 | 240 | 175 / 161 | `9eb391a2b2042ec1071ffb8881f101af954b937932921489830a1f5610e2ab5b` |
| validation | 92 | 62 | 41 / 51 | `fbe9fa05e99dbbd184eb79c113a276d59f84a7cce617c44b47c69ce8a22de61f` |
| test | 105 | 72 | 45 / 60 | `9f2876b789690765f31f50f672def7e6e64927d7cec1d669c8f917d45cecf089` |

The pinned checkpoint is marketed as 340M, but its downloaded weight metadata
reports 486,444,053 F32 parameters; the training process reports 487,230,485
parameters including LoRA. The fixed recipe is one epoch over 336 training
rows, rank-8 LoRA on encoder query/value, seed 42, batch one, float32, two CPU
threads, starting from a fresh base. Its adapter is a separate artifact from
the prior authored-seed pilots.

Run offline with the previously prepared environments:

```bash
/home/bencrow/.local/share/weave/kev/src/.venv/bin/python benchmarks/inference/gliner-decide/bev_tool.py prepare
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/bev_tool.py probe --split validation
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/bev_tool.py probe --split test
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/bev_tool.py train
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/bev_tool.py probe --split validation --adapter
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/bev_tool.py probe --split test --adapter
```

## Baseline before tuning

| partition | GLiNER correct | majority floor | median CPU latency | prediction mix |
| --- | ---: | ---: | ---: | --- |
| validation | 54/92 (58.7%) | 51/92 (55.4%) | 1,056 ms | 77 call, 15 skip |
| test | 56/105 (53.3%) | 60/105 (57.1%) | 1,000 ms | 80 call, 25 skip |

## After tuning

The adapter was reloaded with a fresh pinned base in separate CPU processes.
Training completed 336 steps in 737.21 seconds (12.3 minutes), reached
5,866,896 KiB peak RSS, and saved a 3 MB adapter with SHA-256
`b5230429defa9b801b0ee11b750b1e7b204bf5195e9e9bdc731139c938dcca0d`.

| partition | base → adapter correct | majority floor | paired corrections / regressions | adapter median CPU latency |
| --- | ---: | ---: | ---: | ---: |
| validation | **54/92 → 92/92** | 51/92 | 38 / 0 | 1,218 ms |
| test | **56/105 → 103/105** | 60/105 | 47 / 0 | 1,109 ms |

On test, `call` recall moved **38/45 → 45/45** and `skip` recall
**18/60 → 58/60**. Complete request groups moved **41/72 → 70/72**. The
base and adapter used identical split SHA-256 values and the same base weight
SHA-256 `40a5a23ff860dc3dff426cecd1048cacdd29c648c96db209dad818e9686dc997`.

The two adapter errors are `test:8655` and `test:8678`: requests to book a
restaurant table paired with a nearby-place/restaurant search tool. BEV labels
both `skip`, while the adapter predicts `call`. A previous BEV smoke-sample
review had already excluded `test:8655` as ambiguous: searching could advance
the booking request but cannot complete it. Keep the supplied labels for the
reported score; do not re-label after seeing outcomes.

Sensitivity checks using thresholds declared before the adapter's test result:

| Test subset | rows | base → adapter correct |
| --- | ---: | ---: |
| Tool name unseen in training | 26 | 15 → 25 |
| Maximum request token-trigram similarity to training < 0.80 | 80 | 44 → 79 |
| Maximum request token-trigram similarity to training < 0.60 | 57 | 36 → 56 |

The result demonstrates that a small LoRA adapter can teach this local model
the **narrow BEV tool-suitability task**. It does not establish performance on
Weave's `capability.match` judgment site: the source set has repeated tool
vocabulary, paraphrased requests, one known disputed label, no row-level
upstream identity, and unresolved mixed-source rights. No runtime route was
changed. A separate, independently labeled Weave-site benchmark is required
before using this adapter there.
