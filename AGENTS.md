# Agent instructions

## Read first

1. Read `VISION.md` before making architectural or product decisions.
2. Read `CONTEXT.md` and use its terms exactly.
3. Inspect the current code and tests before proposing a change.

## Work

- Keep Weave's runtime independent of any model, provider, or tool protocol.
- Treat model output as an observation, never as implicit authority.
- Keep policy deterministic and separate from probabilistic decisions.
- Preserve explicit state transitions and evidence for consequential decisions.
- Parallelize independent work; express dependencies instead of serializing by default.
- Keep AgentFabric as a bounded subsystem that ships with Weave.
- Do not let AgentFabric import Weave runtime or scheduling concerns.
- Prefer composition of existing capabilities before creating a new primitive.
- Begin crystallization with a contract, not an implementation.
- Demonstrate red before generating or accepting implementation code.
- Validate green with deterministic tests and checks.
- Treat generated tests and generated code as untrusted until validated.
- Keep capability generation, admission, and authority to execute as separate gates.
- Keep the core small; domain-specific behavior belongs in capabilities.

## Change discipline

- Make the smallest coherent change that advances the requested outcome.
- Do not add speculative abstractions, compatibility layers, or dependencies.
- Add or update tests with behavioral changes.
- Update `CONTEXT.md` when introducing or changing a domain term.
- Update `VISION.md` only when an acceptance boundary changes.
- Record assumptions when the repository cannot verify them.
- Do not weaken permissions, validation, or held-out checks to make a test pass.

## Verify

- Run the narrowest relevant checks while iterating, then the full available suite.
- Check failure paths, effects, permissions, cancellation, and concurrency where relevant.
- Report what changed, what was verified, and any remaining uncertainty.
