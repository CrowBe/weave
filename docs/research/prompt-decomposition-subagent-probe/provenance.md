# Provenance and execution limits

Run date: 2026-10-20 Australia/Sydney. Input is self-authored synthetic text from the earlier probe and is permitted to be sent through the OpenAI hosted Codex subagent service. No private documents, third-party benchmark text, new downloads, or API keys were passed in the task prompt.

Each agent was spawned with fork_turns=none, explicit model name, reasoning_effort=low, and byte-identical task text (excluding the saved file trailing newline). All were instructed to return JSON and use no tools or delegation. This removes parent conversation history; ambient agent harness instructions may still apply. These are subagent calls, not bare model API requests. The requested IDs were selected from the host/tool model catalogue available at the time and checked against https://learn.chatgpt.com/docs/models#recommended-models; these are historical selections, not claims about current availability.

Concurrency: four slots include the parent; Astra/Sol/Terra dispatched first, then Luna after a slot was free. The tool did not expose token counts, billing, per-model inference timing, or returned model revision. Requested model IDs were accepted by spawn_agent, not independently confirmed by a provider response model field. No per-model speed or cost ranking is claimed. Requested low effort is a common configured setting, not a claim of equal compute across models.

One shared prompt, one output per model, no retries or prompt tuning between models. This is an already examined synthetic development case, not held-out comparative quality evidence. JSON/schema/dependency checks are deterministic; semantic assessments are parent judgments, not independent ground truth. No general accuracy percentage is supported. Raw text is the exact final answer delivered by each agent, saved separately from parsed checks.

The 2026-10-27 reassessment in `assessment.json` corrects the original parent judgment for Luna; the original judgment and raw outputs remain preserved.
