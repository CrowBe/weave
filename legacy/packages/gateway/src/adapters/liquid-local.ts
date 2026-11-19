/** Native local Liquid d1 decisions over llama.cpp's System One wire. */
import { evaluationTransport } from './decision-transport.js';
import { typesafeWireProfile } from './typesafe-ai.js';
import type { EvaluationAdapter } from '../types.js';

export function liquidLocalEvaluator(options: {
  readonly baseURL: string;
  readonly fetch?: typeof globalThis.fetch;
}): EvaluationAdapter {
  const url = new URL(options.baseURL);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('Local Liquid decision endpoint must be a loopback HTTP origin.');
  return evaluationTransport(
    { ...typesafeWireProfile(), id: 'liquid-local' },
    {
      credential: 'local',
      placeholder: true,
      defaultBaseURL: options.baseURL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  );
}
