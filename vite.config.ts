import { defineConfig } from 'vite-plus';

// Lint and format are report-only. `verify-cached` runs the same `npm run verify` command with a cache.
export default defineConfig({
  lint: {
    ignorePatterns: ['dist/', 'node_modules/', 'benchmarks/**/*.py'],
  },
  fmt: {
    ignorePatterns: ['dist/', 'node_modules/', 'benchmarks/**/*.py'],
  },
  run: {
    tasks: {
      // Same command as `npm run verify`. Cached only through this task.
      'verify-cached': {
        command: 'npm run verify',
        cache: {
          input: [
            { auto: true },
            '!**/dist/**',
            '!**/*.tsbuildinfo',
            '!**/__pycache__/**',
            '!**/*.pyc',
          ],
          output: ['**/dist/**'],
        },
      },
    },
  },
});
