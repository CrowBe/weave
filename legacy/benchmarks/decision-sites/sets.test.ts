import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './journal.ts';
import { loadSets } from './sets.ts';
import { buildRequest, SITES } from './questions.ts';

const root = fileURLToPath(new URL('./sets/', import.meta.url));
const counts: Record<string, number> = {
  'intake.classify': 120,
  'loop.triage': 100,
  'loop.preselect': 40,
  'loop.route': 24,
  'guard.input': 32,
  'eval.output': 24,
  'audit.dispose': 24,
  'guard.output': 36,
  'loop.continue': 24,
};

test('frozen sets have declared digests, balanced labels and scenario-disjoint splits', async () => {
  const manifest = JSON.parse(readFileSync(join(root, 'DIGESTS.json'), 'utf8'));
  const loaded = loadSets(root, SITES, 'all');
  for (const site of SITES) {
    const entries = loaded.entries.filter((e) => e.item.site === site);
    assert.equal(entries.length, counts[site]);
    const tune = new Set(entries.filter((e) => e.split === 'tune').map((e) => e.item.scenario_id));
    assert.ok(entries.filter((e) => e.split === 'holdout').every((e) => !tune.has(e.item.scenario_id)));
    const parts = ['tune', 'holdout'].map((part) => readFileSync(join(root, site, `${part}.jsonl`), 'utf8'));
    assert.equal(manifest.sites[site].set, digest(parts.join('')));
    for (const [i, part] of ['tune', 'holdout'].entries()) {
      assert.equal(manifest.files[`${site}/${part}.jsonl`], digest(parts[i]!));
      assert.equal(manifest.sites[site][part!], digest(parts[i]!));
      const labels = new Map<string, number>();
      for (const e of entries.filter((e) => e.split === part)) {
        for (const label of Object.values(e.item.gold)) labels.set(String(label), (labels.get(String(label)) ?? 0) + 1);
      }
      if (
        [
          'intake.classify',
          'loop.triage',
          'loop.route',
          'loop.continue',
          'audit.dispose',
          'eval.output',
          'guard.output',
        ].includes(site)
      ) {
        assert.equal(new Set(labels.values()).size, 1, `${site}/${part}: balanced gold options`);
      }
    }
    for (const { item } of entries) {
      assert.ok(Math.ceil(JSON.stringify(item.state).length / 3) < 4000);
      const request = await buildRequest(item);
      assert.deepEqual(Object.keys(item.gold).sort(), Object.keys(request.questions).sort(), item.id);
      for (const [key, gold] of Object.entries(item.gold)) {
        const question = request.questions[key]!;
        if (typeof gold === 'boolean') assert.equal(question.type, 'boolean');
        else {
          assert.equal(question.type, 'choice');
          assert.ok(question.type === 'choice' && Object.hasOwn(question.criteria, gold));
        }
      }
    }
  }
});

test('source rows remain traceable and D3 preserves all available multi-tool cases', () => {
  const { entries } = loadSets(root, SITES, 'all');
  for (const site of ['intake.classify', 'loop.triage', 'loop.preselect']) {
    const provenance = readFileSync(join(root, site, 'PROVENANCE.md'), 'utf8');
    assert.match(provenance, /\/workspace\/amos\/ft\/sites\//);
    assert.match(provenance, /TEACHER.json/);
    assert.match(provenance, /jev-1\.13\.0/);
    for (const { item } of entries.filter((e) => e.item.site === site)) {
      const row = item as typeof item & { source_row_id: string };
      assert.equal(row.source_row_id, row.id);
      assert.ok(provenance.includes('`' + row.id + '`'));
      assert.ok(provenance.includes('`' + row.scenario_id + '`'));
    }
  }
  const d3 = entries.filter((e) => e.item.site === 'loop.preselect');
  assert.equal(d3.filter((e) => Object.values(e.item.gold).filter(Boolean).length === 2).length, 4);
  assert.equal(d3.filter((e) => Object.values(e.item.gold).filter(Boolean).length === 3).length, 3);
  for (const site of ['guard.input', 'guard.output']) {
    for (const part of ['tune', 'holdout']) {
      const kinds = new Set(
        entries
          .filter((e) => e.item.site === site && e.split === part)
          .map((e) => (e.item as typeof e.item & { case_kind: string }).case_kind),
      );
      assert.deepEqual([...kinds].sort(), ['clear_pass', 'clear_violation', 'near_miss']);
    }
  }
});

test('a modified frozen file or absent declared digest refuses dispatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-sets-'));
  try {
    cpSync(root, dir, { recursive: true });
    const path = join(dir, 'loop.route', 'tune.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8') + '\n');
    assert.throws(() => loadSets(dir, ['loop.route'], 'all'), /digest/i);
    cpSync(root, dir, { recursive: true });
    writeFileSync(join(dir, 'DIGESTS.json'), '{}\n');
    assert.throws(() => loadSets(dir, ['loop.route'], 'all'), /digest/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Source access is optional on a portable checkout; the committed provenance is mandatory.
test('sampled source ids and teacher hashes agree when read-only source is available', (t) => {
  const sourceSites: Record<string, string> = {
    'intake.classify': 'intake_flat',
    'loop.triage': 'triage_flat',
    'loop.preselect': 'preselect',
  };
  const sourceRoot = '/workspace/amos/ft/sites';
  if (!existsSync(join(sourceRoot, 'intake_flat/data/test_codex.jsonl'))) {
    t.skip('Read-only source corpus is not installed');
    return;
  }
  const { entries } = loadSets(root, Object.keys(sourceSites), 'all');
  for (const [site, sourceSite] of Object.entries(sourceSites)) {
    const sourcePath = join(sourceRoot, sourceSite, 'data/test_codex.jsonl');
    const text = readFileSync(sourcePath, 'utf8');
    const source = new Map(
      text
        .trim()
        .split('\n')
        .map((line) => {
          const row = JSON.parse(line);
          return [row.id, row] as const;
        }),
    );
    const provenance = readFileSync(join(root, site, 'PROVENANCE.md'), 'utf8');
    assert.ok(provenance.includes(digest(text)));
    const teacherPath = join(sourceRoot, site === 'loop.triage' ? 'triage' : sourceSite, 'data/TEACHER.json');
    assert.ok(provenance.includes(digest(readFileSync(teacherPath, 'utf8'))));
    for (const { item } of entries.filter((e) => e.item.site === site)) {
      const original = source.get(item.id);
      assert.ok(original);
      assert.equal(item.scenario_id, original.sid);
      const state = item.state as Record<string, unknown>;
      if (site === 'loop.preselect') {
        assert.deepEqual(state.index, original.entries);
        assert.equal(state.preselect_step, original.step);
        assert.deepEqual(
          item.gold,
          Object.fromEntries(
            original.entries.map((entry: { id: string }, i: number) => [
              `entry_${i}`,
              original.gold.includes(entry.id),
            ]),
          ),
        );
      } else {
        assert.deepEqual(item.gold, { decision: original.label });
        assert.equal(state.context, original.state);
      }
    }
  }
});
