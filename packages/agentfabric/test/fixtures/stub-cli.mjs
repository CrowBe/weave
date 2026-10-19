/**
 * Stub CLI for shell.run and generate-adapter tests.
 * It never prints environment values except in --leak, which the host must redact.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { argv, env, exit, pid, stderr, stdin, stdout } from 'node:process';

const args = argv.slice(2);
const mode = args[0];

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    stdin.on('data', (chunk) => chunks.push(chunk));
    stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

if (mode === '--subprocess') {
  // --subprocess <pidFile> [--escape] [--exit=N]: start a grandchild that inherits stdout and stderr.
  // --escape puts it in its own session and process group. --exit=N exits once the grandchild is up.
  const pidFile = args[1];
  const exitArg = args.find((arg) => arg.startsWith('--exit='));
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--sleep', pidFile], {
    stdio: ['ignore', 'inherit', 'inherit'], shell: false, detached: args.includes('--escape'),
  });
  child.on('error', () => exit(3));
  if (exitArg === undefined) {
    setInterval(() => {}, 1 << 30);
  } else {
    const poll = setInterval(() => {
      if (existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '') {
        clearInterval(poll);
        stdout.write('parent-done\n');
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
} else if (mode === '--exit') {
  stderr.write('stub-failed\n');
  exit(Number(args[1] ?? '1'));
} else if (mode === '--flood') {
  const count = Number(args[1] ?? '20000');
  const chunk = 'y'.repeat(1000);
  for (let i = 0; i < Math.ceil(count / 1000); i += 1) {
    stdout.write(chunk);
  }
  stderr.write('z'.repeat(count));
  exit(0);
} else if (mode === '--touch') {
  writeFileSync(args[1] ?? 'artifact.txt', 'artifact');
  stdout.write('touched\n');
  exit(0);
} else if (mode === '--leak') {
  stdout.write(env['CANARY'] ?? '');
  exit(0);
} else if (mode === '--report') {
  const text = await readStdin();
  stdout.write(
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
  stderr.write('unknown mode\n');
  exit(2);
}
