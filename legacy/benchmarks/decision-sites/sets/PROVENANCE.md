# Decision-site set provenance

The nine fixed sets were prepared offline for WHC-P10, before any benchmark provider run. Each site directory records source paths, source and teacher hashes, row ids, scenario ids, synthetic status, label counts, and exact-file SHA-256 digests. `DIGESTS.json` is the digest manifest. The site `set` digest hashes exact `tune.jsonl` bytes followed by exact `holdout.jsonl` bytes.

The three sampled Codex sets were read from `/workspace/amos/ft/sites/` without modifying that repository. They are already teacher-filtered evaluation fixtures: the teacher was Jev 1.13.0, and this selection does not relabel them for 1.14.0. This can favor the earlier teacher and is a limitation, not new gold evidence. Whole source scenarios are assigned to one split.

D3 retains every available multi-tool step but the source catalogue per step has only 24 entries; a future full-index outcome-labelled set remains needed (#140). Synthetic guards contain clear violations, clear passes and near misses. Near-miss metadata and gold stay outside disclosed state. All states satisfy the conservative 4,000-token estimate. No tuning is performed while building these fixtures.
