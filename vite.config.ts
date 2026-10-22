import { defineConfig } from 'vite-plus';

// `lint:report` and `fmt:report` run in CI as soft failures. `verify-cached` runs the same
// `npm run verify` command with a cache.
export default defineConfig({
  lint: {
    ignorePatterns: ['dist/', 'node_modules/', 'benchmarks/**/*.py'],
  },
  fmt: {
    singleQuote: true,
    printWidth: 120,
    ignorePatterns: ['dist/', 'node_modules/', 'benchmarks/**/*.py'],
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
            '*.json',
            '*.ts',
            'checks/**',
            'scripts/**',
            'packages/**',
            'benchmarks/**',
            'examples/**',
            '!**/node_modules/**',
            '!**/dist/**',
            '!**/*.tsbuildinfo',
            '!**/__pycache__/**',
            '!**/*.pyc',
          ],
          output: ['packages/*/dist/**'],
        },
      },
    },
  },
});
