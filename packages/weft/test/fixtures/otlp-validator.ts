/** Offline structural validator for the OTLP/HTTP JSON trace subset W6 emits.
 * Based on opentelemetry/proto trace/v1/trace.proto and common/v1/common.proto:
 * protobuf JSON uses lowerCamelCase, hex identifiers and decimal-string uint64.
 * This deliberately accepts only the adapter's subset, not every OTLP message.
 */
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Obj, required: string[], optional: string[] = []) => required.every((k) => k in v) && Object.keys(v).every((k) => [...required, ...optional].includes(k));
const array = (v: unknown, check: (v: unknown) => boolean): boolean => Array.isArray(v) && v.every(check);
const hex = (v: unknown, length: number) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(v) && /[1-9a-f]/.test(v);
const uint64 = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= 18446744073709551615n;
function anyValue(v: unknown): boolean {
  if (!object(v) || Object.keys(v).length !== 1) return false;
  if ('stringValue' in v) return typeof v.stringValue === 'string';
  if ('boolValue' in v) return typeof v.boolValue === 'boolean';
  if ('intValue' in v) return typeof v.intValue === 'string' && /^-?(0|[1-9][0-9]*)$/.test(v.intValue) && BigInt(v.intValue) >= -9223372036854775808n && BigInt(v.intValue) <= 9223372036854775807n;
  if ('doubleValue' in v) return typeof v.doubleValue === 'number' && Number.isFinite(v.doubleValue);
  if ('arrayValue' in v) return object(v.arrayValue) && keys(v.arrayValue, ['values']) && array(v.arrayValue.values, anyValue);
  if ('kvlistValue' in v) return object(v.kvlistValue) && keys(v.kvlistValue, ['values']) && attributes(v.kvlistValue.values);
  return false;
}
function attributes(v: unknown): boolean {
  if (!array(v, (entry) => object(entry) && keys(entry, ['key', 'value']) && typeof entry.key === 'string' && anyValue(entry.value))) return false;
  const names = (v as Obj[]).map((entry) => entry.key);
  return new Set(names).size === names.length;
}
function link(v: unknown): boolean {
  return object(v) && keys(v, ['traceId', 'spanId', 'attributes']) && hex(v.traceId, 32) && hex(v.spanId, 16) && attributes(v.attributes);
}
function span(v: unknown): boolean {
  return object(v) && keys(v, ['traceId', 'spanId', 'name', 'kind', 'startTimeUnixNano', 'endTimeUnixNano', 'attributes', 'links', 'status'], ['parentSpanId']) &&
    hex(v.traceId, 32) && hex(v.spanId, 16) && (!('parentSpanId' in v) || hex(v.parentSpanId, 16)) &&
    typeof v.name === 'string' && v.name.length > 0 && [1, 3].includes(v.kind as number) &&
    uint64(v.startTimeUnixNano) && uint64(v.endTimeUnixNano) && BigInt(v.startTimeUnixNano) <= BigInt(v.endTimeUnixNano) &&
    attributes(v.attributes) && array(v.links, link) && object(v.status) && keys(v.status, ['code']) && [0, 2].includes(v.status.code as number);
}
export function validOtlpTrace(v: unknown): boolean {
  return object(v) && keys(v, ['resourceSpans']) && array(v.resourceSpans, (rs) =>
    object(rs) && keys(rs, ['resource', 'scopeSpans']) && object(rs.resource) && keys(rs.resource, ['attributes']) && attributes(rs.resource.attributes) &&
    array(rs.scopeSpans, (ss) => object(ss) && keys(ss, ['scope', 'spans']) && object(ss.scope) && keys(ss.scope, ['name', 'version']) &&
      typeof ss.scope.name === 'string' && typeof ss.scope.version === 'string' && array(ss.spans, span)));
}
