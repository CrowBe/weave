/** CLI diagnostics use fixed causes: exception messages can contain credentials or input JSON. */
import { ProbeConfigurationError } from './run.ts';

const CAUSES: Readonly<Record<string, string>> = {
  ENOENT: 'file or directory was not found',
  ENOTDIR: 'a file location contains a component that is not a directory',
  EISDIR: 'expected a file but found a directory',
  EACCES: 'permission denied while accessing a file or directory',
  EPERM: 'operation was not permitted',
  ENOSPC: 'no space available to write results',
  EEXIST: 'output or sidecar already exists',
  ERR_INVALID_CHAR: 'invalid character in an HTTP header',
  ERR_INVALID_HTTP_TOKEN: 'invalid HTTP header name',
};
const NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'URIError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
]);

export function formatProbeError(error: unknown): string {
  const name = error instanceof Error && NAMES.has(error.name) ? error.name : 'Error';
  const rawCode = error instanceof Error && 'code' in error ? error.code : undefined;
  const code =
    rawCode === undefined
      ? 'none'
      : typeof rawCode === 'string' && Object.hasOwn(CAUSES, rawCode)
        ? rawCode
        : 'unknown';
  const message =
    error instanceof ProbeConfigurationError
      ? error.message
      : error instanceof SyntaxError
        ? 'invalid JSON input'
        : (CAUSES[code] ?? 'probe execution failed; check output and recorded results');
  return `${name} (code=${code}): ${message}`;
}
