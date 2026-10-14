/** Operator-invoked live evidence; never run as part of verify. */
import { writeFile } from 'node:fs/promises';
import { refreshCredentials, planUsageStatus, ChatGPTAuthError } from '@weave/auth-chatgpt';
import { FileCredentialStore } from '@weave/auth-chatgpt/file-store';
import { cliOptions, withCredentialLock, redactTokens } from './chatgpt-local.ts';

type ProbeRecord = { endpoint: string; status: number | null; body: string; request_id?: string | null; interrupted?: boolean };
async function main() {
  const options = cliOptions(false);
  if (!options.out) throw new Error('Pass --out <path> to record probe evidence.');
  const records: ProbeRecord[] = [];
  await withCredentialLock(options.credentials!, async () => {
    const store = new FileCredentialStore(options.credentials!);
    const saved = await store.load();
    if (!saved?.credentials) throw new Error('auth_required: run npm run example:chatgpt-signin first.');
    let credentials = saved.credentials;
    const tokens = [credentials.access_token, credentials.refresh_token, credentials.id_token];
    if (Date.now() >= Date.parse(credentials.saved_at) + credentials.expires_in * 1000) {
      try {
        credentials = await refreshCredentials(credentials, { fetch, clock: { now: () => Date.now() } });
        await store.save({ ...saved, credentials });
      } catch (error) {
        // Terminal refresh errors clear unusable tokens; temporary failures preserve them.
        if (error instanceof ChatGPTAuthError && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.code)) {
          await store.save({ ext_agent_host_id: saved.ext_agent_host_id, registration: { client_id: credentials.client_id, subject: credentials.subject } });
        }
        throw error;
      }
      tokens.push(credentials.access_token, credentials.refresh_token, credentials.id_token);
    }
    if (planUsageStatus(credentials.scopes) !== 'plan usage granted') throw new Error('identity only, plan usage not granted');
    console.log(JSON.stringify({ account: credentials.email ?? credentials.subject, client_id: credentials.client_id }));
    const request = async (endpoint: string, body?: unknown): Promise<string | undefined> => {
      try {
        const response = await fetch(`https://api.openai.com/v1/${endpoint}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${credentials.access_token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(120000),
        });
        // Retain raw SSE as evidence; HTTP 200 alone is not inference success.
        let raw = '';
        let interrupted = false;
        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) { const chunk = await reader.read(); if (chunk.done) break; raw += decoder.decode(chunk.value, { stream: true }); }
            raw += decoder.decode();
          } catch { interrupted = true; }
          finally { reader.releaseLock(); }
        }
        const record = { endpoint, status: response.status, body: redactTokens(raw, tokens), interrupted, request_id: redactTokens(response.headers.get('x-request-id') ?? '', tokens) };
        records.push(record);
        console.log(`${endpoint}: HTTP ${record.status}`);
        process.stdout.write(record.body + (record.body.endsWith('\n') ? '' : '\n'));
        if (interrupted) console.log(`${endpoint}: interrupted response body`);
        return raw;
      } catch {
        const record = { endpoint, status: null, body: 'Transport failed before response headers.' };
        records.push(record); console.log(`${endpoint}: ${record.body}`);
        return undefined;
      }
    };
    const modelsBody = await request('models');
    let models: { slug: string; visibility: string }[] = [];
    try {
      const parsed: unknown = JSON.parse(modelsBody ?? '');
      if (typeof parsed === 'object' && parsed !== null && 'models' in parsed && Array.isArray(parsed.models)) {
        models = parsed.models.filter((m): m is { slug: string; visibility: string } => typeof m === 'object' && m !== null && m.visibility === 'list' && typeof m.slug === 'string');
      }
    } catch { /* Preserve the raw error body above; do not invent model slugs. */ }
    console.log(JSON.stringify({ count: models.length, models: models.map(({ slug, visibility }) => ({ slug: redactTokens(slug, tokens), visibility })) }));
    if (models[0]) {
      await request('responses', { model: models[0].slug, input: [{ role: 'user', content: 'Say exactly: Hello, world!' }], store: false, stream: true });
    } else {
      records.push({ endpoint: 'responses', status: null, body: 'Skipped: no model with visibility=list was returned.' });
      console.log('responses: skipped; no listed model.');
    }
    await request('decisions', {
      model: 'gpt-6-luna', input: 'I was charged twice for my order.',
      questions: [{ type: 'choice', name: 'department', instructions: 'Which department should handle this complaint?', choices: [
        { value: 'billing', description: 'Payments, invoices, and refunds.' },
        { value: 'technical', description: 'Problems using the product.' },
        { value: 'shipping', description: 'Delivery and tracking.' },
        { value: 'other', description: 'Requests outside these categories.' },
      ] }],
    });
    await writeFile(options.out!, JSON.stringify({ account: redactTokens(credentials.email ?? credentials.subject, tokens), client_id: redactTokens(credentials.client_id, tokens), models: models.map(({ slug, visibility }) => ({ slug: redactTokens(slug, tokens), visibility })), count: models.length, probes: records }, null, 2) + '\n', { mode: 0o600 });
  });
}
main().catch(() => { console.error('Probe failed. Check sign-in, plan grant, network, --out, and credential-file access.'); process.exitCode = 1; });
