import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './journal.ts';
import type { Entry } from './engine.ts';
import type { Item } from './types.ts';
/** Validate the frozen input before dispatch. No automatic corpus generation in a run. */
export function loadSets(
  root: string,
  sites: readonly string[],
  split: string,
): { entries: Entry[]; digests: Record<string, string> } {
  const manifest = JSON.parse(readFileSync(join(root, 'DIGESTS.json'), 'utf8'));
  const entries: Entry[] = [];
  const digests: Record<string, string> = {};
  for (const site of sites) {
    const textBySplit = ['tune', 'holdout'].map((part) => readFileSync(join(root, site, `${part}.jsonl`), 'utf8'));
    const setHash = digest(textBySplit.join(''));
    if (manifest.sites?.[site]?.set !== setHash) throw new Error('Frozen set digest mismatch');
    digests[`${site}/set`] = setHash;
    const seen = new Set<string>();
    const scenarios = new Map<string, string>();
    for (const part of ['tune', 'holdout'] as const) {
      const text = readFileSync(join(root, site, `${part}.jsonl`), 'utf8');
      const hash = digest(text);
      // Manifest validation is independent of which split is dispatched.
      const declared = manifest.files?.[`${site}/${part}.jsonl`] ?? manifest[`${site}/${part}.jsonl`];
      if (!declared || declared !== hash) throw new Error('Frozen set digest mismatch');
      digests[`${site}/${part}`] = hash;
      for (const line of text.trim().split('\n')) {
        const item = JSON.parse(line) as Item;
        if (
          item.site !== site ||
          !item.id ||
          !item.scenario_id ||
          seen.has(item.id) ||
          !item.gold ||
          Object.keys(item.gold).length === 0
        )
          throw new Error('Invalid frozen item');
        if (Math.ceil(JSON.stringify(item.state).length / 3) > 4000) throw new Error('State exceeds size cap');
        seen.add(item.id);
        if (scenarios.has(item.scenario_id) && scenarios.get(item.scenario_id) !== part)
          throw new Error('Scenario crosses splits');
        scenarios.set(item.scenario_id, part);
        if (split === 'all' || split === part) entries.push({ item, split: part, set_digest: hash });
      }
    }
  }
  return { entries, digests };
}
