import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Exact-byte inputs and artifacts referenced by checked-in benchmark evidence.
// External datasets, model weights, and hashes of derived values are not repository files.
const recorded = [
  [
    'benchmarks/decision-sites/sets/audit.dispose/holdout.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    '6e89e6a6ad8ddf1b186201c223d7052be8431fa0c51667368700229da488eaee',
  ],
  [
    'benchmarks/decision-sites/sets/audit.dispose/tune.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    '1417d65d286e67ac61604a1cde7e08fef909ff156ef415340e82cd44e2f0cfd1',
  ],
  [
    'benchmarks/decision-sites/sets/eval.output/holdout.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    '0e056e5e1dcc9a33d182745f31fdd9ac34062597e884d451fab113c144ab79ae',
  ],
  [
    'benchmarks/decision-sites/sets/eval.output/tune.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    'a57b0cab71b6842a7bb3d18a66e2063862c33c9f079b3ba5c5c3e5819455e8be',
  ],
  [
    'benchmarks/decision-sites/sets/guard.input/holdout.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    '761746df88e81d223ff02c685444bc0e8a20af3fb5ad67c9704591eaff024bad',
  ],
  [
    'benchmarks/decision-sites/sets/guard.input/tune.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    'ad6e29bab77729092871b4f513e05712cbc42fd6adac4bce7ef5bac4c6eb4310',
  ],
  [
    'benchmarks/decision-sites/sets/guard.output/holdout.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    'e504fe8843592e72f24acd75789966efec7f0114856507fa7488d9599d7ab3c3',
  ],
  [
    'benchmarks/decision-sites/sets/guard.output/tune.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    'f7b45cdb0f396482c2d392ab7a9f91f7fbad0e23bd56afb217c07d79f5db28c7',
  ],
  [
    'benchmarks/decision-sites/sets/intake.classify/holdout.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    '8f8b2b33e686014844349ad6bb386dd11439ed625025fda496cdaf5619f8b9f1',
  ],
  [
    'benchmarks/decision-sites/sets/intake.classify/tune.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    '7929c08f9299bdfe5275993ff9411d1d1a06d0a543c6685dc6e819b30e4812b2',
  ],
  [
    'benchmarks/decision-sites/sets/loop.continue/holdout.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    '4b0beacc8d326dc0153c2ddb8eb02571ddd22f5b8d36831b0e9120ef831c43e0',
  ],
  [
    'benchmarks/decision-sites/sets/loop.continue/tune.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    'a3008a876b810ea0dd7a5ffcfeac9f7e0a42464f27b7d6886bcf4a1166ee872d',
  ],
  [
    'benchmarks/decision-sites/sets/loop.preselect/holdout.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    'aa037729b22e087f0fc37ac4cd97100ae666d96bd44ed4fb0f7673510630ae96',
  ],
  [
    'benchmarks/decision-sites/sets/loop.preselect/tune.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    '3df43e160c310e8b649741f6d22b01e020a03c44a5c0d3a0ccf73507d257e384',
  ],
  [
    'benchmarks/decision-sites/sets/loop.route/holdout.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    '0a6e5a5e689e746c32cb9addcddd36a8e2237ca03764bd70169a7bf4f0df1eb2',
  ],
  [
    'benchmarks/decision-sites/sets/loop.route/tune.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    '0edaec11527d0e88530295cad8ac289c45c7ed45b48acaf124db142c55c4c2e6',
  ],
  [
    'benchmarks/decision-sites/sets/loop.triage/holdout.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    'afe4e7f248efd9f2cfbf7b6a3c9f683776963351f54b3bbc29e71ad3e23337e5',
  ],
  [
    'benchmarks/decision-sites/sets/loop.triage/tune.jsonl',
    'benchmarks/decision-sites/results/live-20261015/summary.json',
    'c5a5696c2be58eb489f743efac581bbd0f0ea747e5bd706cfabcbff4613b5750',
  ],
  [
    'benchmarks/frontier-weigh/cases.json',
    'benchmarks/frontier-weigh/results.json',
    '19b5efd87bbfb8bfa4f19796141b58e00d629cc73dbb23b55743e4d97ff2ebc1',
  ],
  [
    'benchmarks/inference/gliner-decide/capability-match-cases.json',
    'benchmarks/inference/gliner-decide/capability-match-development-normal.json',
    '97628dd14e682f544e4d2645efb7091a6dea0587e79049d27cf67a10df260fb3',
  ],
  [
    'benchmarks/inference/gliner-decide/jev-curation-source.json',
    'benchmarks/inference/gliner-decide/jev-curated/audit.json',
    '51d3a9752523038e72b3473b74be39994c12a08ac8506dc8e3909c947ab2ca15',
  ],
  [
    'benchmarks/inference/gliner-decide/weave-v2-results.json',
    'benchmarks/inference/lumma-fev/results.json',
    'a3449f0dc518a43654aaf6b1dd330f9907074e6d54e3c621bdba943140ab657f',
  ],
  [
    'benchmarks/inference/jev/transfer-results.json',
    'benchmarks/inference/lumma-fev/results.json',
    '8ca56636872504ca14e4beebb9bb8988ccc77962376189c6b1e8f8b87d5c3745',
  ],
  [
    'benchmarks/inference/openjev/cases.json',
    'benchmarks/inference/openjev/cpu-results.json',
    '77b6555cbc6a20aab40c4d1685577ea6bdc60cd8c2d52a8ecad4f55213a0c7af',
  ],
  [
    'benchmarks/inference/space-bunny/general-cases.json',
    'benchmarks/inference/space-bunny/general-results.json',
    'eb082f6641acd00d4d7f7fca97133fd1c7553bf6bb1b8f89e7af1f0799191a24',
  ],
  [
    'benchmarks/inference/space-bunny/sol-compare/cases.json',
    'benchmarks/inference/space-bunny/sol-compare/results.json',
    'd2a9f10c3793d423caaab080317844a961c8dfd8654e164896e1044a6e74115b',
  ],
  [
    'benchmarks/inference/space-bunny/sol-compare/hard-cases.json',
    'benchmarks/inference/space-bunny/sol-compare/hard-results.json',
    '6f75e04edef241153dcf0f21facc506f610121b7e0f5e2d6bce2b2f38f774854',
  ],
];

for (const [path, recording, expected] of recorded) {
  test(`recorded benchmark digest: ${path}`, () => {
    const evidence = readFileSync(new URL(`../${recording}`, import.meta.url), 'utf8');
    assert.ok(evidence.includes(expected), `${recording} must retain the recorded digest`);
    const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `${path} differs from ${recording}`);
  });
}
