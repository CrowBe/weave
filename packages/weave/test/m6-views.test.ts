/**
 * M6 catalogue disclosure (docs/m6-route-a-reconstructed-view.md §3, M6-T05).
 *
 * The index and the schemas are separate slices. A later view does not inherit
 * schemas its own profile did not select.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { frameQuality, renderFrameView, renderWeighView, type FrameProfile } from '@weave/weave';
import { scenario } from './fixture.js';

const INDEX_PROFILE: FrameProfile = {
  id: 'profile.frame.index@1',
  version: 1,
  catalogue_budget: 32,
  schema_for: ['source.inspect', 'text.normalize'],
};

const EMPTY_SCHEMA: FrameProfile = {
  id: 'profile.frame.index.empty@1',
  version: 1,
  catalogue_budget: 32,
  schema_for: [],
};

const CATALOGUE = [
  { id: 'report.assemble', input: { inspections: '[InspectionResult]' }, purpose: 'Assemble a report' },
  { id: 'source.inspect', input: { source: 'ResourceId' }, purpose: 'Inspect one source' },
  { id: 'text.normalize', input: { text: 'string' }, purpose: 'Collapse whitespace' },
];

function contentOf(view: { content: unknown }): Record<string, unknown> {
  assert.equal(typeof view.content, 'object');
  assert.ok(view.content);
  return view.content as Record<string, unknown>;
}

describe('M6 catalogue slices', () => {
  it('M6-T05 discloses an index and only the schemas the profile names', () => {
    const world = scenario();
    const state = world.runtime.state();
    const framed = renderFrameView(state, CATALOGUE, INDEX_PROFILE);
    const content = contentOf(framed);
    const index = content['catalogue_index'] as { id: string; purpose: string }[];
    const schemas = content['catalogue_schema'] as { id: string; input: Record<string, string> }[];
    assert.deepEqual(
      index.map((entry) => entry.id),
      ['report.assemble', 'source.inspect', 'text.normalize'],
    );
    assert.equal(index.find((entry) => entry.id === 'source.inspect')?.purpose, 'Inspect one source');
    assert.equal(index.find((entry) => entry.id === 'text.normalize')?.purpose, 'Collapse whitespace');
    assert.deepEqual(
      schemas.map((entry) => entry.id),
      ['source.inspect', 'text.normalize'],
    );
    assert.equal(schemas.find((entry) => entry.id === 'source.inspect')?.input['source'], 'ResourceId');
    assert.equal(content['catalogue'], undefined);
    const schemaSlice = framed.manifest.slices.find((slice) => slice.name === 'catalogue_schema');
    assert.deepEqual(schemaSlice?.omitted, [{ name: 'report.assemble', reason: 'profile' }]);

    const weighed = renderWeighView(state, []);
    const weighedContent = contentOf(weighed);
    assert.equal(weighedContent['catalogue_schema'], undefined);
    assert.equal(JSON.stringify(weighedContent).includes('ResourceId'), false);

    const later = renderFrameView(state, CATALOGUE, EMPTY_SCHEMA);
    const laterContent = contentOf(later);
    assert.deepEqual(laterContent['catalogue_schema'], []);
    assert.equal(JSON.stringify(laterContent['catalogue_schema']).includes('ResourceId'), false);
    const laterSlice = later.manifest.slices.find((slice) => slice.name === 'catalogue_schema');
    assert.deepEqual(
      laterSlice?.omitted.map((item) => item.name).sort(),
      ['report.assemble', 'source.inspect', 'text.normalize'],
    );
    assert.ok(laterSlice?.omitted.every((item) => item.reason === 'profile'));

    const dropped = renderFrameView(
      state,
      CATALOGUE.filter((op) => op.id !== 'text.normalize'),
      INDEX_PROFILE,
    );
    const droppedQuality = frameQuality(dropped);
    assert.equal(droppedQuality.quality, 'missed');
    assert.ok(droppedQuality.misses.includes('dropped:text.normalize'));

    const empty = renderFrameView(state, CATALOGUE, { ...INDEX_PROFILE, catalogue_budget: 0 });
    assert.equal(frameQuality(empty).quality, 'missed');
    assert.ok(frameQuality(empty).misses.includes('empty'));
  });
});
