#!/usr/bin/env node
/** Reproducible, project-local CPU model setup. No global installation or service changes. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.local/inference');
const release = 'b12359';
const archive = `llama-${release}-bin-ubuntu-x64.tar.gz`;
const runtimeHash = '0bc1f091e8916102b6d8f2cf944233a620e90a0f856c72d0ce41150c65c2e72e';
const binary = join(directory, `llama-${release}`, `llama-${release}`, 'llama-server');
const models = [
  {
    id: 'lfm3-1.7b',
    repo: 'LFM3-1.7B-GGUF',
    revision: 'cd0c74c575b5c416f3011b5b4c298077f26ca8c2',
    file: 'LFM3-1.7B-Q4_K_M.gguf',
    sha256: '3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4',
    port: 8081,
    role: 'text',
  },
  {
    id: 'd1-2b',
    repo: 'd1-2B-GGUF',
    revision: '4a181094d1b6addfaa3a0956f78e7ab2aa406a0c',
    file: 'd1-2B-Q8_0.gguf',
    sha256: '073313d92b53b0ac8193db6e906cb3c78a98183d244b15b7b8f5426115c6738c',
    port: 8082,
    role: 'decision',
  },
];
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(url, file, expected) {
  if (existsSync(file) && (await sha256(file)) === expected) return;
  console.log(`Downloading ${url}`);
  const temporary = file + '.part';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Download returned HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }));
    if ((await sha256(temporary)) !== expected) throw new Error(`SHA-256 mismatch: ${file}`);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function setup() {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('This pinned setup targets Linux x64 CPUs.');
  mkdirSync(directory, { recursive: true });
  await download(
    `https://github.com/ggml-org/llama.cpp/releases/download/${release}/${archive}`,
    join(directory, archive),
    runtimeHash,
  );
  mkdirSync(join(directory, `llama-${release}`), { recursive: true });
  execFileSync('tar', ['-xzf', join(directory, archive), '-C', join(directory, `llama-${release}`)]);
  for (const model of models)
    await download(
      `https://huggingface.co/LiquidAI/${model.repo}/resolve/${model.revision}/${model.file}`,
      join(directory, model.file),
      model.sha256,
    );
  writeFileSync(
    join(directory, 'models.json'),
    JSON.stringify({ runtime: { release, sha256: runtimeHash }, models }, null, 2) + '\n',
  );
  console.log('Verified local runtime and models. Run npm run loom:models.');
}
async function health(model) {
  try {
    const response = await fetch(`http://127.0.0.1:${model.port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const json = await response.json();
    return json.data?.some((entry) => entry.id === model.id) === true;
  } catch {
    return false;
  }
}
async function start() {
  if (!existsSync(binary) || models.some((model) => !existsSync(join(directory, model.file))))
    throw new Error('Run npm run loom:models:setup first.');
  const children = [];
  let closing = false;
  const stop = () => {
    closing = true;
    for (const child of children) child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (const model of models) {
      if (await health(model)) {
        console.log(`${model.id} already serving on ${model.port}`);
        continue;
      }
      const args = [
        '--model',
        join(directory, model.file),
        '--alias',
        model.id,
        '--host',
        '127.0.0.1',
        '--port',
        String(model.port),
        '--ctx-size',
        '4096',
        '--parallel',
        '1',
        '--threads',
        '4',
        '--threads-batch',
        '6',
        '--n-gpu-layers',
        '0',
      ];
      if (model.role === 'decision') args.push('--batch-size', '4096', '--ubatch-size', '4096');
      else
        args.push(
          '--temp',
          '0.1',
          '--top-k',
          '50',
          '--repeat-penalty',
          '1.1',
          '--reasoning',
          'off',
          '--reasoning-budget',
          '0',
        );
      const child = spawn(binary, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      const log = createWriteStream(join(directory, `${model.role}.log`), { flags: 'a', mode: 0o600 });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.once('exit', (code, signal) => {
        log.end();
        if (!closing) {
          console.error(`${model.id} exited (${code ?? signal}); see .local/inference/${model.role}.log`);
          process.exitCode = 1;
          stop();
        }
      });
      child.once('error', (error) => {
        console.error(error.message);
        process.exitCode = 1;
        stop();
      });
      children.push(child);
      console.log(`Starting ${model.id} at http://127.0.0.1:${model.port}`);
    }
    console.log('Model processes started by this command stop with Ctrl-C.');
  } catch (error) {
    stop();
    throw error;
  }
}
try {
  const command = process.argv[2] ?? 'status';
  if (command === 'setup') await setup();
  else if (command === 'start') await start();
  else if (command === 'status')
    for (const model of models)
      console.log(`${model.id}: ${(await health(model)) ? 'ready' : 'not serving'} (${model.port})`);
  else throw new Error('Usage: node scripts/loom-models.mjs setup|start|status');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
