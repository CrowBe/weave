import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COLOR_ROLES, DISTINCT_COLOR_PAIRS, STATUS_COLOR_ROLES, THEME_DAYLIGHT, THEME_DEFAULT, TYPE_ROLES } from '@weave/tapestry';

const src = fileURLToPath(new URL('../src', import.meta.url));

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else out.push(full);
  }
  return out;
}

describe('tapestry core boundary', () => {
  it('ships no renderer, DOM, or runtime import', () => {
    const sources = files(src);
    assert.ok(sources.length > 0);
    assert.equal(sources.some((file) => file.endsWith('.tsx') || file.endsWith('.jsx')), false);
    const forbidden = /\b(from\s+['"]react|react-dom|@radix-ui|vite|@weave\/weave|@weave\/agentfabric|@weave\/gateway|document\.|window\.|HTMLElement|JSX\.)/;
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      assert.equal(forbidden.test(text), false, file);
    }
  });

  it('gives every shipped theme a value for every role and distinct decision pairs', () => {
    for (const theme of [THEME_DEFAULT, THEME_DAYLIGHT]) {
      for (const role of COLOR_ROLES) {
        assert.equal(typeof theme.color[role].srgb, 'string', role);
      }
      for (const role of STATUS_COLOR_ROLES) {
        assert.ok(theme.mark[role].length > 0, role);
      }
      for (const role of TYPE_ROLES) {
        assert.ok(theme.type[role]);
      }
      for (const [left, right] of DISTINCT_COLOR_PAIRS) {
        assert.notEqual(theme.color[left].srgb, theme.color[right].srgb);
      }
    }
    assert.equal(THEME_DEFAULT.density.comfort, 'comfortable');
    assert.equal(THEME_DAYLIGHT.density.comfort, 'compact');
  });
});
