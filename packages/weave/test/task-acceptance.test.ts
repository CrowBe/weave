/**
 * Acceptance facts, task validation, and the offline frozen set.
 * The live Jev route is not called here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { EvaluationOutcome, EvaluationRequest, InferenceGateway, InferenceTerms } from '@weave/gateway';
import {
  ACCEPTANCE_LINE_CONTRACT,
  ACCEPTANCE_LINE_CONTRACT_RECORD,
  DECLARED_TASK_POLICY,
  TASK_CRITERIA_SITE,
  TASK_JEV_MODEL_ID,
  TASK_VALIDATE_SITE,
  admitProposedLine,
  admitProposedLines,
  decideCriteria,
  decideValidation,
  judgeCriteria,
  judgeValidation,
  loadFrozenSet,
  planLiveComparison,
  replayCriteria,
  replayValidation,
  runLiveComparison,
  scoreFrozenSet,
  taskJevRoute,
  validationFromFixture,
  type AcceptanceLine,
  type TaskConstraintDeclaration,
  type TaskJudgmentPolicy,
} from '@weave/weave';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const TERMS: InferenceTerms = {
  quality: 'baseline',
  destinations: ['typesafe-ai'],
  max_context_tokens: 4_000,
  deadline: 1_000,
  cost_ceiling: 1_000,
  max_attempts: 1,
};

const OPEN: TaskConstraintDeclaration = { constraints: [], authority: [] };
const DECLARED_BANS: TaskConstraintDeclaration = {
  constraints: ['do_not_send', 'do_not_delete', 'ask_before_effect'],
  authority: [],
};

const readme = (fact = 'README.md contains the heading "Installation"'): AcceptanceLine => ({
  line_id: 'readme',
  fact,
  evidence: { kind: 'artifact', artifact_id: 'readme' },
  escape: 'README.md is absent',
});

function gateway(impl: (request: EvaluationRequest<'boolean'>) => EvaluationOutcome<'boolean'>): InferenceGateway & {
  readonly calls: EvaluationRequest<'boolean'>[];
} {
  const calls: EvaluationRequest<'boolean'>[] = [];
  return {
    calls,
    async generate() {
      throw new Error('task acceptance must not generate');
    },
    async evaluate(request) {
      const booleanRequest = request as unknown as EvaluationRequest<'boolean'>;
      calls.push(booleanRequest);
      return impl(booleanRequest) as EvaluationOutcome<typeof request.kind>;
    },
  };
}

function accepted(
  site: string,
  requestId: string,
  answers: Readonly<Record<string, { readonly probability: number; readonly confidence: number | null }>>,
  model: string = TASK_JEV_MODEL_ID,
): EvaluationOutcome<'boolean'> {
  const confidence: Record<string, number> = {};
  const shaped: Record<string, { type: 'boolean'; probability: number }> = {};
  let any = false;
  for (const [id, value] of Object.entries(answers)) {
    shaped[id] = { type: 'boolean', probability: value.probability };
    if (value.confidence !== null) {
      confidence[id] = value.confidence;
      any = true;
    }
  }
  return {
    status: 'accepted',
    kind: 'boolean',
    answers: shaped,
    confidence: any ? confidence : undefined,
    routed_unit_id: 'boolean.task@jev-1.13.0',
    provider_response_id: undefined,
    request_id: requestId,
    site,
    attempts: [
      {
        attempt: 1,
        routed_unit_id: 'boolean.task@jev-1.13.0',
        model,
        started_at: 1,
        ended_at: 2,
        usage: { input_tokens: 10, output_tokens: 1 },
        cost: 1,
        cost_is_upper_bound: false,
        disposition: { status: 'accepted' },
      },
    ],
    spent: 1,
    uncertainty: [],
  };
}

describe('acceptance line admission', () => {
  it('names the boolean question, the Noul wire primitive, and the state each site may see', () => {
    assert.equal(ACCEPTANCE_LINE_CONTRACT, 'acceptance.line@1');
    assert.equal(ACCEPTANCE_LINE_CONTRACT_RECORD.question_primitive, 'boolean');
    assert.equal(ACCEPTANCE_LINE_CONTRACT_RECORD.wire_primitive, 'noul');
    assert.equal(ACCEPTANCE_LINE_CONTRACT_RECORD.criteria_site, TASK_CRITERIA_SITE);
    assert.equal(ACCEPTANCE_LINE_CONTRACT_RECORD.validation_site, TASK_VALIDATE_SITE);
    assert.equal(TASK_CRITERIA_SITE, 'task.criteria');
    assert.notEqual(TASK_VALIDATE_SITE, 'frontier.weigh');
  });

  it('rejects taste, counts, dates, totals, and compound lines', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['the result is reasonable', 'judgment'],
      ['the result is appropriate', 'judgment'],
      ['the suite reports 12 passing tests', 'count'],
      ['the file was updated today', 'date'],
      ['the total is forty', 'total'],
      ['the file lists alpha and beta', 'compound_fact'],
    ];
    for (const [fact, reason] of cases) {
      const admission = admitProposedLine({ ...readme(fact) });
      assert.equal(admission.status, 'rejected', fact);
      if (admission.status === 'rejected') assert.equal(admission.reason, reason);
    }
  });

  it('admits one observable fact, including a digit that is only a quoted literal', () => {
    const heading = admitProposedLine(readme());
    assert.equal(heading.status, 'admitted');
    const quoted = admitProposedLine(readme('the artifact contains the heading "Step 1"'));
    assert.equal(quoted.status, 'admitted');
  });

  it('rejects a line with no escape and a duplicated id', () => {
    const { escape: _escape, ...without } = readme();
    void _escape;
    const missing = admitProposedLine(without);
    assert.equal(missing.status, 'rejected');
    if (missing.status === 'rejected') assert.equal(missing.reason, 'missing_escape');
    const duplicated = admitProposedLines([readme(), readme()]);
    assert.equal(duplicated.length, 2);
    assert.ok(duplicated.every((line) => line.status === 'rejected' && line.reason === 'duplicate_line_id'));
  });

  it('pins jev-1.13.0 on the boolean route', () => {
    const route = taskJevRoute('typesafe-ai', 'typesafe-ai');
    assert.equal(route.model, 'jev-1.13.0');
    assert.equal(route.kind, 'boolean');
    assert.equal(route.operation, 'evaluate');
    assert.equal(route.model.includes('latest'), false);
    assert.notEqual(route.model, 'typesafe-ai/jev');
    assert.equal(DECLARED_TASK_POLICY.probability_threshold, 0.8);
    assert.equal(DECLARED_TASK_POLICY.confidence_floor, 0.9);
  });
});

describe('criteria gate', () => {
  it('sends only admitted lines, as one boolean request, and revises on low confidence', async () => {
    const calls = gateway((request) =>
      accepted(request.site, request.request_id, {
        readme: { probability: 0.96, confidence: 0.4 },
        export: { probability: 0.2, confidence: 0.97 },
      }),
    );
    const record = await judgeCriteria(
      [
        { ...readme('the result is reasonable'), line_id: 'taste' },
        { ...readme(), line_id: 'readme' },
        {
          line_id: 'export',
          fact: 'src/app.ts exports createServer',
          evidence: { kind: 'artifact', artifact_id: 'app' },
          escape: 'src/app.ts is absent',
        },
      ],
      { request_id: 'criteria-1', terms: TERMS, gateway: calls },
    );
    assert.equal(calls.calls.length, 1);
    const request = calls.calls[0];
    assert.ok(request);
    assert.equal(request.kind, 'boolean');
    assert.equal(request.site, 'task.criteria');
    assert.equal(request.role, 'working');
    assert.deepEqual(Object.keys(request.questions).sort(), ['export', 'readme']);
    for (const question of Object.values(request.questions)) assert.equal(question.type, 'boolean');
    const state = JSON.stringify(request.state);
    assert.equal(state.includes('reasonable'), false);
    assert.equal(state.includes('# Installation'), false);

    const decision = decideCriteria(record);
    const byId = Object.fromEntries(decision.lines.flatMap((line) => (line.line_id === null ? [] : [[line.line_id, line]])));
    assert.equal(byId['readme']?.status, 'revise');
    assert.equal(byId['readme']?.reason, 'low_confidence');
    assert.equal(byId['export']?.status, 'rejected');
    assert.equal(byId['export']?.reason, 'not_one_observable_fact');
    assert.deepEqual(decision.entered, []);
    assert.equal(replayCriteria(record).lines.length, decision.lines.length);
    assert.equal(calls.calls.length, 1);
  });

  it('does not call Jev when every line is rejected', async () => {
    const calls = gateway(() => {
      throw new Error('no request');
    });
    const record = await judgeCriteria([readme('the result is reasonable')], {
      request_id: 'criteria-none',
      terms: TERMS,
      gateway: calls,
    });
    assert.equal(calls.calls.length, 0);
    assert.equal(record.requested, false);
    assert.deepEqual(decideCriteria(record).entered, []);
  });

  it('refuses a floating model before the call', async () => {
    const calls = gateway(() => {
      throw new Error('no request');
    });
    const policy = { ...DECLARED_TASK_POLICY, model: 'jev-latest' } as unknown as TaskJudgmentPolicy;
    await assert.rejects(() => judgeCriteria([readme()], { request_id: 'bad-model', terms: TERMS, gateway: calls, policy }));
    assert.equal(calls.calls.length, 0);
  });
});

describe('task validation', () => {
  const body = [{ artifact_id: 'readme', body: '# Installation\n' }];

  it('passes only when every Noul clears the declared threshold and the confidence floor', async () => {
    const calls = gateway((request) =>
      accepted(request.site, request.request_id, { readme: { probability: 0.8, confidence: 0.9 } }),
    );
    const record = await judgeValidation([readme()], body, [], OPEN, { request_id: 'val-pass', terms: TERMS, gateway: calls });
    const decision = decideValidation(record);
    assert.equal(decision.disposition, 'done');
    assert.equal(decision.done, true);
    assert.equal(calls.calls.length, 1);
    assert.equal(calls.calls[0]?.site, 'task.validate');
    assert.equal(calls.calls[0]?.kind, 'boolean');
    assert.deepEqual(replayValidation(record), decision);
    assert.equal(calls.calls.length, 1);
  });

  it('fails a fact the write-up calls done, and keeps the write-up out of the state', async () => {
    const writeUp = 'UNIQUE_WRITE_UP I am highly confident this is complete';
    const calls = gateway((request) =>
      accepted(request.site, request.request_id, { readme: { probability: 0.15, confidence: 0.98 } }),
    );
    const record = await judgeValidation([readme()], body, [], OPEN, { request_id: 'val-fail', terms: TERMS, gateway: calls }, writeUp);
    const decision = decideValidation(record);
    assert.equal(decision.done, false);
    assert.equal(decision.disposition, 'fail');
    assert.equal(decision.write_up_ignored, true);
    assert.equal(JSON.stringify(record.state).includes('UNIQUE_WRITE_UP'), false);
    assert.equal(JSON.stringify(calls.calls[0]?.state).includes('UNIQUE_WRITE_UP'), false);
  });

  it('escalates below the confidence floor, including a missing confidence', () => {
    const low = validationFromFixture([readme()], body, [], { readme: { probability: 0.95, confidence: 0.899 } }, OPEN);
    assert.equal(decideValidation(low).disposition, 'escalate');
    const missing = validationFromFixture([readme()], body, [], { readme: { probability: 0.95, confidence: null } }, OPEN);
    assert.equal(replayValidation(missing).disposition, 'escalate');
    assert.equal(replayValidation(missing).done, false);
  });

  it('treats a confident failure as fail even when another Noul is uncertain', () => {
    const second: AcceptanceLine = {
      line_id: 'export',
      fact: 'src/app.ts exports createServer',
      evidence: { kind: 'artifact', artifact_id: 'app' },
      escape: 'src/app.ts is absent',
    };
    const record = validationFromFixture(
      [readme(), second],
      [...body, { artifact_id: 'app', body: 'export function createServer() {}\n' }],
      [],
      {
        readme: { probability: 0.1, confidence: 0.96 },
        export: { probability: 0.95, confidence: 0.2 },
      },
      OPEN,
    );
    assert.equal(decideValidation(record).disposition, 'fail');
  });

  it('asks every shown fact in one request and escapes a missing artifact without calling', async () => {
    const second: AcceptanceLine = {
      line_id: 'export',
      fact: 'src/app.ts exports createServer',
      evidence: { kind: 'artifact', artifact_id: 'app' },
      escape: 'src/app.ts is absent',
    };
    const calls = gateway((request) =>
      accepted(request.site, request.request_id, {
        readme: { probability: 0.95, confidence: 0.95 },
        export: { probability: 0.95, confidence: 0.95 },
      }),
    );
    const record = await judgeValidation(
      [readme(), second],
      [...body, { artifact_id: 'app', body: 'export function createServer() {}\n' }],
      [],
      OPEN,
      { request_id: 'val-two', terms: TERMS, gateway: calls },
    );
    assert.equal(calls.calls.length, 1);
    assert.deepEqual(Object.keys(calls.calls[0]?.questions ?? {}).sort(), ['export', 'readme']);
    assert.equal(decideValidation(record).disposition, 'done');

    const quiet = gateway(() => {
      throw new Error('escape must not call');
    });
    const escaped = await judgeValidation([readme()], [], [], OPEN, { request_id: 'val-escape', terms: TERMS, gateway: quiet });
    assert.equal(quiet.calls.length, 0);
    assert.equal(decideValidation(escaped).disposition, 'escape');
    assert.equal(replayValidation(escaped).done, false);
  });

  it('fails closed on malformed output and on a floating model id', async () => {
    const malformed = gateway(() => ({
      status: 'unaccepted',
      reason: 'provider_failed',
      request_id: 'bad',
      site: 'task.validate',
      attempts: [],
      spent: 0,
      uncertainty: ['malformed'],
    }));
    const broken = await judgeValidation([readme()], body, [], OPEN, { request_id: 'bad', terms: TERMS, gateway: malformed });
    assert.equal(decideValidation(broken).disposition, 'malformed');
    assert.equal(replayValidation(broken).done, false);

    const floating = gateway((request) =>
      accepted(request.site, request.request_id, { readme: { probability: 0.99, confidence: 0.99 } }, 'jev-latest'),
    );
    const unpinned = await judgeValidation([readme()], body, [], OPEN, {
      request_id: 'float',
      terms: TERMS,
      gateway: floating,
    });
    assert.equal(decideValidation(unpinned).disposition, 'malformed');
    assert.equal(decideValidation(unpinned).reasons.includes('unpinned_model'), true);
    assert.equal(replayValidation(unpinned).done, false);
  });

  it('fails a declared send or delete, and a consequential command that was not asked', () => {
    const pass = { readme: { probability: 0.95, confidence: 0.95 } };
    const pushed = validationFromFixture(
      [readme()],
      body,
      [{ command_id: 'ship', argv: ['git', 'push', 'origin', 'main'], output: '', asked: true }],
      pass,
      DECLARED_BANS,
    );
    assert.equal(decideValidation(pushed).disposition, 'fail');
    assert.equal(decideValidation(pushed).hard_constraints[0]?.code, 'do_not_send');
    assert.equal(JSON.stringify(pushed.state).includes('do_not_send'), false);

    const deleted = validationFromFixture(
      [readme()],
      body,
      [{ command_id: 'wipe', argv: ['rm', '-rf', 'dist'], output: '', asked: true }],
      pass,
      DECLARED_BANS,
    );
    assert.equal(decideValidation(deleted).hard_constraints[0]?.code, 'do_not_delete');

    const unasked = validationFromFixture(
      [readme()],
      body,
      [{ command_id: 'save', argv: ['git', 'commit', '-m', 'docs'], output: '', asked: false }],
      pass,
      DECLARED_BANS,
    );
    assert.equal(decideValidation(unasked).hard_constraints[0]?.code, 'ask_before_effect');

    const asked = validationFromFixture(
      [readme()],
      body,
      [{ command_id: 'save', argv: ['git', 'commit', '-m', 'docs'], output: '', asked: true }],
      pass,
      DECLARED_BANS,
    );
    assert.equal(decideValidation(asked).disposition, 'done');
  });

  it('permits a push or a delete when this task authorizes that effect', () => {
    const pass = { readme: { probability: 0.95, confidence: 0.95 } };
    const push = [{ command_id: 'ship', argv: ['git', 'push', 'origin', 'main'], output: '', asked: false }];
    const publish = [{ command_id: 'release', argv: ['npm', 'publish'], output: '', asked: false }];
    const wipe = [{ command_id: 'wipe', argv: ['rm', '-rf', 'dist'], output: '', asked: false }];

    const requiredPush = validationFromFixture([readme()], body, push, pass, {
      constraints: ['do_not_send', 'do_not_delete', 'ask_before_effect'],
      authority: ['send'],
    });
    assert.deepEqual(decideValidation(requiredPush).hard_constraints, []);
    assert.equal(decideValidation(requiredPush).disposition, 'done');
    assert.equal(replayValidation(requiredPush).done, true);
    assert.equal(JSON.stringify(requiredPush.state).includes('do_not_send'), false);

    const requiredPublish = validationFromFixture([readme()], body, publish, pass, {
      constraints: ['do_not_send'],
      authority: ['send'],
    });
    assert.equal(decideValidation(requiredPublish).disposition, 'done');

    const requiredDelete = validationFromFixture([readme()], body, wipe, pass, {
      constraints: ['do_not_send', 'do_not_delete', 'ask_before_effect'],
      authority: ['delete'],
    });
    assert.deepEqual(decideValidation(requiredDelete).hard_constraints, []);
    assert.equal(decideValidation(requiredDelete).disposition, 'done');

    const undeclared = validationFromFixture([readme()], body, [...push, ...wipe], pass, OPEN);
    assert.equal(decideValidation(undeclared).disposition, 'done');
    assert.deepEqual(decideValidation(undeclared).hard_constraints, []);
  });

  it('reads the threshold from the record that was declared before the answers', () => {
    const fixture = { readme: { probability: 0.6, confidence: 0.95 } };
    const loose = validationFromFixture([readme()], body, [], fixture, OPEN, undefined, {
      ...DECLARED_TASK_POLICY,
      probability_threshold: 0.5,
    });
    const strict = validationFromFixture([readme()], body, [], fixture, OPEN);
    assert.equal(decideValidation(loose).disposition, 'done');
    assert.equal(decideValidation(strict).disposition, 'fail');
    assert.equal(strict.probability_threshold, 0.8);
    assert.equal(strict.confidence_floor, 0.9);
  });
});

describe('frozen set', () => {
  const tasks = loadFrozenSet(JSON.parse(readFileSync(new URL('../../../../benchmarks/task-acceptance/frozen-set.json', import.meta.url), 'utf8')));

  it('keeps a tune split and a smaller holdout, and scores them with the declared policy', () => {
    assert.ok(tasks.length >= 20 && tasks.length <= 30);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('offline eval must not use the network');
    };
    try {
      const report = scoreFrozenSet(tasks);
      assert.equal(report.live_comparison, 'not_run');
      assert.equal(report.holdout_used_for_tuning, false);
      assert.equal(report.probability_threshold, 0.8);
      assert.equal(report.confidence_floor, 0.9);
      assert.equal(report.model, 'jev-1.13.0');
      assert.equal(report.counts.tune > report.counts.holdout, true);
      assert.ok(report.disagreements.length >= 3);
      const criteriaRow = report.tasks.find((row) => row.id === 't12-criteria-reject');
      assert.equal(criteriaRow?.disagreement, 'criteria');
      assert.equal(criteriaRow?.disposition, 'fail');
      assert.equal(criteriaRow?.single_facts, false);
      assert.ok(report.disagreements.some((row) => row.disagreement === 'criteria' && row.split === 'holdout'));
      assert.ok(report.disagreements.some((row) => row.disagreement === 'agent'));
      assert.ok(report.disagreements.some((row) => row.disagreement === 'low_confidence_noul'));
      const holdout = report.tasks.filter((row) => row.split === 'holdout');
      assert.ok(holdout.length > 0);
      assert.ok(holdout.every((row) => report.probability_threshold === 0.8));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips a live comparison when the transcript or the Jev route is missing', () => {
    assert.deepEqual(planLiveComparison({ transcript_provided: false, jev_configured: true }), {
      status: 'skip',
      reason: 'agent transcript missing',
    });
    assert.deepEqual(planLiveComparison({ transcript_provided: true, jev_configured: false }), {
      status: 'skip',
      reason: 'jev route not configured',
    });
    assert.deepEqual(planLiveComparison({ transcript_provided: true, jev_configured: true }), { status: 'run' });
  });

  it('records a live disagreement from the gateway, not from the fixture', async () => {
    const selected = tasks.filter((task) => task.id === 't01-readme-heading' || task.id === 't05-reject-count');
    const calls = gateway((request) => {
      const probability = request.site === 'task.criteria' ? 0.95 : 0.1;
      const answers: Record<string, { probability: number; confidence: number | null }> = {};
      for (const id of Object.keys(request.questions)) answers[id] = { probability, confidence: 0.95 };
      return accepted(request.site, request.request_id, answers);
    });
    const report = await runLiveComparison({
      tasks: selected,
      transcript: { agent: 'external-coding-agent', tasks: [{ id: 't01-readme-heading', stop: 'done', write_up: 'UNIQUE_LIVE_WRITE_UP' }] },
      gateway: calls,
      terms: TERMS,
    });
    assert.equal(report.live_comparison, 'ran');
    assert.equal(report.status, 'recorded');
    assert.equal(report.model, 'jev-1.13.0');
    const heading = report.tasks.find((row) => row.id === 't01-readme-heading');
    const count = report.tasks.find((row) => row.id === 't05-reject-count');
    assert.equal(heading?.disagreement, 'agent');
    assert.equal(heading?.agent_comparison, 'recorded');
    assert.equal(heading?.disposition, 'fail');
    assert.equal(count?.agent_comparison, 'skip');
    assert.equal(count?.validation_agrees, true);
    assert.equal(JSON.stringify(calls.calls).includes('UNIQUE_LIVE_WRITE_UP'), false);
    assert.ok(calls.calls.length >= 1);
  });
});

describe('commands', () => {
  it('runs the offline eval with no network', () => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'benchmarks/task-acceptance/offline.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { live_comparison: string; disagreements: unknown[]; model: string };
    assert.equal(report.live_comparison, 'not_run');
    assert.equal(report.model, 'jev-1.13.0');
    assert.ok(report.disagreements.length > 0);
  });

  it('skips the live command when no transcript is configured', () => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'benchmarks/task-acceptance/live.ts'],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TYPESAFE_AI_API_KEY: '' } },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { status: string; live_comparison: string; reason: string };
    assert.equal(report.status, 'skip');
    assert.equal(report.live_comparison, 'skip');
    assert.equal(report.reason, 'agent transcript missing');
    assert.equal(result.stdout.includes('"passed": true'), false);
    assert.equal(result.stdout.includes('"status": "ran"'), false);
  });
});
