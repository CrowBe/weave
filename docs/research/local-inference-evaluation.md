# Local inference experiments

## Retired generative setup — 2026-09-20

Host: Intel i7-1355U, 32 GB RAM, Iris Xe, Fedora 44. PrismML runtime
`prism-b10709-9a9394a`.

An independent short CPU benchmark of Bonsai 2 27B PQ2_0 (8 threads,
16 prompt tokens, 8 generated tokens, one repetition) measured 1.24 prompt
tokens/s and 0.99 generated tokens/s, with about 7 GiB peak process RSS.
This confirms execution is possible; it is too slow for this interactive
development workload. It is not a systematic hardware or kernel profile.

The earlier experiment recorded 0.91 generated tokens/s for PQ2_0 on CPU,
and 0.31–0.40 for PTQ1_0 across CPU/Vulkan. These are prior experiment notes,
not independently repeated here. Throughput alone does not establish the
precise kernel bottleneck or prove an unavailable GPU implementation.

Qwen3-4B answered a live local arithmetic probe in 0.577 seconds, with server
decode timing around 10.94 tokens/s on that very short response. The user
rejected its quality for the intended work; the previous redaction example
also reportedly left identifiers behind. Fast execution is not task success.

At the user's request, the dedicated service, runtime, Qwen 4B/8B and both
Bonsai weight files, local credential, installer, adapter and example were
removed. Hosted gateway work remains. Source was backed up under
`/tmp/weave-local-cleanup-backup/` before cleanup; that is a temporary recovery
copy, not a maintained alternative implementation.

## OpenJev direction

Test `text.assess-entailment` as a distinct candidate semantic operation.
Do not substitute it for arbitrary Jev judgments after an API failure.
Privacy is a destination constraint; measured latency and quality determine
where the implementation is usable. See `tools/openjev/README.md` for the
contract, pinned checkpoint and evaluation procedure.

### OpenJev CPU result — 2026-09-20

OpenJev 4B v2, pinned revision
`4b5f9a67fa2ebe77466bce0656ce350effc3148c`, ran offline with native
Transformers 5.15.0 and PyTorch 2.14.0+cpu. The downloaded weight file's SHA256
was verified against its Hugging Face metadata. No custom remote model code
was loaded.

With bfloat16, eight CPU threads and batch size one, all **12/12** hand-labeled
exploratory cases matched their expected label. Median judgment latency was
**4.86 seconds**, ranging from **3.52 to 7.30 seconds**, for 20–38 input tokens.
Reported model loading took 1.14 seconds, but lazy weight paging means that is
not a cold-ready latency guarantee. The full run includes the first inference.

Cases include missing evidence, negation, possibility versus certainty,
exclusive versus nonexclusive approval statements, quoted instructions,
numeric comparison and conjunction. Approval examples test textual entailment
only; the model does not issue or validate execution authority. The quoted
instruction case passing once does not prove general injection resistance.

Disposition: **promising for occasional private entailment checks; remains
experimental**. The corpus is small, short and hand-authored, with no held-out
admission set or calibration study. Multi-hypothesis ranking would multiply
the inference work and requires its own evaluation. No gateway route or
automatic Jev fallback has been installed.

Raw measurements: [openjev-cpu-results.json](openjev-cpu-results.json).
Model files and the isolated environment remain under ignored `.local/openjev/`
for further experiments. There is no resident process or auto-start service.

Validation after removing the generative setup: repository structural checks,
TypeScript build and example typecheck passed; 100 remaining repository tests
and five entailment contract checks passed. Unrelated pre-existing source was
compared against the pre-cleanup archive and preserved.
