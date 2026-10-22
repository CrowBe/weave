import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { withCredentialLock, redactTokens } from './chatgpt-local.ts';

test('credential lock excludes another process and releases after failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weave-cli-'));
  const path = join(dir, 'chatgpt.json');
  try {
    await withCredentialLock(path, async () => {
      await assert.rejects(
        withCredentialLock(path, async () => {}),
        /in use/,
      );
    });
    await assert.rejects(
      withCredentialLock(path, async () => {
        throw new Error('test');
      }),
      /test/,
    );
    await withCredentialLock(path, async () => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('probe diagnostics remove literal and JSON-escaped credential values', () => {
  assert.equal(redactTokens('token abc \\"x', ['abc', '\\"x']), 'token [REDACTED] [REDACTED]');
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'cli', alg: 'RS256', use: 'sig' }] };
const OPTIONS_MESSAGE = 'Use --port 1..65535 and a positive --timeout-ms no greater than 2147483647.';
const CLEARED_MESSAGE =
  'The saved client registration was rejected and has been cleared. Run sign-in again to register a new client.';

/** A token response whose ID token is signed for `clientId`, bound to the attempt's nonce and valid for an hour of real time. */
function tokenResponse(
  authorize: URL,
  clientId: string,
  label: string,
  claims: Record<string, unknown> = {},
): Response {
  const payload = {
    iss: 'https://auth.openai.com',
    aud: clientId,
    sub: 'subject-1',
    email: 'user@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: authorize.searchParams.get('nonce'),
    ...claims,
  };
  const data = [{ alg: 'RS256', kid: 'cli' }, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  const id_token = `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
  return new Response(
    JSON.stringify({
      access_token: `SECRET_ACCESS_${label}`,
      refresh_token: `SECRET_REFRESH_${label}`,
      id_token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid offline_access chatgpt.tokens.use.direct',
    }),
  );
}
function accepted(authorize: URL, clientId?: string): Record<string, string> {
  return {
    state: authorize.searchParams.get('state')!,
    code: 'SECRET_CODE',
    ...(clientId ? { client_id: clientId } : {}),
  };
}

interface SigninRun {
  authorize?: URL;
  callbackStatus?: number;
  output: string[];
  diagnostics: string[];
  requests: string[];
  exitCode: typeof process.exitCode;
  serverCreated: boolean;
  serverClosed: boolean;
}
let imports = 0;
/**
 * Runs examples/chatgpt-signin.ts once with a fake loopback server and fetch.
 * The module awaits its own main, so the import settles after the lock is
 * released and diagnostics are printed. Hooks only record; tests assert after.
 */
async function signin(
  path: string,
  options: {
    args?: string[];
    callback?: (authorize: URL) => Record<string, string>;
    token?: (form: URLSearchParams, authorize: URL) => Response | Promise<Response>;
  } = {},
): Promise<SigninRun> {
  const run: SigninRun = {
    output: [],
    diagnostics: [],
    requests: [],
    exitCode: undefined,
    serverCreated: false,
    serverClosed: false,
  };
  const original = {
    createServer: http.createServer,
    fetch: globalThis.fetch,
    log: console.log,
    error: console.error,
    argv: process.argv,
    exitCode: process.exitCode,
  };
  const server = new EventEmitter();
  Object.assign(server, {
    listen: (_port: number, _host: string, ready: () => void) => ready(),
    closeAllConnections: () => {},
    close: (done: () => void) => {
      run.serverClosed = true;
      done();
    },
  });
  try {
    http.createServer = (() => {
      run.serverCreated = true;
      return server;
    }) as unknown as typeof http.createServer;
    syncBuiltinESMExports();
    process.argv = [
      'node',
      'chatgpt-signin.ts',
      '--credentials',
      path,
      ...(options.args ?? ['--port', '1455', '--timeout-ms', '5000']),
    ];
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => {
      run.output.push(args.join(' '));
      if (typeof args[0] !== 'string' || !args[0].startsWith('https://auth.openai.com/')) return;
      const authorize = new URL(args[0]);
      run.authorize = authorize;
      const callback = new URL(authorize.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams((options.callback ?? accepted)(authorize)).toString();
      const response = {
        writeHead(status: number) {
          run.callbackStatus = status;
          return this;
        },
        end() {},
      };
      setImmediate(() => server.emit('request', { method: 'GET', url: callback.pathname + callback.search }, response));
    };
    console.error = (...args: unknown[]) => {
      run.diagnostics.push(args.join(' '));
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      run.requests.push(url);
      if (url === 'https://auth.openai.com/.well-known/jwks.json') return new Response(JSON.stringify(JWKS));
      if (url === 'https://auth.openai.com/api/accounts/oauth/token' && options.token && run.authorize)
        return options.token(new URLSearchParams(String(init?.body)), run.authorize);
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    await import(`./chatgpt-signin.ts?run=${imports++}`);
    run.exitCode = process.exitCode;
    return run;
  } finally {
    http.createServer = original.createServer;
    syncBuiltinESMExports();
    globalThis.fetch = original.fetch;
    console.log = original.log;
    console.error = original.error;
    process.argv = original.argv;
    process.exitCode = original.exitCode;
  }
}
async function stored(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, 'utf8'));
}
function assertFinished(run: SigninRun, path: string, failed: boolean): void {
  assert.equal(run.exitCode, failed ? 1 : undefined);
  assert.equal(run.serverClosed, run.serverCreated);
  assert.equal(existsSync(`${path}.lock`), false);
  assert.doesNotMatch([...run.output, ...run.diagnostics].join('\n'), /SECRET/);
}

test('sign-in persists issued registration before exchange and reuses it after failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weave-signin-'));
  const path = join(dir, 'chatgpt.json');
  try {
    for (let run = 0; run < 2; run++) {
      let registrationAtExchange: unknown;
      const result = await signin(path, {
        callback: (authorize) => accepted(authorize, run ? undefined : 'oaiapp_issued'),
        token: async () => {
          registrationAtExchange = (await stored(path)).registration;
          return new Response(
            JSON.stringify({ error: 'unauthorized_client', error_description: 'SECRET_BODY SECRET_CODE' }),
            { status: 403 },
          );
        },
      });
      assert.equal(result.authorize?.searchParams.get('client_id'), run ? 'oaiapp_issued' : 'dynamic_agent_client');
      assert.equal(result.authorize?.searchParams.has('agent_name_hint'), !run);
      assert.equal(result.callbackStatus, 200);
      assert.deepEqual(registrationAtExchange, { client_id: 'oaiapp_issued' });
      assert.deepEqual(result.diagnostics, ['Sign-in failed: unauthorized_client (HTTP 403)']);
      assertFinished(result, path, true);
      assert.deepEqual((await stored(path)).registration, { client_id: 'oaiapp_issued' });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('re-sign-in with saved credentials reuses the client, keeps the account and replaces tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weave-resignin-'));
  const path = join(dir, 'chatgpt.json');
  try {
    const first = await signin(path, {
      callback: (authorize) => accepted(authorize, 'oaiapp_issued'),
      token: (_form, authorize) => tokenResponse(authorize, 'oaiapp_issued', 'FIRST'),
    });
    assert.deepEqual(first.diagnostics, []);
    assertFinished(first, path, false);
    assert.deepEqual(JSON.parse(first.output.at(-1)!), {
      account: 'user@example.com',
      client_id: 'oaiapp_issued',
      scopes: ['openid', 'offline_access', 'chatgpt.tokens.use.direct'],
      status: 'plan usage granted',
    });
    const saved = await stored(path);
    assert.equal(saved.credentials.access_token, 'SECRET_ACCESS_FIRST');
    assert.deepEqual(saved.registration, { client_id: 'oaiapp_issued', subject: 'subject-1' });
    assert.equal(statSync(path).mode & 0o777, 0o600);

    let form: URLSearchParams | undefined;
    const second = await signin(path, {
      token: (body, authorize) => {
        form = body;
        return tokenResponse(authorize, 'oaiapp_issued', 'SECOND');
      },
    });
    assert.equal(second.authorize?.searchParams.get('client_id'), 'oaiapp_issued');
    assert.equal(second.authorize?.searchParams.has('agent_name_hint'), false);
    assert.equal(second.authorize?.searchParams.get('ext_agent_host_id'), saved.ext_agent_host_id);
    assert.equal(form?.get('client_id'), 'oaiapp_issued');
    assert.deepEqual(second.diagnostics, []);
    assertFinished(second, path, false);
    const replaced = await stored(path);
    assert.equal(replaced.ext_agent_host_id, saved.ext_agent_host_id);
    assert.equal(replaced.credentials.access_token, 'SECRET_ACCESS_SECOND');
    assert.equal(replaced.credentials.refresh_token, 'SECRET_REFRESH_SECOND');
    assert.deepEqual(replaced.registration, saved.registration);

    const other = await signin(path, {
      token: (_form, authorize) => tokenResponse(authorize, 'oaiapp_issued', 'THIRD', { sub: 'subject-2' }),
    });
    assert.deepEqual(other.diagnostics, ['Sign-in failed: account identity mismatch']);
    assertFinished(other, path, true);
    assert.deepEqual(await stored(path), replaced);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a permanently rejected registration is cleared so the next sign-in registers again', async () => {
  for (const code of ['invalid_client', 'registration_required']) {
    const dir = await mkdtemp(join(tmpdir(), 'weave-rejected-'));
    const path = join(dir, 'chatgpt.json');
    try {
      await signin(path, {
        callback: (authorize) => accepted(authorize, 'oaiapp_issued'),
        token: (_form, authorize) => tokenResponse(authorize, 'oaiapp_issued', 'FIRST'),
      });
      const host = (await stored(path)).ext_agent_host_id;
      const rejected = await signin(path, {
        token: () =>
          new Response(JSON.stringify({ error: code, error_description: 'SECRET_DESCRIPTION' }), { status: 401 }),
      });
      assert.equal(rejected.authorize?.searchParams.get('client_id'), 'oaiapp_issued');
      assert.deepEqual(rejected.diagnostics, [`Sign-in failed: ${code} (HTTP 401)`, CLEARED_MESSAGE]);
      assertFinished(rejected, path, true);
      assert.deepEqual(await stored(path), { ext_agent_host_id: host });

      const fresh = await signin(path, {
        callback: (authorize) => accepted(authorize, 'oaiapp_new'),
        token: (_form, authorize) => tokenResponse(authorize, 'oaiapp_new', 'NEW'),
      });
      assert.equal(fresh.authorize?.searchParams.get('client_id'), 'dynamic_agent_client');
      assert.equal(fresh.authorize?.searchParams.get('agent_name_hint'), 'Weave');
      assert.equal(fresh.authorize?.searchParams.get('ext_agent_host_id'), host);
      assert.deepEqual(fresh.diagnostics, []);
      assertFinished(fresh, path, false);
      assert.deepEqual((await stored(path)).registration, { client_id: 'oaiapp_new', subject: 'subject-1' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('a rejected callback reports its fixed code and never reaches the token endpoint', async () => {
  const cases: [(authorize: URL) => Record<string, string>, string][] = [
    [() => ({ state: 'SECRET_WRONG_STATE', code: 'SECRET_CODE' }), 'state mismatch'],
    [
      (authorize) => ({
        state: authorize.searchParams.get('state')!,
        error: 'access_denied',
        error_description: 'SECRET_DESCRIPTION',
      }),
      'access_denied',
    ],
    [(authorize) => ({ state: authorize.searchParams.get('state')!, error: 'SECRET_ERROR' }), 'authorization rejected'],
    [(authorize) => ({ state: authorize.searchParams.get('state')!, code: 'SECRET_CODE' }), 'invalid issued client_id'],
    [
      (authorize) => ({ state: authorize.searchParams.get('state')!, client_id: 'oaiapp_issued' }),
      'missing authorization code',
    ],
  ];
  for (const [callback, code] of cases) {
    const dir = await mkdtemp(join(tmpdir(), 'weave-callback-'));
    const path = join(dir, 'chatgpt.json');
    try {
      const result = await signin(path, {
        callback,
        token: () => assert.fail('the token endpoint must not be called'),
      });
      assert.equal(result.callbackStatus, 400);
      assert.deepEqual(result.diagnostics, [`Sign-in failed: ${code}`], code);
      assert.deepEqual(result.requests, []);
      assertFinished(result, path, true);
      assert.deepEqual(Object.keys(await stored(path)), ['ext_agent_host_id']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('invalid --port or --timeout-ms prints the fixed usage message before listening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weave-options-'));
  const path = join(dir, 'chatgpt.json');
  try {
    for (const args of [
      ['--port', '0'],
      ['--port', '65536'],
      ['--port', '1.5'],
      ['--timeout-ms', '0'],
      ['--timeout-ms', '2147483648'],
      ['--timeout-ms', 'soon'],
    ]) {
      const result = await signin(path, { args });
      assert.deepEqual(result.diagnostics, [OPTIONS_MESSAGE], args.join(' '));
      assert.equal(result.serverCreated, false);
      assertFinished(result, path, true);
      assert.equal(existsSync(path), false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
