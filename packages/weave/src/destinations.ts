/**
 * Destination narrowing (docs/m6-route-a-reconstructed-view.md §4).
 *
 * Policy intersects the goal's permitted destinations with every resource in
 * the action's read set. A weight is not an input: it cannot restore a
 * destination or remove one policy still permits.
 */

export interface DestinationPolicy {
  readonly resource: string;
  readonly destinations: readonly string[];
}

export function narrowDestinations(
  permitted: readonly string[],
  policies: readonly DestinationPolicy[],
  readSet: readonly string[],
): string[] {
  let allowed = [...permitted];
  for (const resource of readSet) {
    const policy = policies.find((item) => item.resource === resource);
    if (!policy) {
      continue;
    }
    const permittedForResource = new Set(policy.destinations);
    allowed = allowed.filter((destination) => permittedForResource.has(destination));
  }
  return allowed;
}
