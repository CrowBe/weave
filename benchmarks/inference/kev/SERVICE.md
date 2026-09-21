# Operating Kev as Weave's local fallback

Kev's installation is machine state, not repository state. Keep its source,
virtual environment, Hugging Face cache, model weights and run output outside
the checkout. The benchmark instructions use:

```bash
export WEAVE_KEV_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/weave/kev"
```

The repository owns only three things:

1. the pinned setup and benchmark instructions in this directory;
2. the recorded evidence in [`results.json`](results.json); and
3. the `kev-local` gateway adapter and runtime lifecycle module.

## Register the external service

Kev's server has no authentication, so bind it to loopback only. The checked-in
[`weave-kev.service`](weave-kev.service) targets the default XDG data path. If
`WEAVE_KEV_HOME` points elsewhere, copy and adjust the unit before installing
it.

Register it without enabling it at login:

```bash
install -D -m 0644 benchmarks/inference/kev/weave-kev.service \
  "$HOME/.config/systemd/user/weave-kev.service"
systemctl --user daemon-reload
systemctl --user start weave-kev.service
curl --fail http://127.0.0.1:8000/api/info
systemctl --user stop weave-kev.service
```

The service remains stopped after this check. `createSystemdKevRuntime` first
probes `/api/info`; if the verified service is absent, it runs
`systemctl --user start weave-kev.service`, waits for the model to load, and
coalesces concurrent callers into one warmup. It refuses a running process
whose reported run path, base model or LoRA rank differs from the configured
identity.

The endpoint reports the base model name but not its revision. The pinned
download procedure and the local model directory therefore remain part of the
operator evidence; the readiness probe cannot independently recover that hash.

## Compose hosted and local routes

The gateway already owns bounded fallback. Put hosted Jev first and Kev last;
set `max_attempts_per_route: 1` when a timeout or exhausted credit should reach
Kev immediately rather than retrying the hosted route.

```ts
import { createInferenceGateway } from '@weave/gateway';
import {
  createSystemdKevRuntime,
  KEV_LOCAL_ADAPTER,
  KEV_LOCAL_DESTINATION,
  kevLocalEvaluator,
} from '@weave/gateway/kev-local';

const clock = { now: () => Date.now() };
const timer = {
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const handle = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(handle);
        reject(signal.reason);
      }, { once: true });
    }),
};

const runtime = createSystemdKevRuntime({
  clock,
  timer,
  expected: {
    run: '/home/USER/.local/share/weave/kev/models/kev-4b',
    base: 'Qwen/Qwen3-4B-Base',
    lora: 16,
  },
});

const local = kevLocalEvaluator({ runtime });

const kevRoute = {
  routed_unit_id: 'decision.boolean@kev-4b-local',
  operation: 'evaluate' as const,
  kind: 'boolean' as const,
  context_profile: 'profile.bounded-private-decision',
  context_profile_version: 1,
  prompt_template: 'template.decision.boolean',
  prompt_template_version: 1,
  adapter: KEV_LOCAL_ADAPTER,
  model: 'kev-latest',
  settings: { max_output_tokens: 256 },
  destination: KEV_LOCAL_DESTINATION,
  quality: 'baseline' as const,
  context_limit_tokens: 384,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
};

const gateway = createInferenceGateway({
  routes: [hostedJevRoute, kevRoute],
  evaluators: [hostedJevEvaluator, local],
  clock,
});
```

For an ordinary request, permit both destinations and Kev is the fallback:

```ts
destinations: ['typesafe-ai', KEV_LOCAL_DESTINATION]
```

For privacy-required inference, permit only local data. The hosted route is
removed deterministically before execution, so Kev is preferred and failure is
closed if it cannot answer:

```ts
destinations: [KEV_LOCAL_DESTINATION]
```

Keep `quality: 'baseline'` and `max_context_tokens <= 384`. The current
measurements do not admit Kev for `high` quality or longer state views. A cold
start plus CPU inference can exceed 15 seconds, so the caller's deadline must
budget for local warmup; an already-expired deadline cannot be rescued.
