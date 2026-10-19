import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuthorizeUrl, createAuthorizationAttempt, handleCallback, exchangeCode, refreshCredentials, validateIdToken, planUsageStatus, ensureHostId, ChatGPTAuthError } from '../src/index.js';
import { FileCredentialStore } from '../src/file-store.js';

const clock = { now: () => 1_000_000 };
const attempt = createAuthorizationAttempt({ port: 1455, hostId: 'urn:uuid:host' });
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key', alg: 'RS256', use: 'sig' };
const claims = { iss: 'https://auth.openai.com', aud: 'oaiapp_test', sub: 'subject', exp: 1100, nonce: attempt.nonce, email: 'user@example.com' };
function jwt(overrides: Record<string, unknown> = {}, key = privateKey) {
  const data = [ { alg: 'RS256', kid: 'key' }, { ...claims, ...overrides } ].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}
const fetchJwks: typeof fetch = async url => new Response(JSON.stringify(String(url).endsWith('openid-configuration') ? { jwks_uri: 'https://auth.openai.com/jwks' } : { keys: [jwk] }));
const tokens = () => ({ access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH', id_token: jwt(), token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', earliest_refresh_at: 1200 });
test('authorize URL contains exactly documented initial params and PKCE S256', () => {
  const url = new URL(buildAuthorizeUrl(attempt));
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: 'dynamic_agent_client', agent_name_hint: 'Weave', ext_agent_host_id: 'urn:uuid:host', response_type: 'code', redirect_uri: 'http://127.0.0.1:1455/auth/callback', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: 'https://api.openai.com/v1', state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url') });
  assert.match(attempt.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.notEqual(createAuthorizationAttempt({ port: 1455, hostId: 'host' }).state, attempt.state);
});
test('returning registration reuses client and omits initial name and token hints by default', () => {
  const returning = createAuthorizationAttempt({ port: 2345, hostId: 'host', clientId: 'oaiapp_test' });
  const url = new URL(buildAuthorizeUrl(returning));
  assert.equal(url.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(url.searchParams.has('agent_name_hint'), false);
  assert.equal(url.searchParams.has('id_token_hint'), false);
  assert.equal(handleCallback(`${returning.redirectUri}?state=${returning.state}&code=code`, returning).clientId, 'oaiapp_test');
  assert.throws(() => handleCallback(`${returning.redirectUri}?state=${returning.state}&code=code&client_id=other`, returning), /client/);
});
test('callback rejects state, OAuth denial, missing issued client and wrong callback', () => {
  assert.throws(() => handleCallback(`${attempt.redirectUri}?state=wrong&code=SECRET`, attempt), /state/);
  assert.throws(() => handleCallback(`${attempt.redirectUri}?state=${attempt.state}&error=access_denied&error_description=SECRET`, attempt), /access_denied/);
  assert.throws(() => handleCallback(`${attempt.redirectUri}?state=${attempt.state}&code=SECRET`, attempt), /client/);
  assert.throws(() => handleCallback(`http://127.0.0.1:1455/other?state=${attempt.state}`, attempt), /callback/);
});
test('validates signature and claims with locally generated RSA JWKS', async () => {
  assert.equal((await validateIdToken(jwt(), { fetch: fetchJwks, clock, clientId: 'oaiapp_test', nonce: attempt.nonce })).subject, 'subject');
  for (const overrides of [{ iss: 'bad' }, { aud: 'bad' }, { exp: 999 }, { nonce: 'bad' }]) {
    await assert.rejects(validateIdToken(jwt(overrides), { fetch: fetchJwks, clock, clientId: 'oaiapp_test', nonce: attempt.nonce }));
  }
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(validateIdToken(jwt({}, other.privateKey), { fetch: fetchJwks, clock, clientId: 'oaiapp_test', nonce: attempt.nonce }), /signature/);
});
test('scope check distinguishes identity-only from plan grant', () => {
  assert.equal(planUsageStatus(['openid']), 'identity only, plan usage not granted');
  assert.equal(planUsageStatus(['chatgpt.tokens.use.direct']), 'plan usage granted');
});
test('exchange uses exact form and refresh rotates tokens and retains identity', async () => {
  const calls: URLSearchParams[] = [];
  const tokenFetch: typeof fetch = async (url, init) => {
    if (String(url).includes('oauth/token')) {
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/x-www-form-urlencoded');
      calls.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify(tokens()));
    }
    return fetchJwks(url, init);
  };
  const record = await exchangeCode(attempt, { code: 'code', clientId: 'oaiapp_test' }, { fetch: tokenFetch, clock });
  assert.deepEqual(Object.fromEntries(calls[0]!), { grant_type: 'authorization_code', client_id: 'oaiapp_test', code: 'code', code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: 'https://api.openai.com/v1' });
  const refreshed = await refreshCredentials(record, { fetch: tokenFetch, clock });
  assert.deepEqual(Object.fromEntries(calls[1]!), { grant_type: 'refresh_token', client_id: 'oaiapp_test', refresh_token: 'SECRET_REFRESH', resource: 'https://api.openai.com/v1' });
  assert.equal(refreshed.subject, record.subject);
  assert.equal(refreshed.earliest_refresh_at, 1200);
  await assert.rejects(exchangeCode({ ...attempt, subject: 'other' }, { code: 'code', clientId: 'oaiapp_test' }, { fetch: tokenFetch, clock }), /identity/);
});
test('endpoint failures never reflect tokens or remote errors', async () => {
  for (const fetcher of [async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'SECRET_ACCESS SECRET_REFRESH' }), { status: 400 }), async () => { throw new Error('SECRET_ACCESS'); }]) {
    await assert.rejects(exchangeCode(attempt, { code: 'SECRET_ACCESS', clientId: 'oaiapp_test' }, { fetch: fetcher, clock }), error => !String(error).includes('SECRET'));
  }
});
test('host ID persists before first sign-in and file permissions are private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weave-auth-'));
  try {
    const store = new FileCredentialStore(join(directory, 'private', 'chatgpt.json'));
    const host = await ensureHostId(store);
    assert.match(host, /^urn:uuid:/);
    assert.equal(await ensureHostId(store), host);
    assert.equal((await stat(join(directory, 'private', 'chatgpt.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('file store never chmods an existing directory and refuses one that others can access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weave-auth-dir-'));
  try {
    for (const mode of [0o755, 0o750, 0o705, 0o1777]) {
      const shared = join(directory, `shared-${mode.toString(8)}`);
      await mkdir(shared);
      await chmod(shared, mode);
      await assert.rejects(new FileCredentialStore(join(shared, 'chatgpt.json')).save({ ext_agent_host_id: 'urn:uuid:host' }),
        error => error instanceof ChatGPTAuthError && error.code === 'credential store directory not private');
      assert.equal((await stat(shared)).mode & 0o7777, mode);
      assert.deepEqual(await readdir(shared), []);
    }
    const existing = join(directory, 'existing');
    await mkdir(existing);
    await chmod(existing, 0o700);
    await new FileCredentialStore(join(existing, 'chatgpt.json')).save({ ext_agent_host_id: 'urn:uuid:host' });
    assert.equal((await stat(join(existing, 'chatgpt.json'))).mode & 0o777, 0o600);
    const nested = join(directory, 'created', 'nested');
    await new FileCredentialStore(join(nested, 'chatgpt.json')).save({ ext_agent_host_id: 'urn:uuid:host' });
    assert.equal((await stat(nested)).mode & 0o777, 0o700);
    assert.equal((await stat(join(nested, 'chatgpt.json'))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('refresh rejects terminal OAuth failures without reflecting token values', async () => {
  const dependencies = { fetch: (async (url, init) => String(url).includes('oauth/token') ? new Response(JSON.stringify(tokens())) : fetchJwks(url, init)) as typeof fetch, clock };
  const record = await exchangeCode(attempt, { code: 'code', clientId: 'oaiapp_test' }, dependencies);
  for (const code of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client']) {
    await assert.rejects(refreshCredentials(record, { clock, fetch: async () => new Response(JSON.stringify({ error: code, error_description: 'SECRET_REFRESH' }), { status: 400 }) }), error => String(error).includes(code) && !String(error).includes('SECRET'));
  }
  const refreshed = await refreshCredentials(record, { clock, fetch: async () => {
    const { id_token: _idToken, ...replacement } = tokens();
    return new Response(JSON.stringify({ ...replacement, access_token: 'ROTATED_ACCESS', refresh_token: 'ROTATED_REFRESH', scope: 'openid' }));
  } });
  assert.equal(refreshed.id_token, record.id_token);
  assert.equal(refreshed.access_token, 'ROTATED_ACCESS');
  assert.equal(refreshed.refresh_token, 'ROTATED_REFRESH');
  assert.equal(refreshed.plan_usage, 'identity only, plan usage not granted');
});
test('refresh refuses to substitute another identity and ID-token errors contain no raw token', async () => {
  const dependencies = { fetch: (async (url, init) => String(url).includes('oauth/token') ? new Response(JSON.stringify(tokens())) : fetchJwks(url, init)) as typeof fetch, clock };
  const record = await exchangeCode(attempt, { code: 'code', clientId: 'oaiapp_test' }, dependencies);
  await assert.rejects(refreshCredentials(record, { clock, fetch: async (url, init) => String(url).includes('oauth/token') ? new Response(JSON.stringify({ ...tokens(), id_token: jwt({ sub: 'other' }) })) : fetchJwks(url, init) }), /identity/);
  await assert.rejects(validateIdToken('SECRET_ID_TOKEN', { fetch: fetchJwks, clock, clientId: 'oaiapp_test', nonce: attempt.nonce }), error => !String(error).includes('SECRET'));
});
test('file store fails closed on malformed credentials without exposing their contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weave-auth-invalid-'));
  try {
    const store = new FileCredentialStore(join(directory, 'chatgpt.json'));
    const dependencies = { fetch: (async (url, init) => String(url).includes('oauth/token') ? new Response(JSON.stringify(tokens())) : fetchJwks(url, init)) as typeof fetch, clock };
    const record = await exchangeCode(attempt, { code: 'code', clientId: 'oaiapp_test' }, dependencies);
    const state = { ext_agent_host_id: attempt.hostId, credentials: record, registration: { client_id: record.client_id, subject: record.subject } };
    await store.save(state);
    assert.deepEqual(await store.load(), state);
    for (const replacement of [{ access_token: null }, { expires_in: -1 }, { saved_at: 'SECRET_BAD_DATE' }, { ext_agent_host_id: 'another host' }, { scopes: [null] }, { plan_usage: 'plan usage forbidden' }]) {
      await store.save({ ...state, credentials: { ...record, ...replacement } } as unknown as typeof state);
      await assert.rejects(store.load(), error => !String(error).includes('SECRET'));
    }
    await store.save({ ext_agent_host_id: attempt.hostId, registration: state.registration });
    assert.deepEqual((await store.load())?.registration, state.registration);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('identity-only exchange without refresh token survives file store round trip and cannot refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weave-auth-identity-'));
  try {
    const { refresh_token: _refreshToken, ...response } = tokens();
    const dependencies = { clock, fetch: (async (url, init) => String(url).includes('oauth/token')
      ? new Response(JSON.stringify({ ...response, scope: 'openid profile email' }))
      : fetchJwks(url, init)) as typeof fetch };
    const record = await exchangeCode(attempt, { code: 'code', clientId: 'oaiapp_test' }, dependencies);
    assert.equal(record.plan_usage, 'identity only, plan usage not granted');
    assert.equal(record.refresh_token, undefined);
    const store = new FileCredentialStore(join(directory, 'chatgpt.json'));
    const state = { ext_agent_host_id: attempt.hostId, credentials: record };
    await store.save(state);
    assert.deepEqual(await store.load(), state);
    await assert.rejects(refreshCredentials(record, { clock, fetch: async () => {
      assert.fail('refresh must fail before fetching');
    } }), error => error instanceof ChatGPTAuthError && error.code === 'refresh unavailable');
    await store.save({ ...state, credentials: { ...record, scopes: [...record.scopes, 'offline_access'] } });
    await assert.rejects(store.load(), /credential store read failed/);
    await assert.rejects(exchangeCode(attempt, { code: 'code', clientId: 'oaiapp_test' }, {
      clock, fetch: async () => new Response(JSON.stringify({ ...response, scope: 'openid offline_access' })),
    }), /invalid token response/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('OIDC audience arrays bind the client and require azp for multiple audiences', async () => {
  const options = { fetch: fetchJwks, clock, clientId: 'oaiapp_test' };
  for (const audience of [{ aud: ['oaiapp_test'] }, { aud: ['other', 'oaiapp_test'], azp: 'oaiapp_test' }]) {
    assert.equal((await validateIdToken(jwt(audience), options)).subject, 'subject');
  }
  for (const audience of [{ aud: [] }, { aud: ['other'] }, { aud: ['other', 'oaiapp_test'] }, { aud: ['oaiapp_test', 'other'], azp: 'other' }, { aud: ['oaiapp_test', 123], azp: 'oaiapp_test' }]) {
    await assert.rejects(validateIdToken(jwt(audience), options), /audience/);
  }
});

test('token failures pass through bounded OAuth codes and status without descriptions', async () => {
  for (const code of ['unauthorized_client', 'registration_required', 'a'.repeat(64), 'a'.repeat(65), 'SECRET_TOKEN', 'invalid-grant', '', null]) {
    const expected = typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'token exchange rejected';
    await assert.rejects(exchangeCode(attempt, { code: 'SECRET_CODE', clientId: 'oaiapp_test' }, {
      clock, fetch: async () => new Response(JSON.stringify({ error: code, error_description: 'SECRET_DESCRIPTION' }), { status: 403 }),
    }), error => error instanceof ChatGPTAuthError && error.code === expected && error.status === 403 && !error.message.includes('SECRET'));
  }
});

test('file store loads registration before subject is known and rejects invalid subjects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weave-registration-'));
  try {
    const store = new FileCredentialStore(join(directory, 'chatgpt.json'));
    const state = { ext_agent_host_id: attempt.hostId, registration: { client_id: 'oaiapp_test' } };
    await store.save(state as Parameters<typeof store.save>[0]);
    assert.deepEqual(await store.load(), state);
    for (const registration of [{ client_id: 'dynamic_agent_client' }, { client_id: '' }, { client_id: 'oaiapp_test', subject: '' }, { client_id: 'oaiapp_test', subject: null }, { client_id: 'oaiapp_test', subject: 123 }]) {
      await store.save({ ...state, registration } as Parameters<typeof store.save>[0]);
      await assert.rejects(store.load(), /credential store read failed/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
