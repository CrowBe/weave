#!/usr/bin/env node
// Verification scaffolding for the verify-tapestry skill. Not product code.
//
// Launches the Tapestry web workspace (Vite dev server) and a headless Chrome
// on free loopback ports, drives the page over the Chrome DevTools Protocol
// with real input events, records evidence, and tears down only what it
// started. No npm dependencies: Node >= 22 (global WebSocket and fetch).
//
//   tapestry-verify.mjs launch                      -> prints RUN id, URL, paths
//   tapestry-verify.mjs doctor   --run <id>
//   tapestry-verify.mjs browser  --run <id> <action> [options]
//   tapestry-verify.mjs cleanup  --run <id>
//   tapestry-verify.mjs runs
//
// --run may be replaced by the TAPESTRY_VERIFY_RUN environment variable.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRATCH_ROOT = join(tmpdir(), 'tapestry-verify');
const EVIDENCE_ROOT = join(REPO, '.local', 'verify-tapestry');
const APP_TITLE = 'Weave Tapestry';
const CHROME_CANDIDATES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];

function fail(message, code = 1) {
  process.stderr.write(`tapestry-verify: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(arg);
  }
  return { positional, flags };
}

function paths(run) {
  if (!/^[A-Za-z0-9._-]+$/.test(run)) fail(`invalid run id ${JSON.stringify(run)}`);
  const scratch = join(SCRATCH_ROOT, run);
  const evidence = join(EVIDENCE_ROOT, run);
  return { scratch, evidence, state: join(scratch, 'state.json'), actions: join(evidence, 'actions.jsonl') };
}

function runId(flags) {
  const run = flags.run ?? process.env.TAPESTRY_VERIFY_RUN;
  if (!run || run === true) fail('missing --run <id> (or TAPESTRY_VERIFY_RUN); `launch` prints it');
  return run;
}

function loadState(run) {
  const p = paths(run);
  if (!existsSync(p.state))
    fail(`no state for run ${run} at ${p.state}; it was never launched or is already cleaned up`);
  return JSON.parse(readFileSync(p.state, 'utf8'));
}

function saveState(state) {
  writeFileSync(paths(state.run).state, JSON.stringify(state, null, 2));
}

function record(run, entry) {
  const p = paths(run);
  mkdirSync(p.evidence, { recursive: true });
  appendFileSync(p.actions, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(args) {
  const out = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : null;
}

// ---------------------------------------------------------------- processes

function procStat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0], pgrp: Number(rest[2]) };
  } catch {
    return null;
  }
}

function alive(pid) {
  const stat = procStat(pid);
  return stat !== null && stat.state !== 'Z';
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return '';
  }
}

function groupMembers(pgid) {
  const members = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = procStat(Number(entry));
    if (stat && stat.pgrp === pgid && stat.state !== 'Z') members.push(Number(entry));
  }
  return members;
}

/** PIDs whose open sockets include a LISTEN socket on 127.0.0.1:<port>. */
function listeners(port) {
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const localPort = parseInt(cols[1].split(':')[1], 16);
      if (localPort === port && cols[3] === '0A') inodes.add(cols[9]);
    }
  }
  const pids = new Set();
  if (inodes.size === 0) return { listening: false, pids: [] };
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const link = readlinkSync(`/proc/${entry}/fd/${fd}`);
        const m = /^socket:\[(\d+)\]$/.exec(link);
        if (m && inodes.has(m[1])) pids.add(Number(entry));
      } catch {
        // fd closed while scanning
      }
    }
  }
  return { listening: true, pids: [...pids] };
}

function findChrome() {
  if (process.env.TAPESTRY_VERIFY_CHROME) return process.env.TAPESTRY_VERIFY_CHROME;
  for (const name of CHROME_CANDIDATES) {
    const out = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (out.status === 0 && out.stdout.trim()) return out.stdout.trim();
  }
  return null;
}

async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      if (error.fatal) throw error;
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

// ---------------------------------------------------------------------- CDP

class Cdp {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => bad(new Error(`cannot open CDP socket ${wsUrl}`)), { once: true });
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.waiters = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, bad } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) bad(new Error(`${msg.error.message} (${msg.error.code})`));
        else ok(msg.result);
      } else if (msg.method) {
        this.waiters = this.waiters.filter((w) => !(w.method === msg.method && (w.ok(msg.params), true)));
      }
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, bad) => this.pending.set(id, { ok, bad }));
  }

  once(method) {
    return new Promise((ok) => this.waiters.push({ method, ok }));
  }

  async evaluate(expression) {
    const out = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails)
      throw new Error(`page exception: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`);
    return out.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function pageTarget(state) {
  const list = await (await fetch(`http://127.0.0.1:${state.chromePort}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
  const ours = pages.find((t) => t.url.startsWith(state.url)) ?? pages[0];
  if (!ours) throw new Error('chrome has no page target');
  return ours;
}

async function withPage(state, fn) {
  const target = await pageTarget(state);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    return await fn(cdp, target);
  } finally {
    cdp.close();
  }
}

/** Resize the tab's window. Emulation overrides die with each CDP session; window bounds persist. */
async function resizeWindow(state, targetId, width, height) {
  const version = await (await fetch(`http://127.0.0.1:${state.chromePort}/json/version`)).json();
  const browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);
  try {
    const { windowId } = await browserCdp.send('Browser.getWindowForTarget', { targetId });
    await browserCdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height } });
  } finally {
    browserCdp.close();
  }
}

const SHELL_READY = `(() => {
  const shell = document.querySelector('[data-testid="shell"]');
  const name = document.querySelector('[data-testid="project-name"]');
  return Boolean(shell && name && name.textContent.trim() && document.title === ${JSON.stringify(APP_TITLE)});
})()`;

const SETTLE = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))';

async function navigate(cdp, url) {
  await cdp.send('Page.enable');
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(15000)]);
  await waitFor('workspace shell to render', 20000, () => cdp.evaluate(SHELL_READY));
}

/** Resolve a stable handle to a backend DOM node id. */
async function resolveNode(cdp, flags) {
  const nth = flags.nth === undefined ? null : Number(flags.nth);
  let ids;
  if (flags.testid) {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: `[data-testid=${JSON.stringify(String(flags.testid))}]`,
    });
    ids = [];
    for (const nodeId of nodeIds) ids.push((await cdp.send('DOM.describeNode', { nodeId })).node.backendNodeId);
  } else if (flags.role || flags.name) {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const query = { nodeId: root.nodeId };
    if (flags.role) query.role = String(flags.role);
    if (flags.name) query.accessibleName = String(flags.name);
    const { nodes } = await cdp.send('Accessibility.queryAXTree', query);
    ids = nodes.filter((n) => !n.ignored && n.backendDOMNodeId).map((n) => n.backendDOMNodeId);
  } else {
    throw new Error('need --testid <id> or --role <role> --name <accessible name>');
  }
  const handle = flags.testid
    ? `testid=${flags.testid}`
    : `role=${flags.role ?? '*'} name=${JSON.stringify(flags.name ?? '*')}`;
  if (ids.length === 0) throw new Error(`no element for ${handle}`);
  if (nth === null && ids.length > 1)
    throw new Error(`${ids.length} elements for ${handle}; pass --nth <0-based index>`);
  const id = ids[nth ?? 0];
  if (id === undefined) throw new Error(`--nth ${nth} out of range for ${handle} (${ids.length} matches)`);
  return { backendNodeId: id, handle, matches: ids.length };
}

async function describe(cdp, backendNodeId) {
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
  const out = await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      const attrs = {};
      for (const a of this.attributes) if (a.name.startsWith('data-') || a.name.startsWith('aria-') || a.name === 'disabled' || a.name === 'open') attrs[a.name] = a.value;
      return { tag: this.tagName.toLowerCase(), text: (this.innerText ?? this.textContent ?? '').trim(), attrs, focused: document.activeElement === this };
    }`,
  });
  return out.result.value;
}

async function click(cdp, backendNodeId) {
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  const { quads } = await cdp.send('DOM.getContentQuads', { backendNodeId });
  if (!quads.length) throw new Error('element has no visible box (hidden or zero-size)');
  const q = quads[0];
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { x: Math.round(x), y: Math.round(y) };
}

const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
};

async function press(cdp, name, shift) {
  const key = KEYS[name];
  if (!key) throw new Error(`unsupported key ${name}; use one of ${Object.keys(KEYS).join(', ')}`);
  const modifiers = shift ? 8 : 0;
  await cdp.send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', modifiers, ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...key, text: undefined });
}

const STATE_EXPR = `(() => {
  const q = (id) => document.querySelector('[data-testid="' + id + '"]');
  const t = (id) => q(id)?.textContent.trim() ?? null;
  const shell = q('shell');
  const visible = (el) => {
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true') n.childNodes.forEach(walk);
    };
    walk(el);
    return out.replace(/\\s+/g, ' ').trim();
  };
  const pressed = (group) => [...document.querySelectorAll('[role="group"][aria-label="' + group + '"] [aria-pressed="true"]')].map((b) => b.textContent.trim());
  return {
    url: location.href,
    title: document.title,
    project: t('project-name'),
    session: t('session-id'),
    revision: document.querySelector('[data-testid="revision"] .font-mono')?.textContent.trim() ?? null,
    theme: t('theme-id'),
    shell: shell ? {
      theme: shell.dataset.theme, density: shell.dataset.density, selection: shell.dataset.selection,
      sessionEnded: shell.dataset.sessionEnded,
    } : null,
    regions: JSON.parse(q('tree-key')?.textContent || 'null'),
    pressedTheme: pressed('Theme'),
    pressedFixture: pressed('Fixture'),
    observationCount: document.querySelector('[data-testid="region-main"]')?.parentElement?.querySelector('h2 + span')?.textContent.trim() ?? null,
    observations: [...document.querySelectorAll('[data-testid="observation"]')].map((r) => [...r.cells].map(visible)),
    withheld: ['observations-omitted', 'availability-omitted', 'approvals-omitted'].filter((id) => q(id)).map((id) => ({ id, text: t(id) })),
    approvals: document.querySelectorAll('[data-testid="approval-pending"]').length,
    digests: [...document.querySelectorAll('[data-testid="approval-pending"] details')].map((d) => ({ label: d.querySelector('summary span')?.textContent.trim(), open: d.open })),
    decisionControls: ['approve', 'deny'].map((id) => ({ id, disabled: q(id)?.disabled ?? null })),
    operatorInputDisabled: q('operator-input')?.disabled ?? null,
    attachments: [...document.querySelectorAll('[data-testid="project-index"] button')].map((b) => ({ label: b.querySelector('.truncate')?.textContent.trim(), pressed: b.getAttribute('aria-pressed') })),
  };
})()`;

async function axSnapshot(cdp) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines = [];
  const walk = (node, depth) => {
    const role = node.role?.value ?? '';
    const name = node.name?.value ?? '';
    const skip =
      node.ignored ||
      ((role === 'generic' || role === 'none' || role === 'StaticText' || role === 'InlineTextBox') && !name) ||
      role === 'InlineTextBox';
    let nextDepth = depth;
    if (!skip) {
      const props = (node.properties ?? [])
        .filter((p) => ['pressed', 'disabled', 'focused', 'expanded', 'checked', 'selected', 'level'].includes(p.name))
        .map((p) => `${p.name}=${p.value?.value}`);
      lines.push(
        `${'  '.repeat(depth)}${role}${name ? ` ${JSON.stringify(name)}` : ''}${props.length ? ` [${props.join(' ')}]` : ''}`,
      );
      nextDepth = depth + 1;
    }
    for (const child of node.childIds ?? []) {
      const c = byId.get(child);
      if (c) walk(c, nextDepth);
    }
  };
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  walk(root, 0);
  return lines.join('\n') + '\n';
}

function evidencePath(state, p) {
  if (!p || p === true) throw new Error('need --path <file> (relative paths land in the run evidence dir)');
  const full = isAbsolute(p) ? p : join(state.evidence, p);
  mkdirSync(dirname(full), { recursive: true });
  return full;
}

// ----------------------------------------------------------------- commands

async function launch(flags) {
  const run =
    flags.run && flags.run !== true
      ? String(flags.run)
      : `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(2).toString('hex')}`;
  const p = paths(run);
  if (existsSync(p.scratch)) fail(`run ${run} already exists at ${p.scratch}; clean it up or choose another --run`);
  mkdirSync(p.scratch, { recursive: true });
  mkdirSync(p.evidence, { recursive: true });
  const chrome = findChrome();
  if (!chrome) fail('no Chrome/Chromium on PATH; set TAPESTRY_VERIFY_CHROME=/path/to/chrome');

  const state = {
    run,
    repo: REPO,
    head: git(['rev-parse', 'HEAD']),
    dirty: (git(['status', '--porcelain']) ?? '') !== '',
    scratch: p.scratch,
    evidence: p.evidence,
    startedAt: new Date().toISOString(),
  };
  saveState(state);
  process.stdout.write(`RUN=${run}\nscratch=${p.scratch}\nevidence=${p.evidence}\n`);

  // 1. Build workspace packages: the web host resolves @weave/tapestry from dist/.
  process.stdout.write('building workspace packages (npm run build)...\n');
  const build = spawnSync('npm', ['run', 'build'], { cwd: REPO, encoding: 'utf8' });
  writeFileSync(join(p.scratch, 'build.log'), `${build.stdout}\n${build.stderr}`);
  writeFileSync(join(p.evidence, 'build.log'), `${build.stdout}\n${build.stderr}\nexit=${build.status}\n`);
  if (build.status !== 0) fail(`npm run build failed (exit ${build.status}); see ${join(p.evidence, 'build.log')}`);

  // 2. Vite dev server: the repo's host:workspace command on a free port, own process group.
  state.vitePort = Number(flags.port ?? (await freePort()));
  state.url = `http://127.0.0.1:${state.vitePort}/`;
  const viteLog = join(p.scratch, 'vite.log');
  const viteFd = openSync(viteLog, 'a');
  const vite = spawn(
    'npm',
    [
      'run',
      'dev',
      '-w',
      '@weave/tapestry-web',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(state.vitePort),
      '--strictPort',
    ],
    {
      cwd: REPO,
      detached: true,
      stdio: ['ignore', viteFd, viteFd],
    },
  );
  closeSync(viteFd);
  state.vitePid = vite.pid;
  saveState(state);
  try {
    await waitFor(`vite on ${state.url}`, 30000, async () => {
      if (!alive(state.vitePid))
        throw Object.assign(new Error(`vite exited during startup; see ${viteLog}`), { fatal: true });
      const log = existsSync(viteLog) ? readFileSync(viteLog, 'utf8') : '';
      if (!log.includes(`127.0.0.1:${state.vitePort}`)) return false;
      const html = await (await fetch(state.url)).text();
      const entry = await fetch(new URL('/src/main.tsx', state.url));
      return html.includes(`<title>${APP_TITLE}</title>`) && entry.ok;
    });
  } catch (error) {
    fail(`${error.message}\nrun: tapestry-verify.mjs cleanup --run ${run}`);
  }

  // 3. Headless Chrome with a disposable profile, own process group.
  state.chromePort = await freePort();
  state.chromeProfile = join(p.scratch, 'chrome-profile');
  const chromeArgs = [
    '--headless=new',
    `--remote-debugging-port=${state.chromePort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${state.chromeProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-gpu',
    '--window-size=1440,900',
    'about:blank',
  ];
  if (process.getuid?.() === 0) chromeArgs.unshift('--no-sandbox');
  const chromeFd = openSync(join(p.scratch, 'chrome.log'), 'a');
  const chromeProc = spawn(chrome, chromeArgs, { detached: true, stdio: ['ignore', chromeFd, chromeFd] });
  closeSync(chromeFd);
  state.chromePid = chromeProc.pid;
  state.chrome = chrome;
  saveState(state);
  try {
    const version = await waitFor('chrome DevTools endpoint', 20000, async () =>
      (await fetch(`http://127.0.0.1:${state.chromePort}/json/version`)).json(),
    );
    state.browserVersion = version.Browser;
    saveState(state);
    await withPage(state, async (cdp) => {
      await navigate(cdp, state.url);
    });
  } catch (error) {
    fail(`${error.message}\nrun: tapestry-verify.mjs cleanup --run ${run}`);
  }
  state.readyAt = new Date().toISOString();
  saveState(state);
  writeFileSync(join(p.evidence, 'launch.json'), JSON.stringify(state, null, 2));
  record(run, {
    command: 'launch',
    result: { url: state.url, head: state.head, dirty: state.dirty, browser: state.browserVersion },
  });
  process.stdout.write(
    `READY url=${state.url} vitePid=${state.vitePid} chromePort=${state.chromePort} chromePid=${state.chromePid}\n`,
  );
  // Detached children keep running in their own process groups after we exit.
  vite.unref();
  chromeProc.unref();
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

async function doctor(flags) {
  const run = runId(flags);
  const state = loadState(run);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  check('vite process alive', alive(state.vitePid), `pid ${state.vitePid}: ${cmdline(state.vitePid).slice(0, 120)}`);
  const vitePort = listeners(state.vitePort);
  const viteGroup = groupMembers(state.vitePid);
  check(
    'vite port owned by this run',
    vitePort.listening && vitePort.pids.length > 0 && vitePort.pids.every((pid) => viteGroup.includes(pid)),
    `port ${state.vitePort} listeners ${JSON.stringify(vitePort.pids)}; run group ${JSON.stringify(viteGroup)}`,
  );
  try {
    const html = await (await fetch(state.url, { signal: AbortSignal.timeout(5000) })).text();
    check('app serves Weave Tapestry', html.includes(`<title>${APP_TITLE}</title>`), state.url);
  } catch (error) {
    check('app serves Weave Tapestry', false, error.message);
  }
  const head = git(['rev-parse', 'HEAD']);
  check('checkout HEAD matches launch', head === state.head, `launch ${state.head} now ${head}`);
  const tapestrySrc = join(REPO, 'packages/tapestry/src');
  const tapestryDist = join(REPO, 'packages/tapestry/dist/src/index.js');
  const distFresh = existsSync(tapestryDist) && statSync(tapestryDist).mtimeMs >= newestMtime(tapestrySrc);
  check(
    '@weave/tapestry dist is not older than src',
    distFresh,
    existsSync(tapestryDist) ? tapestryDist : 'dist missing: relaunch (launch runs npm run build)',
  );
  check('chrome process alive', alive(state.chromePid), `pid ${state.chromePid}`);
  const chromePort = listeners(state.chromePort);
  const chromeGroup = groupMembers(state.chromePid);
  check(
    'chrome DevTools port owned by this run',
    chromePort.listening && chromePort.pids.every((pid) => chromeGroup.includes(pid)),
    `port ${state.chromePort} listeners ${JSON.stringify(chromePort.pids)}`,
  );
  try {
    const page = await withPage(state, async (cdp, target) => ({
      target: target.url,
      ready: await cdp.evaluate(SHELL_READY),
      state: await cdp.evaluate(STATE_EXPR),
    }));
    check('page is on this run URL', page.target.startsWith(state.url), page.target);
    check(
      'workspace shell rendered',
      page.ready,
      `project=${page.state.project} theme=${page.state.theme} fixture=${page.state.pressedFixture.join(',')}`,
    );
  } catch (error) {
    check('page reachable over CDP', false, error.message);
  }
  const ok = checks.every((c) => c.ok);
  const report = { run, ok, url: state.url, evidence: state.evidence, checks };
  record(run, { command: 'doctor', result: { ok, failed: checks.filter((c) => !c.ok).map((c) => c.name) } });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!ok) process.exit(1);
}

async function browser(flags, positional) {
  const run = runId(flags);
  const state = loadState(run);
  const action = positional[0];
  if (!action)
    fail('browser needs an action: goto|click|press|state|text|attr|wait|snapshot|screenshot|viewport|network');
  const result = await withPage(state, async (cdp, target) => {
    switch (action) {
      case 'goto': {
        const url = new URL(flags.path && flags.path !== true ? String(flags.path) : '/', state.url).href;
        await navigate(cdp, url);
        return { url, state: await cdp.evaluate(STATE_EXPR) };
      }
      case 'click': {
        const node = await resolveNode(cdp, flags);
        const before = await describe(cdp, node.backendNodeId);
        const at = await click(cdp, node.backendNodeId);
        await cdp.evaluate(SETTLE);
        const after = await describe(cdp, node.backendNodeId);
        return { handle: node.handle, at, before, after };
      }
      case 'press': {
        await press(cdp, String(flags.key), Boolean(flags.shift));
        await cdp.evaluate(SETTLE);
        const focused = await cdp.evaluate(
          `(() => { const e = document.activeElement; return e ? { tag: e.tagName.toLowerCase(), testid: e.dataset?.testid ?? null, text: (e.innerText ?? '').trim().slice(0, 80), pressed: e.getAttribute('aria-pressed') } : null; })()`,
        );
        return { key: flags.key, shift: Boolean(flags.shift), focused };
      }
      case 'state':
        return cdp.evaluate(STATE_EXPR);
      case 'text':
      case 'attr': {
        const node = await resolveNode(cdp, flags);
        const d = await describe(cdp, node.backendNodeId);
        if (action === 'text') return { handle: node.handle, text: d.text };
        if (!flags.attr) throw new Error('attr needs --attr <name>');
        return { handle: node.handle, attr: flags.attr, value: d.attrs[flags.attr] ?? null };
      }
      case 'wait': {
        const timeout = Number(flags.timeout ?? 10000);
        if (flags.text) {
          const text = String(flags.text);
          await waitFor(`text ${JSON.stringify(text)}`, timeout, () =>
            cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`),
          );
          return { found: text };
        }
        const node = await waitFor('element', timeout, () => resolveNode(cdp, flags).catch(() => null));
        return { found: node.handle };
      }
      case 'snapshot': {
        const file = evidencePath(state, flags.path);
        writeFileSync(file, await axSnapshot(cdp));
        return { wrote: file };
      }
      case 'screenshot': {
        const file = evidencePath(state, flags.path);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        return { wrote: file };
      }
      case 'viewport': {
        const width = Number(flags.width ?? 1440);
        const height = Number(flags.height ?? 900);
        await resizeWindow(state, target.id, width, height);
        await sleep(300);
        await cdp.evaluate(SETTLE);
        return {
          requested: { width, height },
          inner: await cdp.evaluate('({ width: innerWidth, height: innerHeight })'),
        };
      }
      case 'network': {
        const origins = await cdp.evaluate(
          `[...new Set([location.href, ...performance.getEntriesByType('resource').map((e) => e.name)].map((u) => new URL(u).origin))]`,
        );
        const own = new URL(state.url).origin;
        return { origins, foreign: origins.filter((o) => o !== own) };
      }
      default:
        throw new Error(`unknown browser action ${action}`);
    }
  }).catch((error) => {
    record(run, { command: 'browser', action, flags, error: error.message });
    fail(error.message);
  });
  record(run, { command: 'browser', action, flags, result });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function stopGroup(pid, marker) {
  if (!pid) return { pid, skipped: 'never started' };
  if (!alive(pid)) return { pid, skipped: 'already exited' };
  const stat = procStat(pid);
  if (stat.pgrp !== pid)
    return { pid, refused: `pid ${pid} is not a process-group leader (pgrp ${stat.pgrp}); not ours` };
  if (!cmdline(pid).includes(marker))
    return { pid, refused: `pid ${pid} cmdline lacks ${JSON.stringify(marker)}; pid reused?` };
  process.kill(-pid, 'SIGTERM');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && groupMembers(pid).length > 0) await sleep(200);
  const left = groupMembers(pid);
  if (left.length) process.kill(-pid, 'SIGKILL');
  await sleep(200);
  return { pid, stopped: true, forced: left.length > 0, remaining: groupMembers(pid) };
}

async function cleanup(flags) {
  const run = runId(flags);
  const p = paths(run);
  if (!existsSync(p.state)) {
    process.stdout.write(
      `nothing to clean for ${run} (no ${p.state})\nevidence=${p.evidence} exists=${existsSync(p.evidence)}\n`,
    );
    return;
  }
  const state = loadState(run);
  const report = {
    run,
    vite: await stopGroup(state.vitePid, 'run dev'),
    chrome: await stopGroup(state.chromePid, state.chromeProfile ?? '--remote-debugging-port'),
  };
  // Released means no listener from our process groups; a foreign listener is reported, never killed.
  const held = (port, pgid) => (port ? listeners(port).pids.filter((pid) => procStat(pid)?.pgrp === pgid) : []);
  const foreign = (port, pgid) => (port ? listeners(port).pids.filter((pid) => procStat(pid)?.pgrp !== pgid) : []);
  report.vitePortFree = held(state.vitePort, state.vitePid).length === 0;
  report.chromePortFree = held(state.chromePort, state.chromePid).length === 0;
  report.foreignListeners = {
    vite: foreign(state.vitePort, state.vitePid),
    chrome: foreign(state.chromePort, state.chromePid),
  };
  const refused = [report.vite.refused, report.chrome.refused].filter(Boolean);
  for (const name of ['vite.log', 'chrome.log']) {
    const src = join(p.scratch, name);
    if (existsSync(src)) writeFileSync(join(p.evidence, name), readFileSync(src));
  }
  if (refused.length === 0) rmSync(p.scratch, { recursive: true, force: true });
  report.scratchRemoved = !existsSync(p.scratch);
  report.evidence = p.evidence;
  report.evidenceKept = existsSync(p.evidence) ? readdirSync(p.evidence, { recursive: true }).sort() : [];
  writeFileSync(join(p.evidence, 'cleanup.json'), JSON.stringify(report, null, 2));
  record(run, {
    command: 'cleanup',
    result: {
      vitePortFree: report.vitePortFree,
      chromePortFree: report.chromePortFree,
      scratchRemoved: report.scratchRemoved,
      refused,
    },
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (refused.length || !report.vitePortFree || !report.chromePortFree) process.exit(1);
}

function runs() {
  const out = [];
  if (existsSync(SCRATCH_ROOT)) {
    for (const run of readdirSync(SCRATCH_ROOT).sort()) {
      const file = join(SCRATCH_ROOT, run, 'state.json');
      if (!existsSync(file)) {
        out.push({ run, state: 'no state.json' });
        continue;
      }
      const s = JSON.parse(readFileSync(file, 'utf8'));
      out.push({
        run,
        url: s.url,
        vite: s.vitePid && alive(s.vitePid),
        chrome: s.chromePid && alive(s.chromePid),
        evidence: s.evidence,
      });
    }
  }
  process.stdout.write(
    JSON.stringify({ scratchRoot: SCRATCH_ROOT, evidenceRoot: EVIDENCE_ROOT, live: out }, null, 2) + '\n',
  );
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional.shift();
const commands = {
  launch: () => launch(flags),
  doctor: () => doctor(flags),
  browser: () => browser(flags, positional),
  cleanup: () => cleanup(flags),
  runs,
};
if (!commands[command]) fail('usage: tapestry-verify.mjs launch|doctor|browser|cleanup|runs [--run <id>] ...', 2);
await commands[command]();
