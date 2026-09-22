# Operating Kev as Weave's local fallback

Kev's installation is machine state, not repository state. Keep its source,
virtual environment, Hugging Face cache, model weights and run output outside
the checkout. The benchmark instructions use:

```bash
export WEAVE_KEV_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/weave/kev"
```

The repository owns only four things:

1. the pinned setup and benchmark instructions in this directory;
2. the recorded evidence in [`results.json`](results.json);
3. the `kev-local` gateway adapter and runtime lifecycle module; and
4. [`llamacpp_serve.py`](llamacpp_serve.py), a second implementation of the same
   wire contract over a quantised backbone, and the comparison of the two in
   [`llamacpp-results.json`](llamacpp-results.json).

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

## The llama.cpp backbone

There are two services, not two models. Both load the same checkpoint and serve
the same System One contract; they differ only in what runs the backbone.

| | PyTorch (`weave-kev`) | llama.cpp (`weave-kev-llamacpp`) |
| --- | --- | --- |
| port | 8000 | 8001 |
| backbone | fp32, CPU | Q8\_0, Vulkan |
| median request | 11,482 ms | 2,640 ms |
| correct (56 records) | 47/56 | 47/56 |
| agrees with PyTorch | — | 56/56 |
| order-stable cases | 15/18, 14 correct | 15/18, 14 correct |

Measured over the 18 judgment-site cases at every presentation ordering; the
records, the floors they are quoted against and the reference run are in
[`llamacpp-results.json`](llamacpp-results.json).

**Q8\_0 is the default because it is decision-identical**, not because it is more
accurate. Q4\_K\_M scores the same 47/56 at 2,511 ms and 1.7 GB less, but reaches
it by a different route: it disagrees with PyTorch on four records, two in each
direction. Either is defensible; identity is what lets this service be swapped
in without re-running the corpus, so it is what the unit ships with. Neither
figure licenses skipping a re-measurement on a different corpus.

**Vulkan is not tuning here.** A runtime LoRA makes llama.cpp abandon its
`CPU_REPACK` GEMM kernels on every adapted projection, which costs the entire
advantage — 28 tok/s on CPU against 82 offloaded, where PyTorch already does 26.
Run this service on a GPU or do not run it.

**Each question costs its own pass.** llama.cpp cannot express Kev's
block-causal branch mask, so a request with N questions becomes N forward passes
that each re-read the state. This is exact rather than approximate: a branch row
holds precisely the tokens its question may attend to, at the same positions
(upstream states the same equivalence in `kev.model.rows_of`, and packed and
`/v1/systemone/separate` were measured agreeing on 18/18 records here before the
port). It costs about 1.7x the tokens, and `usage.input_tokens` reports what was
actually processed — so that figure is larger than the PyTorch service's for the
same request, and the two are not comparable.

### Install

The units expect the quantised backbone, the converted adapter and a Vulkan
llama.cpp build under `WEAVE_KEV_HOME`:

```
$WEAVE_KEV_HOME/models/gguf/Qwen3-4B-Base.Q8_0.gguf
$WEAVE_KEV_HOME/models/gguf/kev-lora-f16.gguf
$WEAVE_KEV_HOME/llamacpp/bin/            # llama-server and its shared objects
$WEAVE_KEV_HOME/llamacpp/llamacpp_serve.py
```

`llamacpp_serve.py` is installed from this directory, so **re-run the install
after changing it** — the tests import the repository copy, and a stale
installed copy will not fail them:

```bash
install -D -m 0644 benchmarks/inference/kev/llamacpp_serve.py \
  "$WEAVE_KEV_HOME/llamacpp/llamacpp_serve.py"
install -D -m 0644 benchmarks/inference/kev/weave-kev-backbone.service \
  "$HOME/.config/systemd/user/weave-kev-backbone.service"
install -D -m 0644 benchmarks/inference/kev/weave-kev-llamacpp.service \
  "$HOME/.config/systemd/user/weave-kev-llamacpp.service"
systemctl --user daemon-reload
systemctl --user start weave-kev-llamacpp.service   # pulls the backbone up
curl --fail http://127.0.0.1:8001/api/info
systemctl --user stop weave-kev-llamacpp.service weave-kev-backbone.service
```

`/api/info` answers with the same `run`, `base` and `lora` the readiness probe
compares — it is the same checkpoint — and adds `backend`, `weights` and
`packed` so a caller can tell which service replied. Running both at once needs
about 20 GB of RAM.

### Point Weave at it

`WEAVE_KEV_BASE_URL` selects the service. Unset means the PyTorch one:

```bash
WEAVE_KEV_BASE_URL=http://127.0.0.1:8001 npm run jev:probe -- --model kev
```

The probe prints what answered it, read from `/api/info`, so a recorded run is
not ambiguous about which backbone produced it:

```
service: http://127.0.0.1:8001 — llama.cpp Qwen3-4B-Base.Q8_0.gguf, lora 16
```

### Tests

`npm run test:decision` covers the decomposition, the readout offsets, the
checkpoint identity and the HTTP surface with the backbone stubbed out. Two
further tests compare the two services on the wire and skip unless both are up:

```bash
WEAVE_KEV_BASE_URL=http://127.0.0.1:8000 \
WEAVE_KEV_LLAMACPP_BASE_URL=http://127.0.0.1:8001 \
  npm run test:decision
```

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
