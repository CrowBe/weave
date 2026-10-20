import { mkdir, chmod, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CredentialState, CredentialStore } from './index.js';
import { ChatGPTAuthError, planUsageStatus } from './index.js';

/** Only composition roots instantiate this filesystem implementation. */
export class FileCredentialStore implements CredentialStore {
  constructor(readonly path: string) {}
  async load(): Promise<CredentialState | undefined> {
    try {
      const state: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!state || typeof state !== 'object' || !('ext_agent_host_id' in state) || typeof state.ext_agent_host_id !== 'string' || !state.ext_agent_host_id) throw new ChatGPTAuthError('invalid credential store');
      const value = state as Record<string, unknown>;
      if (value.registration !== undefined) {
        const registration = value.registration;
        if (!registration || typeof registration !== 'object' || !('client_id' in registration) || typeof registration.client_id !== 'string' || !registration.client_id || registration.client_id === 'dynamic_agent_client' || ('subject' in registration && (typeof registration.subject !== 'string' || !registration.subject))) throw new ChatGPTAuthError('invalid credential store');
      }
      if (value.credentials !== undefined) {
        const credentials = value.credentials;
        if (!credentials || typeof credentials !== 'object') throw new ChatGPTAuthError('invalid credential store');
        const record = credentials as Record<string, unknown>;
        for (const field of ['client_id', 'subject', 'id_token', 'access_token', 'saved_at']) {
          if (typeof record[field] !== 'string' || !record[field]) throw new ChatGPTAuthError('invalid credential store');
        }
        if (record.client_id === 'dynamic_agent_client' || record.issuer !== 'https://auth.openai.com' || record.ext_agent_host_id !== value.ext_agent_host_id || record.token_type !== 'Bearer' || typeof record.expires_in !== 'number' || !Number.isFinite(record.expires_in) || record.expires_in <= 0 || !Number.isFinite(Date.parse(record.saved_at as string)) || !Array.isArray(record.scopes) || record.scopes.some(scope => typeof scope !== 'string') || record.plan_usage !== planUsageStatus(record.scopes as string[]) || (record.email !== undefined && typeof record.email !== 'string') || (record.earliest_refresh_at !== undefined && (typeof record.earliest_refresh_at !== 'number' || !Number.isFinite(record.earliest_refresh_at)))) throw new ChatGPTAuthError('invalid credential store');
        if ((record.scopes as string[]).includes('offline_access') || record.refresh_token !== undefined) {
          if (typeof record.refresh_token !== 'string' || !record.refresh_token) throw new ChatGPTAuthError('invalid credential store');
        }
        if (value.registration !== undefined) {
          const registration = value.registration as { client_id: string; subject?: string };
          if (registration.client_id !== record.client_id || (registration.subject !== undefined && registration.subject !== record.subject)) throw new ChatGPTAuthError('invalid credential store');
        }
      }
      return state as CredentialState;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new ChatGPTAuthError('credential store read failed');
    }
  }
  /** Writes into a directory it created (mode 0700) or an existing one without group or other access. It never chmods an existing directory. */
  async save(state: CredentialState): Promise<void> {
    const directory = dirname(this.path);
    let mode: number;
    try {
      // mkdir returns the first directory it created, or undefined when the path already existed.
      if (await mkdir(directory, { recursive: true, mode: 0o700 }) !== undefined) await chmod(directory, 0o700);
      mode = (await stat(directory)).mode;
    } catch { throw new ChatGPTAuthError('credential store write failed'); }
    if (mode & 0o077) throw new ChatGPTAuthError('credential store directory not private');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.path);
    } catch { throw new ChatGPTAuthError('credential store write failed'); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
}
