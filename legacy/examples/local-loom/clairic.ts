export interface NativeExtractionRequest {
  readonly request_id: string;
  readonly site: string;
  readonly state: string;
  readonly fields: Readonly<Record<string, string>>;
}
export interface NativeExtractionBase {
  readonly request_id: string;
  readonly site: string;
  readonly spent: number;
  readonly attempts: readonly { model: string; cost: number; disposition: { status: string } }[];
}
export type NativeExtractionOutcome = NativeExtractionBase &
  (
    | {
        readonly status: 'accepted';
        readonly values: Readonly<Record<string, string | null>>;
        readonly routed_unit_id: string;
        readonly evidence: unknown;
      }
    | { readonly status: 'blocked'; readonly reason: string }
  );
export type NativeExtractor = (
  request: NativeExtractionRequest,
  signal?: AbortSignal,
) => Promise<NativeExtractionOutcome>;
interface ClairicBody {
  model: string;
  state: string;
  fields: Record<string, { type: string; instructions: string }>;
}
async function runCf(body: ClairicBody, signal?: AbortSignal): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'loom-clairic-'));
  try {
    const file = join(directory, 'input.json');
    await writeFile(file, JSON.stringify(body), { mode: 0o600 });
    const text = await new Promise<string>((resolve, reject) => {
      execFile(
        'cf',
        ['ai', 'run', '@cf/cloudflare/clairic', '--body', '@' + file],
        {
          timeout: 60_000,
          maxBuffer: 2_000_000,
          ...(signal ? { signal } : {}),
        },
        (error, stdout) => (error ? reject(new Error('Clairic CLI request failed.')) : resolve(stdout)),
      );
    });
    return JSON.parse(text) as unknown;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function clairicExtractor(
  options: { run?: (body: ClairicBody, signal?: AbortSignal) => Promise<unknown> } = {},
): NativeExtractor {
  return async (request, signal) => {
    const raw = await (options.run ?? runCf)(
      {
        model: 'clairic',
        state: request.state,
        fields: Object.fromEntries(
          Object.entries(request.fields).map(([name, instructions]) => [name, { type: 'text', instructions }]),
        ),
      },
      signal,
    );
    if (
      !object(raw) ||
      !object(raw.usage) ||
      !Number.isSafeInteger(raw.usage.input_tokens) ||
      (raw.usage.input_tokens as number) < 0 ||
      raw.usage.output_tokens !== 0
    )
      throw new Error('Clairic returned invalid usage.');
    // $0.10 / million input tokens; usage includes every billed pass. No generated tokens.
    const spent = Math.ceil((raw.usage.input_tokens as number) / 10);
    const base: NativeExtractionBase = {
      request_id: request.request_id,
      site: request.site,
      spent,
      attempts: [{ model: '@cf/cloudflare/clairic', cost: spent, disposition: { status: 'accepted' } }],
    };
    const reject = (reason: string): NativeExtractionOutcome => ({ ...base, status: 'blocked', reason });
    if (raw.truncated !== false || !object(raw.answers)) return reject('truncated_or_invalid_extraction');
    const values: Record<string, string | null> = {};
    for (const name of Object.keys(request.fields)) {
      const answer = raw.answers[name];
      if (!object(answer) || answer.type !== 'text') return reject('invalid_extraction_answer');
      if (answer.value === null) {
        values[name] = null;
        continue;
      }
      const span = answer.span;
      if (
        typeof answer.value !== 'string' ||
        !Array.isArray(span) ||
        span.length !== 2 ||
        !span.every(Number.isSafeInteger) ||
        span[0] < 0 ||
        span[1] <= span[0]
      )
        return reject('invalid_extraction_span');
      const original = request.state;
      // Providers may count Unicode code points rather than JS UTF-16 code units.
      const codepoints = [...original];
      const utf16Match = span[1] <= original.length && original.slice(span[0], span[1]) === answer.value;
      const codepointMatch =
        span[1] <= codepoints.length && codepoints.slice(span[0], span[1]).join('') === answer.value;
      if (!utf16Match && !codepointMatch) return reject('ungrounded_extraction');
      values[name] = answer.value;
    }
    return {
      ...base,
      status: 'accepted',
      routed_unit_id: 'cloudflare.clairic',
      values,
      evidence: { model: raw.model, answers: raw.answers, usage: raw.usage, truncated: raw.truncated },
    };
  };
}
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
