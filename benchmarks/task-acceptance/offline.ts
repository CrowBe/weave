/**
 * Score the frozen acceptance-fact set from recorded fixtures.
 *
 * No gateway, no fetch, no Jev. A disagreement with a hand label is printed
 * and is a completed eval. Drift between the computed attribution and the
 * attribution stored on the task fails the process.
 */
import { readFileSync } from 'node:fs';
import { loadFrozenSet, scoreFrozenSet } from '@weave/weave';

const raw: unknown = JSON.parse(readFileSync(new URL('./frozen-set.json', import.meta.url), 'utf8'));
const report = scoreFrozenSet(loadFrozenSet(raw));
console.log(JSON.stringify(report, null, 2));
