/** The journal records a report scores, bound to the frozen entries. No provider call, journal write or clock. */
import { replayKey, type JournalRecord } from './journal.ts';
import { bindingFor } from './binding.ts';
import { buildRequest } from './questions.ts';
import { persistentProviderSkip, type Entry } from './engine.ts';
import type { BoundCall } from './report.ts';
import type { Provider } from './types.ts';

/**
 * Each entry's last call for its current binding, or its unacknowledged intent
 * as a failed observation, never a reconstructed answer. `complete` is false
 * when an entry has a pending intent, or no terminal call from a provider that
 * was not skipped. Legacy records without a wire-body digest bind only in a
 * render-only invocation.
 */
export async function bindObservations(
  records: readonly JournalRecord[],
  providers: readonly Provider[],
  entries: readonly Entry[],
  renderOnly: boolean,
): Promise<{ bound: BoundCall[]; statuses: JournalRecord[]; complete: boolean }> {
  const bound: JournalRecord[] = [];
  const invocationStart = records.map((r) => r.type).lastIndexOf('run');
  const statuses = records.filter(
    (r, i) =>
      ['provider_status', 'budget_stop', 'cancelled', 'uncertain'].includes(r.type) &&
      (r.type !== 'provider_status' ||
        (r.persistent !== false && persistentProviderSkip(r.result)) ||
        i > invocationStart),
  );
  const skipped = new Set(
    statuses
      .filter((r) => r.type === 'provider_status' && r.result && persistentProviderSkip(r.result))
      .map((r) => r.provider),
  );
  const order = new Map(records.map((r, i) => [r, i]));
  const byBinding = new Map<string, JournalRecord[]>();
  for (const record of records) {
    const key = replayKey(record),
      group = byBinding.get(key) ?? [];
    group.push(record);
    byBinding.set(key, group);
  }
  let complete = true;
  for (const provider of providers)
    for (const entry of entries) {
      const request = await buildRequest(entry.item);
      const binding = bindingFor(provider, entry, request);
      const matches = [
        ...(byBinding.get(replayKey(binding)) ?? []),
        ...(renderOnly
          ? (byBinding.get(replayKey({ ...binding, request_digest: undefined })) ?? []).filter(
              (r) => r.request_digest === undefined,
            )
          : []),
      ];
      matches.sort((a, b) => order.get(a)! - order.get(b)!);
      const calls = matches.filter((r) => r.type === 'call');
      const completed = new Set(calls.map((r) => r.call_id));
      const last = calls.at(-1);
      const pending = matches.filter((r) => r.type === 'intent' && !completed.has(r.call_id)).at(-1);
      if (pending || (!calls.some((r) => r.terminal) && !skipped.has(provider.id))) complete = false;
      if (pending)
        bound.push({
          ...binding,
          ...pending,
          request_digest: pending.request_digest,
          type: 'call',
          call_id: pending.call_id,
          split: entry.split,
          item: entry.item,
          result: { status: 'failed', reason: 'unacknowledged_call' },
          terminal: true,
          latency_ms: 0,
          cost_usd: 0,
        });
      else if (last) bound.push({ ...last, item: entry.item, terminal: true });
    }
  return { bound: bound as BoundCall[], statuses, complete };
}
