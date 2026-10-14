import { createHash, randomBytes, randomUUID, createPublicKey, verify } from 'node:crypto';

export const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export interface Clock { now(): number }
export interface AuthDependencies { fetch: typeof fetch; clock: Clock }
export interface AuthorizationAttempt {
  state: string; nonce: string; verifier: string; redirectUri: string;
  hostId: string; clientId?: string; subject?: string;
}
export interface Identity { subject: string; issuer: string; email?: string }
export type PlanUsageStatus = 'plan usage granted' | 'identity only, plan usage not granted';
export interface Credentials extends Identity {
  client_id: string; ext_agent_host_id: string; access_token: string; refresh_token: string;
  id_token: string; token_type: 'Bearer'; expires_in: number; saved_at: string;
  scopes: string[]; plan_usage: PlanUsageStatus; earliest_refresh_at?: number;
}
export interface CredentialState { ext_agent_host_id: string; credentials?: Credentials; registration?: { client_id: string; subject: string } }
export interface CredentialStore { load(): Promise<CredentialState | undefined>; save(state: CredentialState): Promise<void> }
export class ChatGPTAuthError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(`ChatGPT authentication: ${code}`); this.name = 'ChatGPTAuthError'; }
}
function fail(code: string): never { throw new ChatGPTAuthError(code); }
export async function ensureHostId(store: CredentialStore): Promise<string> {
  const current = await store.load();
  if (current) return current.ext_agent_host_id;
  const hostId = `urn:uuid:${randomUUID()}`;
  await store.save({ ext_agent_host_id: hostId });
  return hostId;
}
export function createAuthorizationAttempt(options: { port: number; hostId: string; clientId?: string; subject?: string }): AuthorizationAttempt {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) fail('invalid loopback port');
  if (!options.hostId || options.clientId === 'dynamic_agent_client') fail('invalid registration');
  return { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), redirectUri: `http://127.0.0.1:${options.port}/auth/callback`, hostId: options.hostId, ...(options.clientId ? { clientId: options.clientId } : {}), ...(options.subject ? { subject: options.subject } : {}) };
}
export function buildAuthorizeUrl(attempt: AuthorizationAttempt): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({ client_id: attempt.clientId ?? 'dynamic_agent_client', ...(attempt.clientId ? {} : { agent_name_hint: 'Weave' }), ext_agent_host_id: attempt.hostId, response_type: 'code', redirect_uri: attempt.redirectUri, scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url') }).toString();
  return url.toString();
}
export function handleCallback(requestUrl: string, attempt: AuthorizationAttempt): { code: string; clientId: string } {
  let url: URL;
  try { url = new URL(requestUrl); } catch { return fail('invalid callback'); }
  const expected = new URL(attempt.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) fail('invalid callback');
  for (const key of ['state', 'error', 'code', 'client_id']) if (url.searchParams.getAll(key).length > 1) fail('ambiguous callback');
  if (url.searchParams.get('state') !== attempt.state) fail('state mismatch');
  if (url.searchParams.has('error')) fail(url.searchParams.get('error') === 'access_denied' ? 'access_denied' : 'authorization rejected');
  const clientId = url.searchParams.get('client_id') ?? attempt.clientId;
  if (!clientId || clientId === 'dynamic_agent_client' || (attempt.clientId && clientId !== attempt.clientId)) fail('invalid issued client_id');
  const code = url.searchParams.get('code');
  if (!code) fail('missing authorization code');
  return { code, clientId };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid response');
  return value as Record<string, unknown>;
}
async function safeFetch(fetcher: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  try { return await fetcher(url, init); } catch { return fail('network failure'); }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  try { return object(await response.json()); } catch { return fail('invalid response'); }
}
export async function validateIdToken(token: string, options: AuthDependencies & { clientId: string; nonce?: string }): Promise<Identity> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) fail('invalid ID token');
    const header = object(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()));
    const claims = object(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') fail('invalid ID token algorithm');
    const response = await safeFetch(options.fetch, JWKS_URL);
    if (!response.ok) throw new ChatGPTAuthError('JWKS unavailable', response.status);
    const jwks = await json(response);
    if (!Array.isArray(jwks.keys)) fail('invalid JWKS');
    const keys = jwks.keys.filter((value: unknown) => { const key = object(value); return key.kid === header.kid && key.kty === 'RSA' && (key.alg === undefined || key.alg === 'RS256') && (key.use === undefined || key.use === 'sig'); });
    if (keys.length !== 1) fail('unknown ID token signing key');
    const key = createPublicKey({ key: keys[0]!, format: 'jwk' });
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))) fail('invalid ID token signature');
    if (claims.iss !== 'https://auth.openai.com') fail('invalid ID token issuer');
    if (claims.aud !== options.clientId) fail('invalid ID token audience');
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= options.clock.now() / 1000) fail('expired ID token');
    if (options.nonce !== undefined && claims.nonce !== options.nonce) fail('invalid ID token nonce');
    if (typeof claims.sub !== 'string' || !claims.sub) fail('invalid ID token subject');
    return { subject: claims.sub, issuer: claims.iss, ...(typeof claims.email === 'string' ? { email: claims.email } : {}) };
  } catch (error) { if (error instanceof ChatGPTAuthError) throw error; return fail('invalid ID token'); }
}
export function planUsageStatus(scopes: readonly string[]): PlanUsageStatus { return scopes.includes('chatgpt.tokens.use.direct') ? 'plan usage granted' : 'identity only, plan usage not granted'; }
const TOKEN_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client']);
async function requestTokens(form: Record<string, string>, dependencies: AuthDependencies): Promise<Record<string, unknown>> {
  const response = await safeFetch(dependencies.fetch, TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  const body = await json(response);
  if (!response.ok) throw new ChatGPTAuthError(typeof body.error === 'string' && TOKEN_ERRORS.has(body.error) ? body.error : 'token exchange rejected', response.status);
  if (typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token || body.token_type !== 'Bearer' || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || typeof body.scope !== 'string') fail('invalid token response');
  return body;
}
function credentialRecord(body: Record<string, unknown>, identity: Identity, clientId: string, hostId: string, idToken: string, clock: Clock): Credentials {
  const scopes = (body.scope as string).split(/\s+/).filter(Boolean);
  return { ...identity, client_id: clientId, ext_agent_host_id: hostId, access_token: body.access_token as string, refresh_token: body.refresh_token as string, id_token: idToken, token_type: 'Bearer', expires_in: body.expires_in as number, saved_at: new Date(clock.now()).toISOString(), scopes, plan_usage: planUsageStatus(scopes), ...(typeof body.earliest_refresh_at === 'number' ? { earliest_refresh_at: body.earliest_refresh_at } : {}) };
}
export async function exchangeCode(attempt: AuthorizationAttempt, callback: { code: string; clientId: string }, dependencies: AuthDependencies): Promise<Credentials> {
  if (!callback.clientId || callback.clientId === 'dynamic_agent_client' || (attempt.clientId && callback.clientId !== attempt.clientId)) fail('invalid issued client_id');
  const body = await requestTokens({ grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }, dependencies);
  if (typeof body.id_token !== 'string') fail('missing ID token');
  const identity = await validateIdToken(body.id_token, { ...dependencies, clientId: callback.clientId, nonce: attempt.nonce });
  if (attempt.subject && identity.subject !== attempt.subject) fail('account identity mismatch');
  return credentialRecord(body, identity, callback.clientId, attempt.hostId, body.id_token, dependencies.clock);
}
/** Caller serializes refresh and saves the complete replacement atomically. */
export async function refreshCredentials(credentials: Credentials, dependencies: AuthDependencies): Promise<Credentials> {
  const body = await requestTokens({ grant_type: 'refresh_token', client_id: credentials.client_id, refresh_token: credentials.refresh_token, resource: RESOURCE }, dependencies);
  let identity: Identity = { subject: credentials.subject, issuer: credentials.issuer, ...(credentials.email ? { email: credentials.email } : {}) };
  if (body.id_token !== undefined) {
    if (typeof body.id_token !== 'string') fail('invalid ID token');
    identity = await validateIdToken(body.id_token, { ...dependencies, clientId: credentials.client_id });
    if (identity.subject !== credentials.subject) fail('account identity mismatch');
  }
  return credentialRecord(body, identity, credentials.client_id, credentials.ext_agent_host_id, typeof body.id_token === 'string' ? body.id_token : credentials.id_token, dependencies.clock);
}
