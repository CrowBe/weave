# Package split: agentsop and agentfabric

This document applies **if** the existing AgentFabric code is adopted as Weave's
capability host. [ARCHITECTURE.md §12](../ARCHITECTURE.md) holds that decision
and its recommendation; what follows is the symbol-level move map for the path
where the answer is yes.

On that path AgentFabric folds into this repository as `packages/agentfabric`,
and the contract it honours separates out as `packages/agentsop`. The fold-in and
the split are one piece of work.

If the answer is no, the move map still describes the boundary a fresh contract
package must draw — the split test below is about the contract, not about this
particular implementation.

AgentFabric today ships one distribution, with the Experimental 0.1 contract
text and a demo catalogue sitting beside it in `agentsop/`. That arrangement
stops working at the point where Weave authors contracts and generates resolvers
at runtime: the contract package is what Weave validates proposals against, and
it cannot carry a filesystem or a demo library.

This is a design record, not an executed migration.

## The split test

For every symbol, one question:

> Would an independent runtime, written by someone else, need this to
> interoperate with capabilities authored here?

Yes → `agentsop`. No → `agentfabric`.

The 0.1 text already answers most cases, because it distinguishes what the
contract states from what "a fabric" decides. Failure-code precedence is
contract. Who may register a resolver is fabric. Effect vocabulary is contract.
The locator table is fabric.

## Layout

```
packages/
  agentsop/
    src/agentsop/          contract types, validation, resolver shape
    spec/EXPERIMENTAL-0.1.md
    spec/capability.schema.json
  agentfabric/
    src/agentfabric/       runtime, bindings, builtin resolvers
    examples/capabilities/ demo catalogue (blob.*, text.*, journal.*)
  weave/
    src/weave/             the loop
```

`agentfabric` depends on `agentsop`. Weave depends on `agentsop` for types and
on `agentfabric` only through the capability host port. Three packages, one
checkout, one version while all three are experimental.

Sharing a repository is not permission to share code sideways. An import-direction
check in CI is what makes the package boundary mean something; without it a
monorepo becomes one program with subdirectories.

The demo catalogue moves. `agentsop/EXPERIMENTAL-0.1.md` already says those
documents "are a **demo library for this Fabric**, not AgentSOP primitives";
shipping them inside the contract package would contradict the contract.

## Move map

| Today | Goes to | Note |
| --- | --- | --- |
| `types.Capability`, `ResourceRef`, `Effect`, `Result`, `ErrorBody` | `agentsop.types` | the wire and document shapes |
| `types.Grant` and its `matches` | `agentsop.authority` | wildcard matching decides `DENIED`, so it is contract |
| `types.Principal.id` | `agentsop.types` | identity shape only |
| `types.Principal.privileges`, `Privilege` | `agentfabric.trust` | 0.1: "AgentSOP does not say who is allowed to register a resolver" |
| `types.ResourceRecord` | `agentfabric.resources` | holds a locator; never leaves the fabric |
| `schema.validate_capability_document` | `agentsop.schema` | document validation, authority selector rules, effect-set equality |
| `schema.validate_against`, `collect_resource_refs`, `extract_resource_refs` | `agentsop.schema` | input validation and authority extraction are contract semantics |
| `catalogue.validate_dependency_graph` | `agentsop.catalogue` | existence and acyclicity are contract rules |
| `catalogue.load_capability_dir`, `merge_catalogue`, `overlay_dir`, `digest_capability`, `find_agentsop_root` | `agentfabric.catalogue` | file layout, overlays, and origin are fabric facts |
| `errors` failure codes | `agentsop.errors` | the code enum and precedence are contract; messages are not |
| `errors.InvalidCatalogue` | `agentsop.errors` | named by 0.1 as the fabric's load diagnostic; keep the code, keep the reporting in fabric |
| `resolvers.ResolverContext`, `ResolverFn` | `agentsop.resolver` | narrowed — see below |
| `resolvers.load_python_resolver`, `ResolverBinding` | `agentfabric.resolvers` | Python, files, and `exec` are one runtime's choice |
| `types.REF_PATTERN`, `CAPABILITY_ID_PATTERN` | `agentsop.types` | well-formedness is public |
| `ids.new_*` | `agentfabric.ids` | issuance is fabric |
| `fabric`, `resources`, `grants.Authority`, `audit`, `store`, `sync`, `notice`, `hook`, `scaffold`, `setup`, `inspect`, `demo`, `cli`, `bindings`, builtin `resolvers/*` | `agentfabric` | unchanged |

`find_agentsop_root` disappears in its current form. The schema and spec resolve
from `agentsop` package data; the catalogue directory becomes a fabric
configuration value instead of something discovered by walking parents.

## The resolver context must narrow first

`ResolverContext` currently exposes `locator(ref) -> Path` and
`workspace -> Path`. That blocks the split and blocks Weave, for the same reason:

- A contract that names `pathlib.Path` is not substrate-neutral, so the resolver
  shape cannot move into `agentsop` as written.
- A resolver that holds a real path runs with the ambient authority of the host
  process, so it must be trusted local code. Weave generates resolvers.
  Generated code cannot hold that authority.

Narrow the context to operations expressed only in contract vocabulary:

```python
class ResolverContext(Protocol):
    principal: str
    def invoke(self, capability_id: str, input: dict) -> dict: ...   # depends_on only
    def read(self, ref: ResourceRef) -> bytes: ...
    def write(self, ref: ResourceRef, data: bytes) -> None: ...
    def create(self, *, kind: str, label: str) -> ResourceRef: ...
    def discover(self, *, kind: str | None = None) -> list[ResourceRef]: ...
```

Every effect then reaches the environment through the fabric, because there is
no other route. The payoff is that the context becomes serialisable: a resolver
can run in a subprocess with no network and no filesystem while the fabric
answers its context calls over a pipe. Sandboxing becomes a deployment choice
rather than a subsystem.

Built-in resolvers can keep an in-process trusted tier, but they are written
against the narrow shape. Existing resolvers that call `ctx.locator` are the
migration work; `blob.*` and `journal.*` are all short.

## What Weave additionally needs

These belong in `packages/agentfabric`, not in the Weave loop. Sharing a
repository makes it tempting to answer them in the loop instead; that is the
failure mode the boundary exists to prevent.

1. **Untrusted execution tier.** Subprocess, no network, no filesystem, CPU,
   memory, and wall-clock limits, context calls over a pipe. Prerequisite for
   admitting any generated resolver.
2. **Proposed and admitted as distinct states.** `crystallise` today binds code
   in one step. Split into `propose(contract)`, `attach(implementation)`,
   `admit(evidence)`, `revoke(reason)`, with maturity that can regress. A
   capability document with no implementation is already a legal state in 0.1
   (`UNRESOLVED`); proposal extends that rather than inventing it.
3. **Several implementations per contract.** One resolver binding per capability
   is a runtime limit, not a contract one. The contract is the identity;
   routing between implementations is empirical.
4. **Evidence attached to admission.** Corpus revision, observed red, green run,
   sandbox report, approver, provenance, observed reliability and cost.
5. **Machine-readable opportunities.** `notice.py` already records recurring
   fallback and shell work. Weave consumes that log as capability-gap evidence
   instead of reimplementing detection; keep the record shape stable.

## Test corpus: deliberately left in agentfabric

The *shape* of a test case — typed input, expected output or expected failure
code — is expressible purely in contract vocabulary, which argues for
`agentsop`. The runner, the held-out split, and the mutation policy are clearly
fabric.

Recommendation: keep both in `agentfabric` until a second runtime needs to read
a corpus authored here, then promote only the case shape. Promoting early would
freeze a corpus format before anything has generated one.

## What does not change

- The `agentsop` version field on capability documents, and 0.1 semantics.
- AgentFabric's independence in everything but repository address: its own CLI,
  MCP binding, `.fabric/` state, and tests, usable by a harness that has never
  heard of Weave.
- The `.fabric/` layout, overlay behaviour, and `agentfabric sync`.
- CLI and MCP surfaces, including the rejection of unexpected fields.
- Failure codes and their precedence.

## Sequence

1. Narrow `ResolverContext`; migrate built-in resolvers. Done in the AgentFabric
   repository against its current suite, before the move, because it is the one
   change everything else waits on.
2. Fold the AgentFabric repository into `packages/agentfabric/` with history.
   That repository stops taking changes at the merge commit.
3. Extract `agentsop` per the move map. Mechanical once step 1 has landed.
4. Move the demo catalogue to `packages/agentfabric/examples/capabilities/`;
   resolve schema and spec from package data rather than walking parents for an
   `agentsop/` directory.
5. Add the import-direction check to CI.
6. Add the untrusted execution tier behind the narrowed context.
7. Add propose / attach / admit / revoke with evidence and maturity.

Steps 1–5 are refactors with no new behaviour. Steps 6–7 are what Weave blocks
on, and neither is reachable before step 1.
