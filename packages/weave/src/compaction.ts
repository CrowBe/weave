/** Token boundaries and token strings belong to the injected tokenizer. */
export type ContextSummarizer = (prefix: readonly string[], max_tokens: number) => Promise<readonly string[]>;
export interface CompactedContext {
  readonly status: 'unchanged' | 'summary_needed' | 'compacted';
  /** Original context unless a bounded summary was successfully produced. */
  readonly tokens: readonly string[];
  readonly tail: readonly string[];
  readonly prefix: readonly string[];
  readonly summary_cap: number;
}

/** No tokenizer, clock, persistence, inference implementation or model dependency. */
export async function compactContext(
  tokens: readonly string[],
  context_capacity: number,
  summarize?: ContextSummarizer,
): Promise<CompactedContext> {
  if (!Number.isSafeInteger(context_capacity) || context_capacity <= 0) throw new Error('Invalid context capacity.');
  const original = [...tokens];
  const summary_cap = Math.floor(context_capacity / 10);
  if (tokens.length < Math.ceil(context_capacity * 0.8)) {
    return { status: 'unchanged', tokens: original, tail: [], prefix: [], summary_cap };
  }
  const tail_count = Math.min(tokens.length, Math.ceil(context_capacity * 0.05));
  const tail = original.slice(-tail_count);
  const prefix = original.slice(0, original.length - tail_count);
  if (!summarize) return { status: 'summary_needed', tokens: original, tail, prefix, summary_cap };
  const summary = await summarize(Object.freeze([...prefix]), summary_cap);
  if (summary.length > summary_cap) throw new Error('Context summary exceeds token cap.');
  return { status: 'compacted', tokens: [...summary, ...tail], tail, prefix, summary_cap };
}
