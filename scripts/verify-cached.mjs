#!/usr/bin/env node
/**
 * Run `vp run verify-cached` with the toolchain in the cache key.
 *
 * Vite Task fingerprints the files a task reads and the variables listed in
 * `cache.env`, but not the node or python3 binaries it finds on PATH. A
 * swapped interpreter would otherwise replay a pass it never earned. The
 * versions and resolved paths travel in WEAVE_TOOLCHAIN, which
 * vite.config.ts fingerprints.
 */
import { execFileSync, spawnSync } from 'node:child_process';

function probe(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'missing';
  }
}

const toolchain = [
  `node ${process.version} ${process.execPath}`,
  `npm ${probe('npm', ['--version'])}`,
  `python3 ${probe('python3', ['-c', 'import sys; print(sys.version.split()[0], sys.executable)'])}`,
].join('; ');

const result = spawnSync('vp', ['run', 'verify-cached', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, WEAVE_TOOLCHAIN: toolchain },
});
process.exit(result.status ?? 1);
