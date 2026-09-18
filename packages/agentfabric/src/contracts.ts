import type { CapabilityContract } from '@weave/agentsop';

export const SOURCE_INSPECT: CapabilityContract = {
  id: 'source.inspect',
  revision: 'r1',
  purpose: 'Inspect one text source and report its revision, line count, and digest',
  input: { source: 'ResourceRef' },
  output: { source: 'ResourceRef', revision: 'integer', line_count: 'integer', digest: 'string' },
  effects: [{ input: 'source', mode: 'read' }],
  permissions: [{ input: 'source', mode: 'read' }],
  failures: ['not_found', 'access_denied'],
  depends_on: [],
};

export const REPORT_ASSEMBLE: CapabilityContract = {
  id: 'report.assemble',
  revision: 'r1',
  purpose: 'Assemble inspection results into a report that records the read set it was assembled under',
  input: { inspections: '[InspectionResult]' },
  output: { entries: '[InspectionResult]', read_set: '[{resource, revision}]' },
  effects: [],
  permissions: [],
  failures: ['empty_input'],
  depends_on: [],
};

export const REPORT_PUBLISH: CapabilityContract = {
  id: 'report.publish',
  revision: 'r1',
  purpose: 'Conditionally write a checked report to an existing destination',
  input: {
    report: 'Report',
    read_set: '[{resource, revision}]',
    sources: '[ResourceRef]',
    destination: 'ResourceRef',
    expected_revision: 'integer',
  },
  output: {
    invocation_id: 'string',
    report_digest: 'string',
    destination: 'ResourceRef',
    committed_revision: 'integer',
  },
  effects: [
    { input: 'sources', mode: 'read' },
    { input: 'destination', mode: 'write' },
  ],
  permissions: [
    { input: 'sources', mode: 'read' },
    { input: 'destination', mode: 'write' },
  ],
  failures: ['stale_revision', 'access_denied', 'binding_conflict'],
  depends_on: [],
};

export const FIXTURE_CONTRACTS: readonly CapabilityContract[] = [SOURCE_INSPECT, REPORT_ASSEMBLE, REPORT_PUBLISH];
