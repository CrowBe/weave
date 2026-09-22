# M6 — Route a reconstructed view

This is the behavioral contract for the milestone in
[ARCHITECTURE.md §10](../ARCHITECTURE.md). It extends
[M5](m5-improve-an-operating-strategy.md). Terms follow
[CONTEXT.md](../CONTEXT.md). The checks below are requirements, not claims of
implemented behavior. Demonstrate red before implementation and retain the
M0–M5 checks when proving green.

M5 compares two framing profiles and records a fixture cache-miss delta when
the stable prefix bytes change. M6 prices a prefix cache at routing time, splits
catalogue disclosure into two slices, narrows destinations from the read set,
and shares one slice assembly across read-only consumers. It does not replace
M5's promotion protocol, and it does not rewrite M0–M5.

## 1. Outcome and scope

Repeat the normalized report. Framing renders a reconstructed view, and routing
selects one routed unit for that view. A warm prefix on the expensive unit keeps
the long view there. A short view with no matching prefix may select the cheaper
unit when that unit clears the quality bar. A read that includes a restricted
resource never reaches a destination policy forbids for that resource. A
read-only review of the same revision cites the same slice assembly. The review
cannot promote a profile or issue an execution grant.

M6 proves:

- Expected cost uses a prefix-cache hit or one reload. With no prefix cache,
  expected cost stays the cold window M2 already prices.
- The reservation before the call stays the cold ceiling. A hit does not charge
  cached tokens again. A missing usage report stays an upper bound at that
  ceiling and does not take the discount.
- The cheaper unit is selected only when it clears the quality bar and its
  reload-inclusive cost is lower. The decision layer does not select the unit.
- The framing view discloses a catalogue index and, separately, the schemas the
  profile names. A later view omits those schemas unless its own profile
  selects them. Dropping an operation the composition needs misses the quality
  bar.
- Policy narrows destinations from the action's declared read set before the
  request is formed. The gateway still filters the destinations it is given. It
  does not receive the read set. A weight cannot put a destination back or
  take a permitted one away.
- Two read-only views of one revision cite one slice assembly, and that
  assembly's cost is counted once. A write to a resource in that read set
  still conflicts. The review observation does not promote and does not grant.
- The log is not compacted to make a view smaller. A review is an action on
  this goal's frontier. It is not a child goal.

No live provider bill, session compaction, subagent type, or model-owned REPL
is required. Fixture prices, digests, and assemblies are enough for the gating
suite. H1 remains independent hardening and is not a prerequisite.

## 2. Fixture routes and prefix cache

Two generate routes, both kind `transform`, both quality `high`, both with
evidence `attempts: 20`, `accepted: 20`. Context limits sit at or above the
view under test. Output cap equals the output tokens below, so the comparison
is exact.

| Routed unit | Destination | Input micros / mtok | Output micros / mtok |
| --- | --- | --- | --- |
| `route.strong` | `local` | 5_000_000 | 25_000_000 |
| `route.cheap` | `hosted.cheap` | 3_000_000 | 15_000_000 |

```text
PrefixCache {
  routed_unit_id:  "route.strong"
  prefix_digest:   digest of the long view's stable prefix
  cached_tokens:   650_000
}
```

The caller passes the cache and the view digest into routing. The gateway does
not read Weave state to discover either. For the rows below,
`terms.max_context_tokens` equals the view's input token count and each route's
`max_output_tokens` equals the output token count, so the cold ceiling is the
same quantity `worstCaseCost` already computes.

Token accounting for one attempt, in integer micros:

```text
uncached     = input_tokens - cached_tokens
               when the unit and the digest match and cached_tokens <= input_tokens
             = input_tokens otherwise
input_cost   = uncached / 1_000_000 * input_per_mtok
output_cost  = output_tokens / 1_000_000 * output_per_mtok
attempt_cost = input_cost + output_cost
```

A cache whose `cached_tokens` exceed `input_tokens` is ignored and the attempt
is costed cold. The uncertainty is recorded. Expected cost is `attempt_cost`
times `attempts / accepted`.

| View | Input tokens | Output tokens | `route.strong` | `route.cheap` |
| --- | --- | --- | --- | --- |
| Long, digest matches | 770_000 | 120_000 | 3_600_000 warm | 4_110_000 cold |
| Long, strong cold | 770_000 | 120_000 | 6_850_000 | 4_110_000 |
| Short, no match | 1_100 | 100 | 8_000 | 4_800 |

The long warm total is the uncached 120_000 input tokens plus output. The
650_000 cached tokens are not added again. Cold `route.strong` on the long
view is the reservation ceiling for that view: 6_850_000. A sequence that
runs `route.cheap` and then reloads `route.strong` cold costs 10_960_000 and
is not the selected order.

The short view's digest does not match the cache, so both units are cold and
`route.cheap` is first. A third route with quality `baseline` and a still
lower price is excluded with `quality_below_bar` when the request requires
`high`.

Settlement: when the provider reports usage and the digest matches, spent is
`attempt_cost`. When usage is absent, spent is the cold ceiling and
`cost_is_upper_bound` is set. The discount is not invented from a missing
report.

## 3. Two catalogue slices

`profile.frame.index@1` is the framing profile for this milestone. It is data
the renderer already accepts. Selecting it is not a patch to the scheduler,
policy, admission, or the procedure union.

```text
FrameProfile {
  id:          "profile.frame.index@1"
  version:    1
  index:      catalogue operations, each { id, purpose }
  schema_for: ["source.inspect", "text.normalize"]
}
```

The view content carries `catalogue_index` and `catalogue_schema` as separate
slices. The index is id plus one purpose line. The schema slice carries input
shapes only for `schema_for`. Other shapes are omitted with reason `profile`.
An operation the composition needs, missing from the index, misses the quality
bar, as does an empty content payload.

`profile.frontier-weigh@1` does not select `catalogue.schema`. After a frame
that loaded schemas, the weigh view's content has no input shapes. A later
frame whose profile sets `schema_for` empty also omits them. The loaded schema
is not an observation the next view inherits.

M5's `profile.frame.narrow@1` and its `prefix_stable` check are unchanged.
This profile is not that candidate.

## 4. Destinations follow the read set

```text
DestinationPolicy {
  resource:      "source:beta"
  destinations:  ["local"]
}
```

The goal permits `local` and `hosted.cheap`. Before `inference.requested` is
appended, policy intersects that list with every resource in the action's
read set. An action that reads `source:beta` is requested with destinations
`["local"]` only. An action whose read set is `source:alpha` keeps both.

`route.cheap` would win the short view on cost. It is still absent from the
beta request, and the selected unit is `route.strong`. A weight that says beta
is unlikely does not restore `hosted.cheap`. A weight that says alpha is
sensitive does not remove `hosted.cheap` from the alpha request.

The gateway's exclusion reason for a destination outside the terms it received
remains `destination_not_permitted`. Narrowing happens in the runtime, before
that call.

## 5. One slice assembly for read-only consumers

`report.review` is a read-only action on the same goal. Its judgment site is
its own, with its own routed unit and acceptance record. It shares the frame
view's `goal` and `registered` slices at the same state revision and cites the
same assembly id for those slices. The schema slice, selected only by the
frame profile, has its own assembly.

```text
SliceAssembly {
  assembly_id
  state_revision
  slices:       ["goal", "registered"]
  cost_micros:  1_000
}
```

The cycle's `cost_micros` includes 1_000 once. The review view does not add
another 1_000. A write to a source in the review's read set waits, under the
same effect lock as M1. The review observation is retained. It does not change
the active profile, the goal's success evidence, or any execution grant, even
when its payload names a profile or a grant.

## 6. Required deterministic checks

Retain every M0–M5 check. Use fixture routes, injected ticks, and the prefix
record above. Do not call a live model.

| ID | Scenario | Required evidence |
| --- | --- | --- |
| M6-T01 | Long view, digest matches `route.strong` | First selected unit is `route.strong`. Its expected cost is 3_600_000, below its cold ceiling of 6_850_000. Spent with reported usage does not include the 650_000 cached tokens again. The cheap-then-reload sequence at 10_960_000 is not the selected order. |
| M6-T02 | Short view, digest does not match | First selected unit is `route.cheap` at 4_800. `route.strong` stays eligible behind it. A `baseline` unit cheaper than both is excluded with `quality_below_bar`. |
| M6-T03 | No prefix cache record | Expected cost is the cold window. Order matches M2's rule for the same table, evidence, and terms. |
| M6-T04 | Usage report absent on a warm hit | Reservation was the cold ceiling. Spent is that ceiling with `cost_is_upper_bound`. The hit discount is not applied. |
| M6-T05 | Frame with `profile.frame.index@1`, then weigh, then a frame with empty `schema_for` | The first frame has the index, including `source.inspect` and `text.normalize`, and schemas only for `schema_for`. The weigh view and the later frame omit those schemas. An index that drops either operation, or an empty content payload, misses the quality bar. |
| M6-T06 | Short view, read set includes `source:beta` | `inference.requested` destinations are `["local"]` only. The selected unit is `route.strong`. A weight calling beta unlikely does not add `hosted.cheap`. An alpha-only read set still permits `hosted.cheap`. |
| M6-T07 | `report.review` overlaps framing at one revision | Both views cite one assembly id for `goal` and `registered`. Cycle cost includes 1_000 once. A source write in that read set waits. The review payload does not change the active profile or issue a grant. No child goal is created. |
| M6-T08 | Replay of the routed run | Observations match. Replay uses the recorded route, view, and assembly. The host and gateway are not invoked. The log contains the original observations; it was not replaced by a summary. |

Record demonstrated red and green against the exact contract revisions.

## 7. Assumptions recorded

- Prices and token counts are fixture constants. M6 does not read a provider's
  prompt-cache bill. M5's cache-miss delta stays the constant M5-T08 records.
- The gateway learns the prefix digest and the cache record from the request.
  It does not import Weave.
- Catalogue purpose lines are fixture fields on the view's catalogue input.
  They do not revise a capability contract.
- H1 may land before or after this milestone. M6 does not depend on it and
  does not compact the log in its place.
