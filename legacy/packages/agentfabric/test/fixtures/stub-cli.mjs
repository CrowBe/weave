/**
 * Stub CLI for shell.run and generate-adapter tests.
 * It never prints environment values except in --leak and --partial, which the host must redact.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { argv, env, exit, pid, stdin } from 'node:process';

const args = argv.slice(2);
const mode = args[0];

// Use synchronous descriptor I/O so process.exit cannot discard fixture data.
if (mode === '--subprocess') {
  // --subprocess <pidFile> [--escape] [--exit=N]: start a grandchild that inherits stdout and stderr.
  // --escape puts it in its own session and process group. --exit=N exits once the grandchild is up.
  const pidFile = args[1];
  const exitArg = args.find((arg) => arg.startsWith('--exit='));
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--sleep', pidFile], {
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
    detached: args.includes('--escape'),
  });
  child.on('error', () => exit(3));
  if (exitArg === undefined) {
    setInterval(() => {}, 1 << 30);
  } else {
    const poll = setInterval(() => {
      if (existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '') {
        clearInterval(poll);
        writeSync(1, 'parent-done\n');
        exit(Number(exitArg.slice('--exit='.length)));
      }
    }, 10);
  }
} else if (mode === '--sleep') {
  const pidFile = args[1];
  if (typeof pidFile === 'string' && pidFile.length > 0) {
    writeFileSync(pidFile, String(pid));
  }
  setInterval(() => {}, 1 << 30);
} else if (mode === '--partial') {
  // Output first (pipe writes are synchronous), then the pid file, then wait to be stopped.
  writeSync(1, `partial-out:${env['CANARY'] ?? ''}\n`);
  writeSync(2, 'partial-err\n');
  writeFileSync(args[1], String(pid));
  setInterval(() => {}, 1 << 30);
} else if (mode === '--signal') {
  writeSync(2, 'stub-signalled\n');
  process.kill(pid, 'SIGKILL');
} else if (mode === '--exit') {
  writeSync(2, 'stub-failed\n');
  exit(Number(args[1] ?? '1'));
} else if (mode === '--flood') {
  const count = Number(args[1] ?? '20000');
  const chunk = 'y'.repeat(1000);
  for (let i = 0; i < Math.ceil(count / 1000); i += 1) {
    writeSync(1, chunk);
  }
  writeSync(2, 'z'.repeat(count));
  exit(0);
} else if (mode === '--touch') {
  writeFileSync(args[1] ?? 'artifact.txt', 'artifact');
  writeSync(1, 'touched\n');
  exit(0);
} else if (mode === '--leak') {
  writeSync(1, env['CANARY'] ?? '');
  exit(0);
} else if (mode === '--report') {
  // The spawned child's fd 0 is a non-blocking pipe (libuv spawn stdio). A synchronous
  // read fails with EAGAIN if the host's end-of-file has not arrived yet, so wait for it.
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  writeSync(
    1,
    JSON.stringify({
      argv,
      stdin: text,
      canary_present: typeof env['CANARY'] === 'string' && env['CANARY'].length > 0,
      canary_len: typeof env['CANARY'] === 'string' ? env['CANARY'].length : 0,
      env_names: Object.keys(env).sort(),
    }),
  );
  exit(0);
} else {
  writeSync(2, 'unknown mode\n');
  exit(2);
}
