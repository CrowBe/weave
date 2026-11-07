import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SITE_POLICY,
  transitionSite,
  modelOrigin,
  type RecordedSiteAnswer,
  type SiteTransition,
} from '../src/sites/index.js';
import { gateExtract } from '../src/sites/extract.js';
import { modelExtractSchema } from '../src/sites/model-extract.js';
import { intakeExtractSchema } from '../src/intake.js';
import { isCode } from '@weave/weft';
import {
  DECIDE1_BANDS,
  DECIDE1_RULE_TABLE,
  DECIDE1_RULES,
  bandOfChoice,
  decideBand,
  type Decide1Inputs,
  type Decide1Fact,
} from '../src/decide1.js';

const FALLBACKS = ['low_confidence', 'missing_confidence', 'low_top_p', 'invalid_answer', 'no_answer'];
const THREADS = ['continue_thread', 'steer', 'queue', 'interrupt'];
const TIERS = ['flash', 'standard', 'strong'];
const FACT_NAMES = [
  'intake.decided_by',
  'intake.choice',
  'intake.status',
  'intake.reason',
  'intake.accepted',
  'thread_target',
  'triage.choice',
  'triage.status',
  'triage.reason',
  'triage.accepted',
  'route.choice',
  'route.status',
  'route.reason',
  'route.accepted',
];
function inputs(patch: Record<string, Decide1Fact['value']> = {}): Decide1Inputs {
  const values: Record<string, Decide1Fact['value']> = {
    'intake.decided_by': 'site',
    'intake.choice': 'new_thread',
    'intake.status': 'transition',
    'intake.reason': 'accepted',
    'intake.accepted': true,
    thread_target: null,
    'triage.choice': 'implement',
    'triage.status': 'transition',
    'triage.reason': 'accepted',
    'triage.accepted': true,
    'route.choice': 'flash',
    'route.status': 'transition',
    'route.reason': 'accepted',
    'route.accepted': true,
    ...patch,
  };
  return {
    judgments: [{ name: 'route.confidence', probability: 1 }],
    facts: FACT_NAMES.map((name) => ({ name, value: values[name]! })),
  };
}
function absent(stage: 'triage' | 'route') {
  return Object.fromEntries(['choice', 'status', 'reason', 'accepted'].map((key) => [`${stage}.${key}`, null]));
}
interface Case {
  input: Decide1Inputs;
  rule: string;
  band: string;
  stage: string;
}
/** Reachable closed stage tuples, including the stale fallback and extraction-only stops. */
function domain(): Case[] {
  const cases: Case[] = [];
  const add = (patch: Record<string, Decide1Fact['value']>, rule: string, band: string, stage: string) =>
    cases.push({ input: inputs(patch), rule, band, stage });
  for (const choice of ['new_thread', 'stop', ...THREADS, 'ask_user']) {
    for (const reason of ['stale_answer', 'mismatched_answer', 'decision_unavailable', 'cancelled']) {
      // Nonaccepted intake always records its ask_user fallback, even with an answer.
      add(
        {
          'intake.choice': 'ask_user',
          'intake.status': reason === 'cancelled' || reason === 'decision_unavailable' ? 'paused' : 'needs_human',
          'intake.reason': reason,
          'intake.accepted': false,
          ...absent('triage'),
          ...absent('route'),
        },
        reason === 'decision_unavailable' ? 'hold.outage' : reason === 'cancelled' ? 'hold.paused' : 'hold.admission',
        'ask_human',
        'intake',
      );
    }
    if (choice === 'ask_user') continue;
    if (choice === 'new_thread') continue;
    if (choice === 'stop')
      add(
        { 'intake.choice': choice, ...absent('triage'), ...absent('route') },
        'ask.irreversible',
        'ask_human',
        'intake',
      );
    else
      for (const target of ['resolved', 'no_target', 'ambiguous_reference'])
        add(
          { 'intake.choice': choice, thread_target: target, ...absent('triage'), ...absent('route') },
          target === 'resolved' ? 'act.thread' : 'ask.thread_target',
          target === 'resolved' ? 'tool_call' : 'ask_human',
          'intake',
        );
  }
  for (const decided_by of ['site', 'extract']) {
    for (const reason of decided_by === 'site' ? FALLBACKS : ['ambiguous_reference'])
      add(
        {
          'intake.decided_by': decided_by,
          'intake.choice': 'ask_user',
          'intake.status': 'needs_human',
          'intake.reason': reason,
          'intake.accepted': false,
          ...absent('triage'),
          ...absent('route'),
        },
        'ask.intake',
        'ask_human',
        'intake',
      );
  }
  for (const stage of ['triage', 'route'] as const) {
    for (const reason of [...FALLBACKS, 'stale_answer', 'mismatched_answer', 'decision_unavailable', 'cancelled']) {
      const hold = ['stale_answer', 'mismatched_answer', 'decision_unavailable', 'cancelled'].includes(reason);
      add(
        {
          [`${stage}.choice`]: stage === 'triage' ? 'implement' : 'standard',
          [`${stage}.status`]: ['decision_unavailable', 'cancelled'].includes(reason) ? 'paused' : 'transition',
          [`${stage}.reason`]: reason,
          [`${stage}.accepted`]: false,
          ...(stage === 'triage' ? absent('route') : {}),
        },
        hold
          ? reason === 'decision_unavailable'
            ? 'hold.outage'
            : reason === 'cancelled'
              ? 'hold.paused'
              : 'hold.admission'
          : stage === 'triage'
            ? 'gen.triage_fallback'
            : 'gen.route_fallback',
        'escalate_gen',
        stage,
      );
    }
  }
  for (const [choice, rule] of [
    ['capability', 'act.capability'],
    ['done_check', 'act.done_check'],
    ['out_of_scope', 'act.decline'],
    ['needs_human', 'ask.triage'],
  ])
    add(
      {
        'triage.choice': choice!,
        'triage.status': choice === 'needs_human' ? 'needs_human' : 'transition',
        ...absent('route'),
      },
      rule!,
      choice === 'needs_human' ? 'ask_human' : 'tool_call',
      'triage',
    );
  for (const choice of TIERS) add({ 'route.choice': choice }, 'gen.route', 'escalate_gen', 'route');
  return cases;
}

test('P4a-1 table shape: frozen, closed, unique, no bare spawn', () => {
  assert.equal(DECIDE1_RULE_TABLE, 'decide1.rules@1');
  assert.ok(Object.isFrozen(DECIDE1_RULES));
  assert.equal(new Set(DECIDE1_RULES.map((row) => row.id)).size, 14);
  for (const row of DECIDE1_RULES) {
    assert.ok(Object.isFrozen(row));
    assert.ok(isCode(row.id));
    assert.equal(row.band === 'withheld', row.id.startsWith('hold.'));
    assert.notEqual(row.band, 'spawn_subtasks');
    if (row.band !== 'withheld') assert.ok(DECIDE1_BANDS.includes(row.band));
  }
});
test('P4a-2 totality and reachability over reachable stage tuples; impossible choices fail closed', () => {
  const reached = new Set<string>();
  for (const { input, rule, band } of domain()) {
    const trace = decideBand(input);
    assert.equal(trace.rule, rule);
    assert.equal(trace.band, band);
    reached.add(trace.rule);
  }
  assert.deepEqual([...reached].sort(), DECIDE1_RULES.map((row) => row.id).sort());
  for (const patch of [
    { ...absent('triage'), ...absent('route') },
    { 'intake.choice': 'flash', ...absent('triage'), ...absent('route') },
    { 'triage.choice': 'flash', ...absent('route') },
    { 'triage.accepted': false, 'triage.choice': 'capability', ...absent('route') },
  ])
    assert.throws(() => decideBand(inputs(patch)), /decide1: no rule matched/);
});
test('P4a-3 D-ENG-030: loop fallbacks never ask; admission failures and outages always hold', () => {
  for (const { input, stage } of domain()) {
    const trace = decideBand(input);
    const reason = input.facts.find((fact) => fact.name === `${stage}.reason`)!.value;
    if (stage !== 'intake' && FALLBACKS.includes(reason as string)) assert.notEqual(trace.band, 'ask_human');
    if (['stale_answer', 'mismatched_answer', 'decision_unavailable'].includes(reason as string))
      assert.ok(trace.rule.startsWith('hold.'));
    if (trace.band === 'ask_human' && !trace.rule.startsWith('hold.'))
      assert.ok(['ask.intake', 'ask.irreversible', 'ask.thread_target', 'ask.triage'].includes(trace.rule));
  }
});
test('P4a-4 withheld band covers every stage choice, including stale D1 implement', () => {
  for (const choice of ['ask_user', 'stop', ...THREADS])
    assert.equal(bandOfChoice('intake', choice), THREADS.includes(choice) ? 'tool_call' : 'ask_human');
  for (const choice of ['capability', 'done_check', 'out_of_scope', 'needs_human', 'implement'])
    assert.equal(
      bandOfChoice('triage', choice),
      choice === 'implement' ? 'escalate_gen' : choice === 'needs_human' ? 'ask_human' : 'tool_call',
    );
  for (const choice of TIERS) assert.equal(bandOfChoice('route', choice), 'escalate_gen');
  for (const row of domain().filter((row) => row.rule.startsWith('hold.')))
    assert.equal(decideBand(row.input).band, row.band);
  // Merged P3a can pause on reuse after intake, before D1 exists.
  assert.equal(bandOfChoice('intake', 'new_thread'), 'escalate_gen');
  assert.throws(() => bandOfChoice('route', 'capability'));
});
test('P4a-5 invalid traces throw; immutable inputs and repeatable scalar copies', () => {
  const base = inputs();
  const before = structuredClone(base);
  const invalid = [
    { ...base, judgments: [{ name: 'bad name', probability: 1 }] },
    ...[-1, 2, NaN, Infinity].map((probability) => ({ ...base, judgments: [{ name: 'j', probability }] })),
    {
      ...base,
      judgments: [
        { name: 'j', probability: 1 },
        { name: 'j', probability: 0 },
      ],
    },
    { ...base, facts: [...base.facts, base.facts[0]!] },
    ...[{}, [], 'text with spaces', 'sk-secret', Infinity, NaN].map((value) => ({
      ...base,
      facts: [{ name: 'f', value }],
    })),
    { ...base, facts: [{ name: 'bad name', value: null }] },
    { ...base, facts: Array.from({ length: 65 }, (_, i) => ({ name: `f${i}`, value: null })) },
    { ...base, judgments: Array.from({ length: 65 }, (_, i) => ({ name: `j${i}`, probability: 1 })) },
  ];
  for (const value of invalid) assert.throws(() => decideBand(value as Decide1Inputs));
  const trace = decideBand(base);
  assert.deepEqual(decideBand(base), trace);
  assert.deepEqual(base, before);
  assert.notEqual(trace.facts, base.facts);
  assert.notEqual(trace.judgments, base.judgments);
});
test('P4a-6 Decide-1 has no ports or runtime/site/gateway imports', () => {
  const source = readFileSync(new URL('../../src/decide1.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:from|import\s*)\s*['"](?:\.\/dispatch|\.\/sites\/|@weave\/gateway)/);
  assert.equal(decideBand(inputs()).band, 'escalate_gen');
});

test('P4a-2 impossible dependencies and guarded choices never fall through to a later rule', () => {
  for (const patch of [
    { 'intake.choice': 'flash' },
    { 'intake.choice': 'stop' },
    { 'triage.choice': 'capability' },
    { 'triage.choice': 'flash' },
    { 'triage.accepted': false, 'triage.choice': 'capability' },
    { ...absent('triage') },
    { 'route.choice': 'capability', 'route.accepted': false },
  ])
    assert.throws(() => decideBand(inputs(patch)), /decide1: no rule matched/);
});

// Cross every distinct reachable stage tuple rather than assuming accepted flags or statuses.
// Raw answers here are authored; no benchmark or held-out rows are involved.
test('P4a-2/3 transitionSite domain crosses choices, statistics, admission, outages and dependencies', () => {
  const state = { state_revision: 1, state_updated_at: 10 };
  const terms = {
    quality: 'baseline',
    destinations: ['local'],
    max_context_tokens: 100,
    deadline: 100,
    cost_ceiling: 10,
    max_attempts: 1,
  } as const;
  function transitions(site: 'intake.classify' | 'loop.triage' | 'loop.route') {
    const disclosed =
      site === 'intake.classify'
        ? { message: 'CANARY-msg', running_threads: [] }
        : { request: 'CANARY-msg', context: 'CANARY-ctx' };
    const schema =
      site === 'intake.classify'
        ? intakeExtractSchema({ message: 'CANARY-msg', running_threads: [] })
        : modelExtractSchema(site);
    const origin = modelOrigin(
      gateExtract(schema, JSON.stringify(disclosed), null, {
        site,
        request_id: 'r:x1',
        state_revision: 1,
        verdict: 'original_only',
        reason: 'decision_unavailable',
      }),
    );
    const ask = {
      request_id: 'r',
      ...state,
      terms: { ...terms, destinations: [...terms.destinations] },
      needs_dispatch: true,
      origin,
    };
    const tuples = new Map<string, SiteTransition>();
    for (const choice of [...SITE_POLICY[site].options, 'unknown'])
      for (const confidence of [undefined, NaN, -1, 0, 0.5, 0.75, 0.8, 1, 2])
        for (const probability of [undefined, NaN, 0, 0.5, 0.6, 1, 2])
          for (const mode of ['fresh', 'stale', 'foreign', 'cancelled', 'outage', 'no_answer'] as const) {
            const outcome =
              mode === 'no_answer'
                ? {
                    status: 'blocked',
                    reason: 'policy_denied',
                    request_id: 'r',
                    site,
                    attempts: [],
                    spent: 0,
                    uncertainty: [],
                  }
                : {
                    status: 'accepted',
                    kind: 'choice',
                    request_id: mode === 'foreign' ? 'foreign' : 'r',
                    site,
                    answers: {
                      decision: {
                        type: 'choice',
                        choice,
                        ...(probability === undefined ? {} : { probabilities: { [choice]: probability } }),
                      },
                    },
                    ...(confidence === undefined ? {} : { confidence: { decision: confidence } }),
                    ...(mode === 'outage'
                      ? {
                          paused: {
                            type: 'loop.paused',
                            policy: 'budget.policy@1',
                            request_id: 'r',
                            site,
                            reason: 'quota_unknown',
                            until: null,
                          },
                        }
                      : {}),
                    routed_unit_id: 'fake',
                    attempts: [],
                    spent: 0,
                    uncertainty: [],
                  };
            const recorded = {
              state_revision: 1,
              observed_at: 10,
              outcome,
              cancelled: mode === 'cancelled',
            } as unknown as RecordedSiteAnswer;
            const current = mode === 'stale' ? { ...state, state_revision: 2 } : state;
            const transition =
              site === 'intake.classify'
                ? transitionSite(
                    site,
                    { ...ask, state: { message: 'CANARY-msg', running_threads: [] } },
                    recorded,
                    current,
                  )
                : transitionSite(site, { ...ask, state: disclosed }, recorded, current);
            const key = JSON.stringify([
              transition.choice,
              transition.status,
              transition.observation.reason,
              transition.observation.accepted,
            ]);
            tuples.set(key, transition);
          }
    return [...tuples.values()];
  }
  const intakes = transitions('intake.classify');
  const triages = transitions('loop.triage');
  const routes = transitions('loop.route');
  const reached = new Set<string>();
  let checked = 0;
  const patchStage = (stage: string, value: SiteTransition | null) => ({
    [`${stage}.choice`]: value?.choice ?? null,
    [`${stage}.status`]: value?.status ?? null,
    [`${stage}.reason`]: value?.observation.reason ?? null,
    [`${stage}.accepted`]: value?.observation.accepted ?? null,
  });
  for (const intake of intakes) {
    const next = intake.status === 'transition' && intake.choice === 'new_thread' ? triages : [null];
    for (const triage of next) {
      const last =
        triage?.status === 'transition' && triage.choice === 'implement' && triage.observation.accepted
          ? routes
          : [null];
      for (const route of last)
        for (const target of THREADS.includes(intake.choice)
          ? ['resolved', 'no_target', 'ambiguous_reference']
          : [null]) {
          const input = inputs({
            ...patchStage('intake', intake),
            ...patchStage('triage', triage),
            ...patchStage('route', route),
            thread_target: target,
          });
          const stages = [
            ['intake', intake],
            ['triage', triage],
            ['route', route],
          ] as const;
          // Independent P3a oracle: the first ending stage, before any effect receipt.
          let expected: [string, string] | undefined;
          for (const [stage, value] of stages) {
            if (value === null) continue;
            const reason = value.observation.reason;
            if (['stale_answer', 'mismatched_answer', 'decision_unavailable', 'cancelled'].includes(reason)) {
              expected = [
                reason === 'decision_unavailable'
                  ? 'hold.outage'
                  : reason === 'cancelled'
                    ? 'hold.paused'
                    : 'hold.admission',
                stage === 'intake' ? 'ask_human' : 'escalate_gen',
              ];
              break;
            }
            if (value.status === 'needs_human') {
              expected = [stage === 'intake' ? 'ask.intake' : 'ask.triage', 'ask_human'];
              break;
            }
            if (stage === 'intake') {
              if (value.choice === 'stop') {
                expected = ['ask.irreversible', 'ask_human'];
                break;
              }
              if (THREADS.includes(value.choice)) {
                expected = [
                  target === 'resolved' ? 'act.thread' : 'ask.thread_target',
                  target === 'resolved' ? 'tool_call' : 'ask_human',
                ];
                break;
              }
            } else if (stage === 'triage') {
              if (!value.observation.accepted) {
                expected = ['gen.triage_fallback', 'escalate_gen'];
                break;
              }
              if (value.choice !== 'implement') {
                expected = [value.choice === 'out_of_scope' ? 'act.decline' : `act.${value.choice}`, 'tool_call'];
                break;
              }
            } else expected = [value.observation.accepted ? 'gen.route' : 'gen.route_fallback', 'escalate_gen'];
          }
          assert.ok(expected);
          const trace = decideBand(input);
          assert.deepEqual([trace.rule, trace.band], expected);
          reached.add(trace.rule);
          checked += 1;
        }
    }
  }
  assert.deepEqual([intakes.length, triages.length, routes.length, checked], [14, 14, 11, 45]);
  assert.ok(reached.has('hold.admission'));
  assert.ok(reached.has('gen.triage_fallback'));
  assert.ok(reached.has('gen.route_fallback'));
});
