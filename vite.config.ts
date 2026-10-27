import { defineConfig } from 'vite-plus';

// Lint and formatting are required CI gates. `verify-cached` runs the same
// `npm run verify` command with a cache.
export default defineConfig({
  lint: {
    ignorePatterns: ['dist/', 'node_modules/', 'benchmarks/**/*.py'],
  },
  fmt: {
    singleQuote: true,
    printWidth: 120,
    // Preserve fixture and golden bytes, including line-delimited trace records.
    ignorePatterns: [
      'dist/',
      'node_modules/',
      'benchmarks/**/*.py',
      '**/fixtures/**/*.json',
      '**/fixtures/**/*.jsonl',
      // Check fixtures pin source layouts (e.g. a multiline import) that formatting would erase.
      'checks/fixtures/**',
      // Frozen corpus digest and generated report bytes are asserted by the harness.
      'benchmarks/frontier-weigh/cases.json',
      // These exact bytes are referenced by checked-in benchmark recordings.
      'benchmarks/decision-sites/sets/**/*.jsonl',
      'benchmarks/inference/gliner-decide/capability-match-cases.json',
      'benchmarks/inference/gliner-decide/jev-curation-source.json',
      'benchmarks/inference/gliner-decide/weave-v2-results.json',
      'benchmarks/inference/jev/transfer-results.json',
      'benchmarks/inference/openjev/cases.json',
      'benchmarks/inference/space-bunny/general-cases.json',
      'benchmarks/inference/space-bunny/sol-compare/cases.json',
      'benchmarks/inference/space-bunny/sol-compare/hard-cases.json',
      // Retain the exact hosted probe response bytes for audit.
      'docs/research/prompt-decomposition-probe/*.response.json',
      'docs/research/prompt-decomposition-field-probe/response.json',
      'benchmarks/frontier-weigh/REPORT.md',
      // Generated decision-sites reports are re-rendered and compared byte-for-byte.
      'benchmarks/decision-sites/REPORT.md',
      'benchmarks/decision-sites/results/**',
      // Wrapping this call separates @ts-expect-error from its expected diagnostic.
      'packages/weave/test/p5.test.ts',
    ],
  },
  run: {
    tasks: {
      // Same command as `npm run verify`. Cached only through this task; start it with
      // `npm run verify:cached`, which sets WEAVE_TOOLCHAIN.
      'verify-cached': {
        command: 'npm run verify',
        cache: {
          // Tasks run in a clean environment. These change what verify runs or skips, so they are
          // passed through and fingerprinted. Credentials are deliberately absent: no verify test
          // reads one, and a fingerprinted value would be stored in the cache.
          env: ['WEAVE_TOOLCHAIN', 'PATH', 'WEAVE_KEV_*', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'],
          // Explicit globs, not `{ auto: true }`. Automatic tracking observes the run by injecting
          // LD_PRELOAD into every child process, which the shell.run@1 env-isolation test rightly
          // rejects, and its directory listings made a deleted __pycache__ a cache miss.
          input: [
            // Root dotfiles such as `.npmrc` can change dependency resolution and verify behavior.
            '.*',
            '*.json',
            '*.ts',
            '.github/**',
            'checks/**',
            'scripts/**',
            'packages/**',
            'benchmarks/**',
            'examples/**',
            '!**/node_modules/**',
            '!**/dist/**',
            '!**/*.tsbuildinfo',
            // Exclude the directory itself as well as its contents.
            '!**/__pycache__',
            '!**/__pycache__/**',
            '!**/*.pyc',
          ],
          output: ['packages/*/dist/**'],
        },
      },
    },
  },
});
