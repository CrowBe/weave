/**
 * Resolve trimmed credentials at the composition root without reading ambient state.
 * TYPESAFE_API_KEY wins; legacy TYPESAFE_AI_API_KEY is the fallback.
 * Blank or whitespace-only values count as missing.
 */
export function resolveTypesafeApiKey(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return env['TYPESAFE_API_KEY']?.trim() || env['TYPESAFE_AI_API_KEY']?.trim() || undefined;
}
