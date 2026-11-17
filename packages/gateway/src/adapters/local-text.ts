/** Loopback text generation; installation and model selection belong to the operator. */
import { openAiCompatibleAdapter } from './openai-compatible.js';
import type { GenerationAdapter } from '../types.js';

export function localTextAdapter(options: {
  readonly baseURL: string;
  readonly fetch?: typeof globalThis.fetch;
}): GenerationAdapter {
  const url = new URL(options.baseURL);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Local text endpoint must be a loopback HTTP URL.');
  return openAiCompatibleAdapter(
    { id: 'local-text', defaultBaseURL: options.baseURL },
    { apiKey: 'local', baseURL: options.baseURL, ...(options.fetch ? { fetch: options.fetch } : {}) },
    'localTextAdapter',
  );
}
