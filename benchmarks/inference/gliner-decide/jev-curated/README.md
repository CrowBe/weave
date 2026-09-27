# Jev-curated capability matching seed — 2026-09-27

[`training.jsonl`](training.jsonl) contains eight exploratory GLiNER
`capability.match` training rows. The [audit](audit.json) records all nine
proposals, their candidate contract descriptions, fixture or contract source,
expected label, Jev choice and probabilities, and the one quarantined
disagreement. These rows are **not** a held-out evaluation set or evidence to
route an adapter. There are no real `capability.match` production traces in
this checkout.

Five accepted rows come from M0, M1, and M3 fixture trace moments. Three are
contract-authored contrasts, including unsupported multi-step and redaction
requests. The [source manifest](../jev-curation-source.json) records the
fixture cycle and candidate identity verified when these rows were captured,
including the change from absent to admitted `report.fold`. The curator checks
the listed capability ids against the current contracts.
It sends only short fixture-derived situation summaries and the five local
capability contracts to hosted Jev through the existing inference gateway's
TypeSafe adapter. No raw source bodies, local paths, credentials, or private
runtime observations are sent.

Jev agreed with eight proposed labels. It chose `none` for a proposed
post-fold `report.assemble` row. The request asked the operation to put the
fold *into* the report, which `report.assemble`'s contract does not promise;
the trace only makes assembly depend on the completed fold. The row remains in
the audit and is excluded from training. This is a useful curation catch, not
a model accuracy estimate.

The training rows are too few and too related to existing authored fixtures to
justify another fine-tune. A future run needs independently sourced,
adjudicated `capability.match` traces, versioned candidate catalogues, and a
separate protected promotion set. Jev agreement is an observation supporting
review, not an authoritative label. Training an adapter or choosing a route
remains a separate decision.

To run on the current fixtures after `npm run build`, set
`TYPESAFE_AI_API_KEY` in ignored `.env.local` and run:

```sh
node --env-file-if-exists=.env.local benchmarks/inference/gliner-decide/curate-jev.mjs --output .local/gliner-decide/jev-curation-next
```

The script refuses to overwrite an existing output directory before making
any hosted calls. It uses only the `typesafe-ai` destination. A separate
adapter for a user-supplied trace source must enforce that source's disclosure
policy before asking hosted Jev; this fixture curator cannot authorize it.
