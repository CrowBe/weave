/**
 * Deterministic checks for the paired `frontier.weigh@1` comparison: frozen
 * case set, labels against the rubric, red controls rejected, the rule
 * reachable, and the committed report in step with the offline rows.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { EvaluationCall } from '@weave/gateway';
import { buildCase, loadCaseSet, type BuiltCase } from '../build.ts';
import { summaryRow, verdictSection } from '../report.ts';
import { compare, configureJev, OFFLINE_WEIGHERS } from '../run.ts';
import { adjudicate, CASESET_DIGEST, promotion, scoreCase, summarize, type CaseResult } from '../score.ts';
import { fixtureWeigher, scriptedWeigher, type Weigher } from '../weighers.ts';

const { set, digest } = loadCaseSet();
const built = set.cases.map(buildCase);

/** Answers each question from the adjudicated label. A test instrument only. */
function labelWeigher(id: string, invert: boolean): Weigher {
  const byContent = new Map(built.map((item) => [JSON.stringify(item.view.content), item]));
  return fixtureWeigher(id, (call: EvaluationCall, candidate_id) => {
    const item = byContent.get(JSON.stringify(call.state)) as BuiltCase;
    const preferred = item.case.label.preferred.includes(item.keys.get(candidate_id) as string);
    return preferred !== invert ? 2 : 0;
  });
}

async function rows(weighers: readonly Weigher[]): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const weigher of weighers) {
    for (const item of built) {
      out.push(scoreCase(item, weigher.id, await weigher.weigh(item)));
    }
  }
  return out;
}

describe('frontier.weigh@1 case set', () => {
  it('is frozen: cases.json matches the declared digest', () => {
    assert.equal(digest, CASESET_DIGEST);
  });

  it('keeps tune and holdout apart', () => {
    const ids = set.cases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    const tune = set.cases.filter((c) => c.split === 'tune');
    const holdout = set.cases.filter((c) => c.split === 'holdout');
    assert.equal(tune.length, 8);
    assert.equal(holdout.length, 15);
    const tuneSpecs = new Set(tune.map((c) => JSON.stringify(c.spec)));
    assert.ok(holdout.every((c) => !tuneSpecs.has(JSON.stringify(c.spec))), 'a scenario crosses splits');
    for (const kind of ['gather', 'act', 'hold'] as const) {
      assert.ok(holdout.some((c) => c.label.kind === kind), `holdout lacks a ${kind} case`);
    }
  });

  it('builds every case from its log with the stated budget and an eligible choice', () => {
    for (const item of built) {
      const { spec, label } = item.case;
      const budget = item.state.budget.actions;
      assert.equal(budget.limit - budget.reserved - budget.spent, spec.actions_remaining, item.case.id);
      assert.ok(item.eligible.length > 0, `${item.case.id}: nothing to weigh`);
      const keys = new Set(item.eligible.map((candidate) => item.keys.get(candidate.candidate_id)));
      for (const key of [...label.preferred, ...label.critical]) {
        assert.ok(keys.has(key), `${item.case.id}: ${key} is not an eligible candidate`);
      }
      assert.equal(item.view.profile, 'profile.frontier-weigh@2');
      assert.equal(JSON.stringify(item.view.content).includes('source:gamma'), false);
    }
  });

  it('labels agree with an independent reading of the rubric', () => {
    for (const item of built) {
      const derived = adjudicate(item);
      const label = item.case.label;
      assert.deepEqual(derived.preferred, [...label.preferred].sort(), `${item.case.id} preferred`);
      assert.deepEqual(derived.critical, [...label.critical].sort(), `${item.case.id} critical`);
      assert.equal(derived.needed, label.needed, `${item.case.id} needed`);
      assert.equal(derived.kind, label.kind, `${item.case.id} kind`);
      assert.equal(derived.rule, label.rule, `${item.case.id} rule`);
    }
  });
});

describe('frontier.weigh@1 promotion rule', () => {
  it('rejects the constant weighers (red)', async () => {
    const results = await rows(OFFLINE_WEIGHERS.map(({ weigher }) => weigher()));
    const dispatch = promotion(results, 'constant-dispatch');
    const defer = promotion(results, 'constant-defer');
    assert.equal(dispatch.verdict, 'retain scripted@1');
    assert.equal(defer.verdict, 'retain scripted@1');
    assert.equal(dispatch.checks.find((check) => check.id === 'P2')?.held, false);
    assert.equal(defer.checks.find((check) => check.id === 'P3')?.held, false);
  });

  it('promotes only a weigher that clears every predeclared check', async () => {
    const results = await rows([scriptedWeigher(), labelWeigher('label-oracle', false), labelWeigher('label-inverted', true)]);
    const oracle = promotion(results, 'label-oracle');
    assert.equal(oracle.verdict, 'promote', JSON.stringify(oracle.checks));
    assert.equal(summarize(results, 'label-oracle', 'holdout').agreement, 1);
    assert.equal(promotion(results, 'label-inverted').verdict, 'retain scripted@1');
  });

  it('records the scripted baseline exactly', async () => {
    const results = await rows([scriptedWeigher()]);
    const holdout = summarize(results, 'scripted@1', 'holdout');
    const tune = summarize(results, 'scripted@1', 'tune');
    assert.equal(holdout.agreed, 6);
    assert.equal(holdout.outcomes.premature, 4);
    assert.equal(holdout.outcomes.misdirected, 5);
    assert.equal(tune.agreed, 5);
    assert.ok(results.every((row) => row.status === 'accepted' && row.spent === 0));
  });

  it('treats a failed weighing as no frontier and no credit', async () => {
    const failing: Weigher = {
      id: 'failing',
      kind: 'fixture',
      async weigh() {
        return { status: 'failed', reason: 'unavailable', weights: [], contract: undefined, implementation: 'failing', spent: 3, attempts: 1, latency_ms: null };
      },
    };
    const results = await rows([scriptedWeigher(), failing]);
    const failed = results.filter((row) => row.weigher === 'failing');
    assert.ok(failed.every((row) => row.outcome === 'failed' && !row.agrees && row.selected.length === 0));
    assert.equal(promotion(results, 'failing').checks.find((check) => check.id === 'P1')?.held, false);
  });
});

describe('frontier.weigh@1 paired report', () => {
  it('does not configure Jev without a credential', () => {
    assert.deepEqual(configureJev({}), { not_run: 'no_credential' });
  });

  it('the committed report carries the offline rows and records Jev as not run', async () => {
    const recorded = JSON.parse(readFileSync(new URL('../results.json', import.meta.url), 'utf8')) as {
      digest: string;
      jev: { status: 'run' | 'not_run'; reason?: string };
    };
    assert.equal(recorded.digest, CASESET_DIGEST);
    const comparison = await compare(
      OFFLINE_WEIGHERS.map(({ weigher, role }) => ({ weigher: weigher(), role })),
      { status: 'not_run', reason: recorded.jev.reason ?? 'no_credential' },
    );
    const committed = readFileSync(new URL('../REPORT.md', import.meta.url), 'utf8');
    for (const { weigher } of OFFLINE_WEIGHERS) {
      const id = weigher().id;
      for (const split of ['tune', 'holdout'] as const) {
        assert.ok(committed.includes(summaryRow(summarize(comparison.results, id, split))), `${id} ${split} row drifted`);
      }
    }
    for (const verdict of comparison.verdicts) {
      assert.ok(committed.includes(verdictSection(verdict)), `${verdict.weigher} verdict drifted`);
    }
    if (recorded.jev.status === 'not_run') {
      assert.equal(committed, comparison.report);
      assert.match(committed, /\*\*Not run: `[a-z_]+`\.\*\* This is not a pass/);
      assert.equal(committed.includes('### jev'), false);
    }
  });
});
