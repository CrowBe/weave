// Deliberately bounded scripts for the contract probes. No interpreter, real
// grants, durable store, MAC, jail, OS limits or scheduler is implemented here.
// `broken` injects one known defect per research scenario. Healthy scripts are
// positive controls for the probes, not candidate providers for admission.
const pending = {
  kind: 'suspended',
  call_id: 'call:1',
  capability: 'doc.write',
  input: { ref: 'ref:one', content: 'draft' },
  position: { start: 0, end: 12 },
};
const value = { kind: 'value', value: { revision: 2 } };

// A scripted seam: source is recorded, never evaluated. OS isolation and
// resource use are injected observations, not facts about this Node process.
export class ExecutionProviderDouble {
  calls = [];
  worker = false;
  state = 'fresh';
  cursor = 0;

  constructor(boundaries = [pending, { kind: 'completed', output: 'done' }], os_isolation = 'enforced') {
    this.boundaries = structuredClone(boundaries);
    this.os_isolation = os_isolation;
  }

  async isolationReport() {
    this.calls.push({ method: 'isolationReport' });
    return { provider_revision: 'fixture@1', os_isolation: this.os_isolation, evidence: 'synthetic-only' };
  }

  async start(program, offered, limits) {
    if (this.state !== 'fresh') return { kind: 'failed', code: 'INVALID_STATE' };
    this.calls.push({
      method: 'start',
      program: structuredClone(program),
      offered: structuredClone(offered),
      limits: structuredClone(limits),
    });
    this.worker = true;
    return this.boundary();
  }

  boundary() {
    const result = structuredClone(this.boundaries[this.cursor]);
    this.state = result.kind;
    return result;
  }

  async resume(call_id, outcome) {
    if (this.state !== 'suspended' || call_id !== this.boundaries[this.cursor].call_id) {
      return { kind: 'failed', code: 'INVALID_STATE' };
    }
    this.calls.push({ method: 'resume', call_id, outcome: structuredClone(outcome) });
    this.cursor++;
    return this.boundary();
  }

  async dump() {
    if (this.state !== 'suspended') throw new Error('INVALID_STATE');
    this.calls.push({ method: 'dump' });
    return new TextEncoder().encode(JSON.stringify({ boundaries: this.boundaries, cursor: this.cursor }));
  }

  async restore(bytes) {
    if (this.state !== 'fresh') return { kind: 'failed', code: 'INVALID_STATE' };
    this.calls.push({ method: 'restore' });
    const saved = JSON.parse(new TextDecoder().decode(bytes));
    this.boundaries = saved.boundaries;
    this.cursor = saved.cursor;
    this.worker = true;
    return this.boundary();
  }

  async close() {
    if (this.state === 'closed') return;
    this.calls.push({ method: 'close' });
    this.worker = false;
    this.state = 'closed';
  }
}

const factories = {
  'X-T01': (broken) => ({
    invocations: [],
    exceptions: [],
    gaps: [],
    async call(capability, input) {
      if (broken) this.invocations.push({ capability, input });
      this.exceptions.push('UNKNOWN_CAPABILITY');
      this.gaps.push({ signature: `${capability}:ref:string:program-r1`, position: pending.position });
    },
  }),
  'X-T02': (broken) => ({
    hostGrant: { operation: 'doc.read' },
    effects: 0,
    invocations: [],
    resumptions: [],
    async call(capability, input) {
      const grant = broken ? (input.grant ?? this.hostGrant) : this.hostGrant;
      this.invocations.push({ grant, capability, input });
      const allowed = grant.operation === capability;
      if (allowed && capability === 'doc.write') this.effects++;
      this.resumptions.push(allowed ? { kind: 'value', value: 'document' } : { kind: 'exception', code: 'DENIED' });
    },
  }),
  'X-T03': (broken) => {
    let decided = false;
    const provider = new ExecutionProviderDouble();
    return {
      get workers() {
        return Number(provider.worker);
      },
      invocations: 0,
      resumptions: [],
      fresh: () => factories['X-T03'](broken),
      async pause() {
        await provider.start({ source: 'fixture' }, ['doc.write'], { deadline: 10 });
        await provider.dump();
        if (!broken) await provider.close();
      },
      async decide(decision) {
        if (decided) return;
        decided = true;
        if (decision === 'approve') this.invocations++;
        this.resumptions.push(decision === 'approve' ? value : { kind: 'exception', code: 'DENIED' });
      },
    };
  },
  'X-T04': (broken) => {
    // Exact-byte comparison against private fixture custody stands in for MAC
    // verification. It supplies no cryptographic or durable custody evidence.
    const bytes = new Uint8Array([1, 2, 3]);
    const bindings = {
      run: 'run:1',
      action: 'action:1',
      call: 'call:1',
      program: 'program:r1',
      offered: 'offered:r1',
      authority: 'authority:1',
      provider: 'provider:r1',
      configuration: 'configuration:r1',
      approval: 'approval:1',
      input: 'input:r1',
      budget: 'budget:remaining',
      clock: 'clock:1',
      seed: 'seed:1',
      generation: '1',
    };
    let claimed = false;
    return {
      pending: structuredClone(pending),
      providerRestores: 0,
      async dump() {
        return { bytes: bytes.slice(), bindings: { ...bindings }, tag: 'fixture-only' };
      },
      async restore(saved) {
        const intact =
          saved.tag === 'fixture-only' &&
          saved.bytes.length === bytes.length &&
          saved.bytes.every((b, i) => b === bytes[i]) &&
          JSON.stringify(saved.bindings) === JSON.stringify(bindings);
        if (claimed || (!broken && !intact)) return 'refused';
        claimed = true;
        this.providerRestores++;
        return structuredClone(pending);
      },
    };
  },
  'X-T05': (broken) => {
    let outcome;
    return {
      invocationId: 'invocation:run-1:call-1',
      events: [],
      effects: 0,
      lookups: [],
      resumptions: [],
      held: false,
      status: 'running',
      provider: {
        async dump() {
          return new Uint8Array([1]);
        },
        async restore() {
          return structuredClone(pending);
        },
      },
      fresh: () => factories['X-T05'](broken),
      loseOutcome() {
        outcome = undefined;
      },
      async dispatchThenCrash() {
        this.events.push('identity_recorded');
        this.held = true;
        this.events.push('invoke');
        this.effects++;
        outcome = structuredClone(value);
        // A crash loses the acknowledgement before provider.resume.
      },
      async recover(bytes) {
        await this.provider.restore(bytes); // Re-announces the same call.
        if (broken) {
          this.effects++;
          this.events.push('invoke');
        } else this.lookups.push(this.invocationId);
        if (outcome) {
          this.resumptions.push(outcome);
          this.held = false;
          this.status = 'completed';
        } else this.status = 'uncertain';
      },
    };
  },
  'X-T06': (broken) => {
    const provider = new ExecutionProviderDouble([{ kind: 'failed', code: 'LIMIT_EXCEEDED' }]);
    return {
      deadline: 10,
      elapsed: 0,
      feeds: 0,
      closed: false,
      fresh: () => factories['X-T06'](broken),
      async start(limit) {
        this.feeds++;
        this.elapsed = this.deadline; // Injected ticks, no actual runaway code.
        const result = await provider.start({ source: 'fixture', limit }, [], { deadline: this.deadline });
        if (!broken) await provider.close();
        this.closed = !broken;
        return result;
      },
      async resume() {
        if (this.closed) return { kind: 'failed', code: 'INVALID_STATE' };
        this.feeds++;
        return { kind: 'completed', output: 1 };
      },
    };
  },
  'X-T07': (broken, isolation) => {
    const provider = new ExecutionProviderDouble([pending], isolation ?? 'unprobed');
    const f = {
      providerCalls: 0,
      tier: 'untrusted',
      fresh: (report) => factories['X-T07'](broken, report),
      async start() {
        const report = await provider.isolationReport();
        if (!broken && report.os_isolation !== 'enforced') return { kind: 'failed', code: 'ISOLATION_UNAVAILABLE' };
        this.providerCalls++;
        return provider.start({ source: 'fixture' }, ['doc.write'], { deadline: 10 });
      },
      async restore() {
        return this.start();
      },
    };
    return f;
  },
  'X-T08': (broken) => ({
    providerCalls: 0,
    invocations: 0,
    lookups: 0,
    record: { clock: 123, seed: 456, observations: [pending, value] },
    async replay(record) {
      if (!record) return 'missing_evidence';
      if (broken) this.providerCalls++;
      return structuredClone(record);
    },
  }),
  'X-T09': (broken, state) => ({
    resumes: 0,
    kills: 0,
    closed: false,
    held: true,
    status: state,
    fresh: (initial) => factories['X-T09'](broken, initial),
    async cancel() {
      this.closed = true;
      if (state === 'suspended') {
        this.record('cancelled');
        return;
      }
      this.kills++;
      this.status = 'pending_record';
      if (broken) this.held = false;
    },
    record(outcome) {
      this.status = outcome;
      this.held = outcome === 'uncertain';
    },
  }),
  'X-T10': (broken) => {
    const active = new Map();
    let latest = [];
    return {
      workers: 0,
      progress: [],
      release(id) {
        active.get(id)();
      },
      open(id, offered) {
        const pool = this;
        latest = [...offered];
        return {
          grant: { owner: id },
          checkoutDeadline: 10,
          offered: () => [...(broken ? latest : offered)],
          start() {
            if (pool.workers >= 2) return Promise.resolve({ kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
            pool.workers++;
            return new Promise((resolve) =>
              active.set(id, () => {
                pool.progress.push(id);
                resolve({ kind: 'suspended', ...structuredClone(pending) });
              }),
            );
          },
          async close() {
            if (active.delete(id)) pool.workers--;
          },
        };
      },
    };
  },
};

export function makeDouble(id, broken = false) {
  if (!Object.hasOwn(factories, id)) throw new Error(`unknown contract scenario: ${id}`);
  return factories[id](broken);
}
