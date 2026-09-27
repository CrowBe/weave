# BEV 150K data risk audit — 2026-09-25

This is a read-only audit of the public
[BEV 150K Decision Mix](https://huggingface.co/datasets/avbiswas/bev-decision-150K)
at dataset revision `f83fe8b97094112fa305bfc793be07c8f8742282`. Three GPT-6 Luna
agents independently examined injection-like source text, benchmark integrity,
and provenance/privacy. A local deterministic scan and spot checks reproduced
the key counts. No dataset row was submitted to a hosted model, and no dataset
instruction was executed.

| File | Rows | SHA-256 |
| --- | ---: | --- |
| `data/train.parquet` | 125,614 | `1b163182db155ba986c8ab8d3d582ac09ec1b1dcbc13c65d048e61379be9fe5b` |
| `data/test.parquet` | 24,386 | `eba9f9df6ad54ccdc3aa6516ab97e4f9dea4030422e0dc90510b85e462206a61` |

The downloaded files live in ignored `.local/bev-decision-150k/<revision>/` and
are not part of the repository. Both Parquet files have the documented five
columns, no null fields, and 296,582 parseable, type-valid questions. All
`question_count` and `question_types` metadata matched their JSON questions.

## Instruction and injection exposure

A case-insensitive **state-only** scan for explicit override phrases (verbs
`ignore/disregard/forget/override/bypass` near
`previous/prior/above/earlier/all` and `instructions/prompts/rules/messages`)
or DAN/developer-mode jailbreak markers found **45 train** and **9 test** rows.
Of these, 44 train and all 9 test rows belong to `Response preference and
quality`; the other train row belongs to `Software engineering and code`.
Examples include train rows 5768 and 6262 and test rows 3346 and 4549 (all
zero-based indices): their source text asks the reader to ignore previous
instructions. Train rows 165 and 1304 and test row 1869 contain DAN-style
role-play prompts. These are often legitimate *objects of evaluation* in a
prompt/response rating corpus; if handed to an unconstrained agent as an
instruction, they become an injection surface.

The broad `<extra_id_N>` conversation marker occurs in 608 train and 137 test
rows. The scan found **zero** `<extra_id_N>` markers followed by a protected
`system` or `developer` role. `Prompt:`, `Response:`, `User:`, and `Assistant:`
style transcript markers occur in thousands of rows and are expected in this
source family, not evidence of an attack by themselves. A separate broad
secret/URL/exfiltration keyword pass had many false positives from ordinary
technical tasks and option descriptions; manual review did **not** confirm an
exfiltration instruction in `questions_json.instructions` or option text.
This is a text scan, not proof that no other attack string exists.

For a Jev-style harness, treat `state` and question text as untrusted data.
The dataset's `questions_json` includes a `label` on each question by design:
construct the outbound question from an explicit allowlist of `type`,
`instructions`, and `criteria`, and score with the label held locally. Never
pass the raw labeled JSON to inference. Keep the model output limited to a
typed observation; it must not become tool execution or policy authority.
If probing an agent rather than a bounded judge, disable tools and outbound
network for these records.

## Test-split integrity

With `unicodedata.normalize('NFKC', state).strip().casefold()`, **one test
state exactly matches a train state**. Test row 19318 and train row 74114
contain the same Civil Comments sentence, differing only by a Unicode ellipsis
versus three ASCII dots. Both ask `toxic_comment` with the same instruction and
`true` label; train also includes five other targets. This directly contradicts
strict input separation under basic Unicode normalization, though it is one
row in a 24,386-row test split.

A heuristic cross-split scan over normalized word 8-grams found 39 test states
with Jaccard similarity at least 0.80 to a train state (23 at least 0.90).
Candidates had to share at least two shingles appearing in at most five train
states. The count is a search result, **not** an exhaustive duplicate rate.
Examples include Wizard of Oz reading passage test 6287 / train 27607,
women's baseball passage test 1339 / train 3165, and cougar passage test
7072 or 6563 / train 8608. These repeat source passages with paraphrased
questions and matching labels, so train/test independence should not be
assumed from the split name.

Some labels have strong trivial baselines. On the test split,
`annotated_threat` is false in 1,133 of 1,147 questions (98.8%); train is
6,133 of 6,179 false (99.3%). Test `annotated_identity_attack` is false in
1,112 of 1,137 (97.8%). Report per-target balanced measures and a majority
baseline, not aggregate accuracy alone. Domain proportions also shift between
splits: reading comprehension is 1.75% of train versus 5.83% of test, while
engagement/ranking is 3.32% versus 0.34%. A pooled headline will conceal
which source families drive the score.

## Provenance, privacy, and use

The dataset card says this test split is held out from its own mixture, not an
independent Jev benchmark. It omits row-level source IDs, raw source downloads,
and generation scripts, preventing reliable source-family exclusion or
full provenance verification. One 20,000-row slice had GPT-6 Luna rewrite
bounded questions and selected source quotes while retaining source labels;
some upstream corpora are synthetic or model-generated. `score` labels are
ordinal levels, not calibrated probabilities.

A broad regular-expression scan found **481 email-shaped strings in 365 rows**
across both splits; many inspected examples were synthetic placeholders or
ordinary public task text, so this is a review queue, not a count of private
emails. Phone-like and IP-like patterns are still noisier. Public source data
can nonetheless contain personal or contact text. Before sending a subset to
a hosted endpoint, inspect and filter the specific records and apply the
project's data boundary. The Hub metadata says `license: unknown`; the author
asserts no blanket license for the mixed-source release. Source-specific terms
need checking before redistribution or commercial fine-tuning.

**Disposition:** useful for exploratory, domain-stratified typed decision
coverage and harness hardening. It should not be the protected benchmark for
`capability.match` or `result.evaluate`, proof of general Jev parity, or a
calibration set. Keep purpose-specific tests protected; if training from BEV,
first obtain source-level manifests/rights, filter contact-like data, and group
splits by normalized input and upstream source family.
