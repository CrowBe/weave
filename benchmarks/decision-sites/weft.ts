/**
 * The benchmark journal read as a Weft trace (packages/weft/src/WEFT-CONTRACT.md).
 * A projection for evaluation only: the journal stays the record that budgets,
 * resume and rendering read, and nothing here writes to it.
 *
 * Each dispatched `call` is one `inference.attempt` in the trace named by the
 * run id, emitted by `external` `decision-sites`, sequenced by journal position.
 * It carries only what the journal recorded:
 *
 * - `record_id` is the call id, `request_ref` the production question digest
 *   and `routed_unit` the provider id. Models stay in the journal binding.
 * - `attempt_no` counts attempts for the same replay binding, as the engine
 *   does, and a retry links the attempt it repeats with `retry_of`.
 * - `disposition` is `accepted` when the adapter returned answers and `failed`
 *   otherwise. Admission under thresholds is scored from the journal.
 * - Tokens and `latency_ms` are copied when present.
 *
 * Left out rather than invented: `spent_micros` (journal cost is fractional
 * micro-USD, and a count would round it). A provider-level skip or a
 * cancellation before dispatch never reached a provider, so it is not an
 * attempt; nor is an intent without a receipt. Answers have no Weft kind.
 *
 * Weft fails closed: a call it cannot hold throws instead of being dropped.
 */
import { validateRecord, type WeftRecord } from '@weave/weft';
import { replayKey, type JournalRecord } from './journal.ts';
import { retryableCancellation } from './engine.ts';

export const EMITTER = { kind: 'external', id: 'decision-sites' } as const;
export type Attempt = Extract<WeftRecord, { kind: 'inference.attempt' }>;

export function attemptRecords(runId: string, records: readonly JournalRecord[]): Attempt[] {
  const attempts: Attempt[] = [];
  const previous = new Map<string, string>();
  const counts = new Map<string, number>();
  records.forEach((r, sequence) => {
    if (r.type !== 'call' || r.result?.status === 'skipped' || retryableCancellation(r.result)) return;
    const key = replayKey(r);
    const attempt_no = (counts.get(key) ?? 0) + 1;
    const prior = previous.get(key);
    const { input_tokens, output_tokens } = r.result;
    const record: Attempt = {
      schema: 'weft.record@1', trace_id: runId, record_id: r.call_id, emitter: EMITTER, sequence,
      kind: 'inference.attempt', thread_id: null, parent_id: null,
      links: prior === undefined ? [] : [{ rel: 'retry_of', record_id: prior }], evidence: [],
      fields: {
        request_ref: r.question_digest, routed_unit: r.provider, attempt_no,
        disposition: r.result.status === 'ok' ? 'accepted' : 'failed',
        ...(input_tokens === undefined ? {} : { input_tokens }),
        ...(output_tokens === undefined ? {} : { output_tokens }),
        latency_ms: r.latency_ms,
      },
    };
    const verdict = validateRecord(record);
    if (!verdict.ok) throw new Error(`Invalid Weft record: ${verdict.reason}`);
    attempts.push(record);
    counts.set(key, attempt_no);
    previous.set(key, r.call_id);
  });
  return attempts;
}
