# Two Weave judgment-site fine-tuning pilots

This experiment tests separate local GLiNER adapters for `capability.match`
and `result.evaluate`. It is a contract-authored synthetic corpus, with no
production traces, independently reviewed labels, and new group IDs and exact
inputs relative to the first seed. It does **not** validate a live route or
grant execution authority to a model.

## Case design and provenance

The [matching cases](collection-match-v2.json) and
[result-evaluation cases](collection-evaluate-v2.json) cite source contracts in
their own files; their [matching source manifest](collection-match-v2.sources.json)
and [evaluation source manifest](collection-evaluate-v2.source.json) record
assumptions and semantic overlap with the previous seed. Each scenario has a
base case, a relevant fact change that changes the label, an irrelevant change
that preserves it, and two wording variants. The held-out groups are new
scenarios, but several have semantic analogues in the previous corpus. These
are not independent production observations. In particular, several
unsupported matching tasks have close train or v1 analogues, so holding out
their group IDs does not establish transfer to unseen semantic families.

| Site | Train cases / groups | Validation cases / groups | Test cases / groups |
| --- | ---: | ---: | ---: |
| `capability.match` | 120 / 20 | 48 / 8 | 60 / 10 |
| `result.evaluate` | 114 / 19 | 48 / 8 | 60 / 10 |

[`collect_v2.py`](collect_v2.py) rejects old group IDs or exact normalized
rendered text. Exported GLiNER rows, provenance indices, model runs, and LoRA
adapters stay under ignored `.local/gliner-decide/`. The source files remain
in this repository workspace because they are authored here rather than
extracted from BEV.
The separately authored corpora received a cross-review before any baseline
run. Review caught and corrected success criteria that had asked merely to
*determine whether* an effect occurred while labeling a definitive negative
outcome `unmet`. The fixed corpus hashes are recorded in ignored
`.local/gliner-decide/weave-v2/independence.json` and per-site manifests.

The adapter recipe was fixed before probing test: fresh pinned
`fastino/GLiNER2.5-Decide` base per site; one epoch over that site's train
rows, batch one, rank-8 LoRA on encoder query/value, float32, two CPU threads,
seed 42. Neither site's training rows or adapter enter the other's run.
Prior seed test cases were already examined during earlier work and are not
reused as a hidden final benchmark here.

## Untuned checkpoint

| Site | Validation correct | Test correct | Test majority floor | Median test CPU inference |
| --- | ---: | ---: | ---: | ---: |
| `capability.match` | 36/48 | 44/60 | 20/60 | 1,033 ms |
| `result.evaluate` | 48/48 | 40/60 | 16/60 | 926 ms |

All 12 matching validation errors and 16 matching test errors are false
matches on the relevant unsupported-operation arms (two surface variants per
affected group). All base and irrelevant arms held. Evaluation's validation
set is at ceiling before training, making regression detection more useful
than improvement on that split.

## After tuning

The [paired result artifact](weave-v2-results.json) retains every validation
and test case ID, expected label, both predictions, and both timings, without
copying dataset text. Both adapters were loaded from disk into fresh base
processes for evaluation.

| Site | Validation base → adapter | Test base → adapter | Test corrections / regressions | All-correct test groups |
| --- | ---: | ---: | ---: | ---: |
| `capability.match` | **36/48 → 46/48** | **44/60 → 57/60** | 13 / 0 | 2/10 → 8/10 |
| `result.evaluate` | **48/48 → 46/48** | **40/60 → 49/60** | 10 / 1 | 4/10 → 6/10 |

For matching, all positive contract cases stayed correct. The held-out
`none` rows improved from **4/20 → 17/20** on test and **4/16 → 14/16** on
validation. The remaining test errors are both variants of an unsupported
inspect-assemble-publish composition and one variant of an unsupported delete.
Relevant-change prediction flips rose from 8/20 to 17/20 on test, while all
20 irrelevant-change holds remained. This is a useful signal for the specific
unsupported-operation boundary, with the synthetic-overlap caveat above.

For result evaluation, test `unknown` improved **10/16 → 14/16** and `unmet`
**10/16 → 16/16**. `partial` remained **4/12** and `met` fell **16/16 → 15/16**.
The adapter introduced two validation errors on a queued cancellation case
and one test error in effect ordering. Its net test gain is not a clean
across-label improvement, and it should not be promoted.

| Site | Train steps / time | Training peak RSS | Adapter size | Median test inference, base → adapter |
| --- | ---: | ---: | ---: | ---: |
| `capability.match` | 120 / 364 s | 4.07 GiB | 3.16 MB | 1,033 → 1,064 ms |
| `result.evaluate` | 114 / 433 s | 4.07 GiB | 3.16 MB | 926 → 1,182 ms |

The training processes ran concurrently and contended for the 15 W CPU; these
times are feasibility measurements rather than a throughput curve. A repeat
untuned test probe later measured **1,025 ms** for matching and **1,298 ms**
for evaluation, with unchanged predictions. That run-to-run drift is larger
than the apparent adapter timing difference, so these probes establish only
roughly one-second CPU inference on short cases. No controlled latency effect
of the adapter was established.

Each adapter was trained from the pinned base with 786,432 trainable
parameters. SHA-256 of the matching adapter is
`f596bfb84efc7fb339624ccb1bd28013d0ec5dad4e27ba43bdedb131bbd94132`;
the evaluation adapter is
`54ab111be7b8623b19012bac80760bf2a62c140a3faea8bbfbe0d48a642e47d0`.
They remain in ignored `.local/gliner-decide/weave-v2-adapters/`.

This small related synthetic corpus cannot establish route quality. The next
gate is independently adjudicated real traces or task cases with realistic
class prevalence and paired strong-route scoring. No Weave runtime route was
changed.

## Reproduction

Run [`collect_v2.py`](collect_v2.py) to materialize the cases. Pass
`--data .local/gliner-decide/weave-v2` and `--output <file>` to
[`probe_collection.py`](probe_collection.py) for each baseline and adapter
probe. Run [`finetune_seed.py`](finetune_seed.py) separately for each site with
`--data .local/gliner-decide/weave-v2`,
`--output-root .local/gliner-decide/weave-v2-adapters`, and `--steps 120` or
`--steps 114` respectively. The collector and trainer refuse to overwrite
existing output directories. Pin offline weights with `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1` when repeating the local run.
