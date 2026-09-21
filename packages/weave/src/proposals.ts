/**
 * Validate a generated binding proposal into accepted / rejected lists.
 * Being listed is not authority to execute (docs/m2-handle-a-novel-request.md §2).
 */
import type { Describe } from './candidates.js';
import type { Goal, Proposal, ProposedBinding, RejectedBinding, State } from './types.js';

export function parseProposalText(text: string): { ok: true; bindings: ProposedBinding[] } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'proposal must be a record' };
  }
  const bindings = (parsed as { bindings?: unknown }).bindings;
  if (!Array.isArray(bindings)) {
    return { ok: false, reason: 'proposal.bindings must be a list' };
  }
  const out: ProposedBinding[] = [];
  for (const item of bindings) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, reason: 'binding must be a record' };
    }
    const record = item as { operation?: unknown; inputs?: unknown };
    if (typeof record.operation !== 'string' || record.operation.length === 0) {
      return { ok: false, reason: 'binding requires operation' };
    }
    out.push({ operation: record.operation, inputs: record.inputs ?? {} });
  }
  return { ok: true, bindings: out };
}

export function validateProposal(
  bindings: readonly ProposedBinding[],
  state: State,
  describe: Describe,
): Proposal {
  const goal = state.goal;
  const accepted: ProposedBinding[] = [];
  const rejected: RejectedBinding[] = [];
  for (const binding of bindings) {
    const reason = rejectReason(binding, state, goal, describe);
    if (reason) {
      rejected.push({ ...binding, reason });
    } else {
      accepted.push(binding);
    }
  }
  return { bindings: accepted, rejected };
}

export function proposalCoversSources(proposal: Proposal, sources: readonly string[]): boolean {
  const covered = new Set<string>();
  for (const binding of proposal.bindings) {
    if (binding.operation !== 'source.inspect') {
      continue;
    }
    const source =
      typeof binding.inputs === 'object' && binding.inputs !== null && !Array.isArray(binding.inputs)
        ? (binding.inputs as { source?: unknown }).source
        : undefined;
    if (typeof source === 'string') {
      covered.add(source);
    }
  }
  return sources.every((s) => covered.has(s));
}

function rejectReason(
  binding: ProposedBinding,
  state: State,
  goal: (Goal & { status: string; evidence: number }) | null,
  describe: Describe,
): string | null {
  if (!goal) {
    return 'no active goal';
  }
  if (binding.operation !== 'source.inspect') {
    return describe(binding.operation) ? 'operation not allowed in proposal' : 'unknown_operation';
  }
  const inputs = binding.inputs;
  const source =
    typeof inputs === 'object' && inputs !== null && !Array.isArray(inputs)
      ? (inputs as { source?: unknown }).source
      : undefined;
  if (typeof source !== 'string' || source.length === 0) {
    return 'source.inspect requires a source';
  }
  if (!goal.authority.read.includes(source)) {
    return `no read authority for ${source}`;
  }
  if (!state.sources[source]) {
    return `unknown source ${source}`;
  }
  if (!describe('source.inspect')) {
    return 'capability unavailable';
  }
  return null;
}
