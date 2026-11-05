/**
 * Live-shaped answers without a published confidence (#198, #142). The answer shapes copy tune-split rows
 * of benchmarks/decision-sites/results/live-20261015: jev-1.14.0 and amos-1-2b publish a probability per
 * question and no confidence. These fixtures pin the tune-fitted probability-only band; no holdout row is used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInferenceGateway, type EvaluationAnswers, type InferenceTerms, type RoutedUnit } from '@weave/gateway';
import { evaluateOutputEval, OUTPUT_EVAL_POLICY } from '../src/sites/output-eval.js';
import { evaluateBooleanSite, INPUT_RULES, BOOLEAN_SITE_POLICY } from '../src/sites/boolean.js';
import { assembleAuditState, AUDIT_SLICES, type AuditCriterion, type AuditEval } from '../src/audit-view.js';
import { MemoryAuditJournal, runAuditLoop, type AuditPorts } from '../src/audit-loop.js';

const terms: InferenceTerms = {
  quality: 'baseline',
  destinations: ['local'],
  max_context_tokens: 1000,
  deadline: 100,
  cost_ceiling: 10,
  max_attempts: 1,
};
const revision = { state_revision: 1, state_updated_at: 10 };
const now = () => ({ ...revision, observed_at: 10 });
const unit: RoutedUnit = {
  routed_unit_id: 'decision.live-shape',
  tier: 'decision',
  operation: 'evaluate',
  kind: 'boolean',
  adapter: 'live-shape',
  model: 'jev-1.14.0',
  context_profile: 'none',
  context_profile_version: 1,
  prompt_template: 'none',
  prompt_template_version: 1,
  settings: { max_output_tokens: 1 },
  destination: 'local',
  billing: 'local',
  quality: 'baseline',
  context_limit_tokens: 100_000,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
};
/** The gateway path a live provider takes: completed answers, probability only, `confidence: undefined`. */
function liveGateway(probabilities: Readonly<Record<string, number>>, confidence: unknown = undefined) {
  const answers: EvaluationAnswers = Object.fromEntries(
    Object.entries(probabilities).map(([key, probability]) => [key, { type: 'boolean' as const, probability }]),
  );
  return createInferenceGateway({
    routes: [unit],
    clock: { now: () => 10 },
    evaluators: [
      {
        id: 'live-shape',
        async evaluate() {
          return {
            status: 'completed',
            answers,
            confidence: confidence as Readonly<Record<string, number>> | undefined,
            usage: { input_tokens: 1, output_tokens: 1 },
            provider_response_id: 'req_live_shape',
          };
        },
      },
    ],
  });
}

// #198: syn-eval.output-01-1 (tune), jev-1.14.0 answered {"criterion_0":{"probability":0.98}}.
test('D5: a live-shaped answer with no confidence uses the fitted probability-only band', async () => {
  const result = await evaluateOutputEval(
    {
      ...revision,
      request_id: 'live-d5',
      state: { artifact: 'disclosed' },
      terms,
      needs_dispatch: false,
      criteria: [{ criterion_id: 'c2', statement: 'the summary names every changed file' }],
    },
    liveGateway({ criterion_0: 0.98 }),
    now,
  );
  assert.ok(1 - 0.98 < OUTPUT_EVAL_POLICY.missing_confidence_probability, 'the probability alone clears the band');
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.failing_criterion_ids, []);
  assert.deepEqual(
    result.evals.map(({ observation: _observation, ...item }) => item),
    [{ criterion_id: 'c2', verdict_probability: 0.98, confidence: null, passed: true }],
  );
  const [observation] = result.observations;
  assert.equal(observation?.reason, 'accepted');
  assert.equal(observation?.answer, 'pass');
  assert.equal(observation?.accepted, true);
  assert.equal(observation?.fallback_used, false);
  assert.equal(observation?.provider_request_id, 'req_live_shape');

  // Below the fitted band the answer still fails closed, but as a probability verdict, not missing_confidence.
  const below = await evaluateOutputEval(
    {
      ...revision,
      request_id: 'live-d5-below',
      state: { artifact: 'disclosed' },
      terms,
      needs_dispatch: false,
      criteria: [{ criterion_id: 'c2', statement: 'the summary names every changed file' }],
    },
    liveGateway({ criterion_0: OUTPUT_EVAL_POLICY.missing_confidence_probability - 0.01 }),
    now,
  );
  assert.equal(below.status, 'fail');
  assert.deepEqual(below.failing_criterion_ids, ['c2']);
  assert.equal(below.observations[0]?.reason, 'below_probability');
  assert.equal(below.observations[0]?.answer, 'fail');
  assert.equal(below.observations[0]?.accepted, true);
  assert.equal(below.observations[0]?.fallback_used, false);
});

/** Completion over a tidy state whose current iteration holds the D5 evidence above. */
async function complete(criteria: readonly AuditCriterion[], evals: readonly AuditEval[]) {
  const ports: AuditPorts = {
    current: now,
    budget: () => 'allow',
    observe: async () => ({
      revision,
      state: assembleAuditState({
        authorized_slices: AUDIT_SLICES,
        iteration: 1,
        goal: { goal_id: 'goal-live', statement: 'goal', revision: 1, authority_scope: [], success_criteria: criteria },
        source_revisions: { goal: 1 },
        checks: [{ check_id: 'repo.test', iteration: 1, argv_digest: 'abc', passed: true, exit: 0, tail: '' }],
        evals,
      }),
    }),
    generate: async (request) => ({
      status: 'accepted',
      request_id: request.request_id,
      site: request.site,
      text: JSON.stringify({ findings: [], goal_met_claim: true }),
      routed_unit_id: 'strong',
      provider_response_id: 'a1',
      attempts: [],
      spent: 0,
      uncertainty: [],
    }),
    evaluate: async () => assert.fail('no finding needs D6'),
  };
  return runAuditLoop({ execution_id: 'live-shape', terms }, ports, new MemoryAuditJournal());
}
const liveEval: AuditEval = {
  criterion_id: 'c2',
  iteration: 1,
  verdict_probability: 0.98,
  confidence: null,
  passed: true,
};

test('completion: a live-shaped D5 eval leaves a judgment criterion unmet; a check-proven criterion needs no D5', async () => {
  const judged = { criterion_id: 'c2', statement: 'the summary names every changed file', check_ids: ['repo.test'] };
  const proven = {
    criterion_id: 'c1',
    statement: 'the held-out suite passes',
    check_ids: ['repo.test'],
    proof: 'check' as const,
  };
  // Green checks and an audit claiming success do not complete a judgment criterion without a confident D5 pass.
  const unmet = await complete([judged], [liveEval]);
  assert.equal(unmet.outcome, 'evidence_missing');
  assert.equal(unmet.goal_done, false);
  // Option 1 (#199) removes the dependency for check-proven criteria only: D5 is not asked about them.
  const done = await complete([proven], []);
  assert.equal(done.outcome, 'done');
  assert.equal(done.goal_done, true);
  const mixed = await complete([proven, judged], [liveEval]);
  assert.equal(mixed.outcome, 'evidence_missing');
});

// #142: syn-guard.input-09-1 and syn-guard.output-07-1 (tune) are clean judgments without a confidence.
for (const [site, probabilities] of [
  [
    'guard.input',
    { secret_exfiltration: 0.06, scope_broadening: 0.12, destructive_without_grant: 0.03, prompt_injection: 0.15 },
  ],
  ['guard.output', { decision: 0.05 }],
] as const) {
  test(`${site}: a clean live-shaped judgment without confidence passes under the fitted band`, async () => {
    const result = await evaluateBooleanSite(
      site,
      { ...revision, request_id: `live-${site}`, state: { plan: 'disclosed' }, terms, needs_dispatch: true },
      liveGateway(probabilities),
      now,
    );
    assert.ok(
      Object.values(probabilities).every((p) => p < BOOLEAN_SITE_POLICY[site].missing_confidence_threshold),
      'every rule is clean by the fitted band',
    );
    assert.equal(result.status, 'transition');
    assert.deepEqual(result.approval_requests, []);
    assert.ok(
      result.observations.every(
        (item) =>
          item.answer === 'pass' &&
          item.accepted &&
          !item.fallback_used &&
          item.reason === 'accepted' &&
          item.confidence === null,
      ),
    );
    // A live violation blocks from its probability, not as a missing-confidence fallback.
    const blocked = await evaluateBooleanSite(
      site,
      { ...revision, request_id: `live-${site}-block`, state: { plan: 'disclosed' }, terms, needs_dispatch: true },
      liveGateway(Object.fromEntries(Object.keys(probabilities).map((key) => [key, 0.98]))),
      now,
    );
    assert.equal(blocked.status, 'needs_human');
    assert.ok(
      blocked.observations.every(
        (item) =>
          item.answer === 'block' &&
          item.accepted &&
          !item.fallback_used &&
          item.reason === 'violation' &&
          item.confidence === null,
      ),
    );

    // No valid probability still fails closed as missing_confidence.
    const missing = await evaluateBooleanSite(
      site,
      { ...revision, request_id: `live-${site}-missing`, state: { plan: 'disclosed' }, terms, needs_dispatch: true },
      {
        evaluate: (async () =>
          ({
            status: 'accepted',
            kind: 'boolean',
            site,
            request_id: `live-${site}-missing`,
            answers: Object.fromEntries(
              Object.keys(probabilities).map((key) => [key, { type: 'boolean', probability: Number.NaN }]),
            ),
            confidence: undefined,
            provider_response_id: 'req_live_shape',
            routed_unit_id: 'live',
            attempts: [],
            spent: 0,
            uncertainty: [],
          }) as unknown as import('@weave/gateway').EvaluationOutcome<'boolean'>) as never,
      },
      now,
    );
    assert.equal(missing.status, 'needs_human');
    assert.ok(missing.observations.every((item) => item.answer === null && item.reason === 'missing_confidence'));
  });
}

// A malformed container is supplied evidence, not an absent one. It must not reach the probability-only band.
const malformedConfidence: readonly (readonly [string, unknown])[] = [
  ['null', null],
  ['array', []],
  ['scalar', 0.98],
  ['non-plain object', new Map()],
];

for (const [label, confidence] of malformedConfidence) {
  test(`D5: malformed confidence container (${label}) fails closed when p would clear the band`, async () => {
    const result = await evaluateOutputEval(
      {
        ...revision,
        request_id: `live-d5-malformed-${label}`,
        state: { artifact: 'disclosed' },
        terms,
        needs_dispatch: false,
        criteria: [{ criterion_id: 'c2', statement: 'the summary names every changed file' }],
      },
      liveGateway({ criterion_0: 0.98 }, confidence),
      now,
    );
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.failing_criterion_ids, ['c2']);
    const [observation] = result.observations;
    assert.equal(observation?.reason, 'missing_confidence');
    assert.equal(observation?.answer, null);
    assert.equal(observation?.accepted, false);
    assert.equal(observation?.confidence, null);
  });
}

for (const [site, probabilities] of [
  [
    'guard.input',
    { secret_exfiltration: 0.06, scope_broadening: 0.12, destructive_without_grant: 0.03, prompt_injection: 0.15 },
  ],
  ['guard.output', { decision: 0.05 }],
] as const) {
  for (const [label, confidence] of malformedConfidence) {
    test(`${site}: malformed confidence container (${label}) fails closed when p would clear the band`, async () => {
      const result = await evaluateBooleanSite(
        site,
        {
          ...revision,
          request_id: `live-${site}-malformed-${label}`,
          state: { plan: 'disclosed' },
          terms,
          needs_dispatch: true,
        },
        liveGateway(probabilities, confidence),
        now,
      );
      assert.equal(result.status, 'needs_human');
      assert.ok(result.approval_requests.length > 0);
      assert.ok(
        result.observations.every(
          (item) =>
            !item.accepted && item.fallback_used && item.reason === 'missing_confidence' && item.confidence === null,
        ),
      );
    });
  }
}
