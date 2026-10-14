/** Resolve credentials at the composition root without reading ambient state. */
export function resolveTypesafeApiKey(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const preferred = env['TYPESAFE_API_KEY'];
  if (preferred !== undefined && preferred.trim().length > 0) return preferred;
  const legacy = env['TYPESAFE_AI_API_KEY'];
  return legacy !== undefined && legacy.trim().length > 0 ? legacy : undefined;
}
