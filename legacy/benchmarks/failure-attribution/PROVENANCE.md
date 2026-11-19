# Failure-attribution development provenance

Refs #195. This corpus is a Tune split for offline harness characterization.
It is implementer-authored and has **no independent review**, under D-ENG-055
§5. Codex, the WV-195 slice-1b implementation agent, authored all 28 synthetic
scenarios, serialized receipts, normalized facts and labels. A deterministic
preparation script assembled the authored values locally; no hosted benchmark
inference was invoked. The reviewer is unassigned; each label records `reviewer:
null` and `disagreement: "unreviewed"`. No independent label accuracy,
classifier accuracy, precision or recall is established by agreement with
these labels. These cases must not be reused as later holdout evidence.

The source snapshot is repository commit
`3e6ce1a5fc66e0315b4fd9f67efedcd5b6e97489` (`origin/main` at task setup).
`source_revision` in descriptors is SHA-256 of that exact UTF-8 commit id;
`source_digest` is the stored-byte digest of the primary source file listed
below. Synthetic payload/revision digests identify authored fixture values;
they do not assert that a real host executed an invocation or check.

## Rights, disclosure and permissions

All scenario text, ids, values, observations and injection strings were
authored for this implementation. No existing benchmark corpus, result,
holdout, private evaluator diagnostic or external dataset was used or read.
Host contracts and interfaces below were inspected locally as source code.
The root package declares `private: true`; no repository license declaration
was found at the root or in its package metadata. Repository licensing is
therefore **unknown**, not inferred to be public or permissively licensed.
No grant from a third-party dataset is claimed.

Every descriptor permits only `offline-development`, declares content class
`non_sensitive`, and has an empty `destinations` list. The exact external
destination is **none: hosted dispatch is not authorized**. Before any later
hosted use, record per-source license evidence and the exact configured
endpoint, classify permitted content, and sanitize the untrusted payload or
obtain explicit authorization. Credentials alone grant no permission.

Sanitization is by construction: opaque ids replace people, resources, host
paths, provider ids and destinations. No environment, keys, grants, raw
customer/user content, real command tails or private text is retained.
Injection text in c28 is deliberately authored inert observation data. Missing
facts, cancellation and uncertain outcomes stay explicit; no current host
state was consulted to fill gaps and no effect was reexecuted.

## Serialized receipt owners

`gauge.raw-receipts@1` is a development serialization envelope, not a new host
schema. Its `records` contain complete `weft.record@1` records plus their
canonical `recordDigest(record)` values. Other arrays retain synthetic,
revision/attempt-bound source receipts in the public 1a fact shape. These are
authored examples based on the identified owner contracts, not captured
production receipts. Their separate stored-byte pins preserve a translation
oracle; slice 2 must define native host-owned serialized schemas and prove
translation parity. This slice neither imports nor invokes any host.

| Family present     | Producing package and exact source contract at the snapshot                                                                                                                                                               | Bindings and limitations                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records` → `weft` | Loom `packages/weave/src/weft.ts` (`LoomWeft`); gateway `packages/gateway/src/weft.ts` (`RequestWeft`); Fabric `packages/agentfabric/src/weft.ts` (`FabricWeft`); schema `packages/weft/src/types.ts`, `WEFT-CONTRACT.md` | Exact trace/record id, kind, content digest, parent, links and fields are frozen. A Weft record is a non-authoritative projection, not an execution grant or host replay state.                                                                                                                     |
| `checks`           | Loom `packages/weave/src/implement-step.ts` (`CheckEvidence`, `AttemptRecord`); Fabric `packages/agentfabric/src/store.ts` (`InvocationRecord`)                                                                           | Case, contract/implementation/check revisions, invocation and attempt are explicit. Synthetic checks include passed/exit/digest; no actual command output or held-out oracle is copied. Native check-receipt schemas and translation remain slice 2.                                                |
| `observations`     | Loom `packages/weave/src/types.ts` (`ObservationInput`, `Observation`), `packages/weave/src/journal.ts` (`ObservationJournal`)                                                                                            | Opaque ref, case, source revision, content digest and typed observation family. Earlier judgment observations are evidence, never the receipt for the current attribution decision. No journal is opened.                                                                                           |
| `search`           | Loom authorized catalogue/composition observation boundary (`packages/weave/src/types.ts`), normalized contract `packages/gauge/src/types.ts` (`SearchInventoryFact`)                                                     | Search, search/catalogue revisions, completeness, authorization, matches/compositions, revocations and missing grants. Source is an explicitly synthetic search observation; no host currently exports this whole normalized inventory. Host-owned serialized search schema is deferred to slice 2. |
| `route`            | gateway `packages/gateway/src/routing.ts` (`RoutingDecision`, `RouteExclusion`), `packages/gateway/src/weft.ts` (`RequestWeft.routed`)                                                                                    | Decision/policy/table/terms revisions, selected and alternative ids, eligibility/exclusion and comparative refs. Full inventories are synthetic receipts; a route projection alone cannot establish that a lawful exclusion was erroneous.                                                          |
| `schedule`         | Loom `packages/weave/src/types.ts` (action observations), `packages/weave/src/weft.ts` (`LoomWeft` cycle/transition emission)                                                                                             | Scheduler/policy revisions, disposition, terminal state, dependency statuses, budget and supersession. Full normalized inventory is an authored serialized observation, not native scheduler state or a chronology inference.                                                                       |

Actual participating source owners for slice 2 are therefore Loom, gateway
and Fabric, with Weft supplying the public projection contract. AgentSOP
grant issuance is neither represented nor called. There is no snapshot
artifact in 1b. Slice 2's snapshot must preserve every raw `record_id` and
canonical digest used by frozen facts; otherwise affected facts and byte pins
require a reviewed re-freeze. Raw record/fact identity checks do not establish
native-host translation correctness.

## Source byte inventory

All digests below hash raw source bytes at the snapshot above. The first
source in each family is its primary descriptor `source_digest` reference.

| Source                                 | Stored-byte SHA-256                                                       |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `packages/gauge/src/types.ts`          | `sha256:c38a68358756d5dea1e489ec120186f995a1ad2f57ef923390e786b82105e145` |
| `packages/gauge/src/GAUGE-CONTRACT.md` | `sha256:713da66e242d4966d3ca2339246f01f59a601431f29932c72c0802e3bf4a9be1` |
| `packages/weft/src/types.ts`           | `sha256:0a9b57873f98765d8c8716b0dd1bc1dddbcee6aa3d599185b26868120d4f4195` |
| `packages/weft/src/WEFT-CONTRACT.md`   | `sha256:8465e34ff2dfc5948219b7f7125e4eb5d147da3acd07537c2913df2305883002` |
| `packages/weave/src/implement-step.ts` | `sha256:6368ed7699dcb0b2ffdea8a7c1b4a15f3e4121d22b933f29bc5b65865935232c` |
| `packages/weave/src/types.ts`          | `sha256:474c1792a5d12ddd139661acf3c49af1151b333be44ed2f516e97127eb4a9248` |
| `packages/weave/src/journal.ts`        | `sha256:b8c1d6057936e0f28c54b19921154540da3ac087575fb8e23149bc56a6622d2e` |
| `packages/weave/src/weft.ts`           | `sha256:878308ad1d4c25fe51329e378ae0c8dbf51e6c7b2c00598d298f9c68ae8beef6` |
| `packages/gateway/src/routing.ts`      | `sha256:d6c4520b18f9f6d4ee45a492706b2288748339d4f3f66b6a6bb92a75b0f5a60b` |
| `packages/gateway/src/weft.ts`         | `sha256:3e332a450667f5e9b4a886aa53f23e7f939ebdb0b79252e10b9db8b9f9517158` |
| `packages/agentfabric/src/store.ts`    | `sha256:35990822849f467b03af4a28605af9cabc84de5ee999cc83f18a0f5cc0551ead` |
| `packages/agentfabric/src/weft.ts`     | `sha256:77743fd6bd701a625bdc211cd624c30e7f6fce6b124c3dd916b9dc2980607e20` |

## Development lineage and scenario inventory

Each row has one scenario family `sfNN` and one source lineage `slNN`, matching
the opaque case number. Every variation or causal reordering derived from a
row inherits both ids for future split comparison; a fresh case id or digest
does not create an independent lineage. The 28 rows are separately authored
scenarios, not records counted as extra scenarios. The first 20 comprise four
scenarios for each of five categories; c21–c28 are additional ambiguous or
adversarial characterization cases. Category expectations live only in the
separate tune oracle, never the classifier-facing projection.

| Case | Scenario and observed failure criterion                                                                                     | Primary source                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| c01  | A format conversion cannot be completed after a complete authorized catalogue and composition search finds no match.        | `packages/weave/src/types.ts`          |
| c02  | A required comparison cannot be produced despite a complete search including candidate compositions.                        | `packages/weave/src/types.ts`          |
| c03  | An aggregation goal remains unmet after the authorized catalogue's only possible implementation was revoked.                | `packages/weave/src/types.ts`          |
| c04  | A transformation remains unmet at a newer catalogue revision whose complete permitted search is empty.                      | `packages/weave/src/types.ts`          |
| c05  | A bound implementation fails its versioned contract check with nonzero exit.                                                | `packages/weave/src/implement-step.ts` |
| c06  | A bound implementation violates the check's declared effect constraint.                                                     | `packages/weave/src/implement-step.ts` |
| c07  | A Fabric invocation settles failed while the required output is absent.                                                     | `packages/agentfabric/src/weft.ts`     |
| c08  | A second distinct implementation's regression check fails under matching invocation/revisions.                              | `packages/weave/src/implement-step.ts` |
| c09  | An eligible alternative with a recorded successful comparative check was excluded while the selected route failed.          | `packages/gateway/src/routing.ts`      |
| c10  | A route selected the wrong admitted contract for the bound input, so the required output was absent.                        | `packages/gateway/src/routing.ts`      |
| c11  | A recorded table choice excluded a permitted comparable unit and the selected unit missed the criterion.                    | `packages/gateway/src/routing.ts`      |
| c12  | A contract-selection mismatch is established at a separate route-table revision.                                            | `packages/gateway/src/routing.ts`      |
| c13  | A required dependency failed and the dependent output could not be produced.                                                | `packages/weave/src/weft.ts`           |
| c14  | A recorded scheduling conflict prevented the required action from running.                                                  | `packages/weave/src/weft.ts`           |
| c15  | The recorded cost budget was exhausted before the required action completed.                                                | `packages/weave/src/weft.ts`           |
| c16  | A superseding action replaced the required work and its criterion remained unmet.                                           | `packages/weave/src/weft.ts`           |
| c17  | A failed criterion has no surviving receipt span identifying its cause.                                                     | `packages/weave/src/types.ts`          |
| c18  | An incomplete catalogue search leaves an unmet operation unexplained.                                                       | `packages/weave/src/types.ts`          |
| c19  | An invocation is uncertain and the failed criterion does not establish implementation failure.                              | `packages/agentfabric/src/weft.ts`     |
| c20  | A selected route failed without comparable alternatives or a contract mismatch receipt.                                     | `packages/gateway/src/weft.ts`         |
| c21  | Matching implementation failure and dependency failure are both plausible causes; the criterion does not disambiguate them. | `packages/weave/src/weft.ts`           |
| c22  | Route-parent and check spans are absent; an unmet output cannot be localized.                                               | `packages/gateway/src/weft.ts`         |
| c23  | Independent failure records arrive in reversed sequence with no causal links; order cannot choose between plausible causes. | `packages/weave/src/weft.ts`           |
| c24  | A better-performing route was lawfully prohibited by destination policy, and the criterion remains unmet.                   | `packages/gateway/src/routing.ts`      |
| c25  | A prior recorded semantic review supports one implementation cause, but no closed deterministic signal exists.              | `packages/weave/src/types.ts`          |
| c26  | Cancellation leaves an invocation outcome unknown; unmet output is not proof of an implementation defect.                   | `packages/agentfabric/src/weft.ts`     |
| c27  | Only a previous attempt's failing check survives; it cannot explain the current attempt's failed criterion.                 | `packages/weave/src/implement-step.ts` |
| c28  | Authored injection text attempts to redirect assessment despite a matching current implementation check failure.            | `packages/weave/src/implement-step.ts` |

The independent label author, evaluator and D-ENG-040 custodian remain
unassigned. Their external custody location is unselected. No holdout is
frozen, no sealed label or snapshot is in the manifest, and production sealed
evaluation refuses. Independent held-out quality evidence remains necessary
before #195 can close.
