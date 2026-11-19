/**
 * Output bounds for an admitted implementation. A null body, an empty body
 * for a non-empty input, a mid-encoding cut, or an oversize value is failed.
 * The raw oversize bytes are not returned.
 */
import type { CapabilityContract, InvocationOutcome } from '@weave/agentsop';

/** Small enough that an oversize `text.normalize` case is an ordinary test. */
export const NORMALIZE_MAX_BYTES = 64;

export function acceptCapabilityOutput(
  contract: CapabilityContract | null,
  inputs: unknown,
  output: unknown,
): InvocationOutcome {
  if (isRecord(output) && typeof output['failure'] === 'string') {
    return { outcome: 'failed', failure: output['failure'] };
  }
  if (contract?.output['fold'] === 'string') {
    if (isRecord(output) && typeof output['fold'] === 'string') {
      return { outcome: 'succeeded', output: { fold: output['fold'] } };
    }
    return { outcome: 'failed', failure: 'invalid_inspection' };
  }
  if (contract?.id === 'text.normalize') {
    return acceptNormalize(inputs, output);
  }
  return { outcome: 'failed', failure: 'invalid_output' };
}

function acceptNormalize(inputs: unknown, output: unknown): InvocationOutcome {
  if (output === null || output === undefined) {
    return { outcome: 'failed', failure: 'empty_output' };
  }
  if (!isRecord(output) || typeof output['text'] !== 'string') {
    return { outcome: 'failed', failure: 'invalid_output' };
  }
  const text = output['text'];
  if (hasLoneSurrogate(text)) {
    return { outcome: 'failed', failure: 'mid_value' };
  }
  const inputText = isRecord(inputs) && typeof inputs['text'] === 'string' ? inputs['text'] : '';
  if (inputText.length > 0 && text.length === 0) {
    return { outcome: 'failed', failure: 'empty_output' };
  }
  if (Buffer.byteLength(text, 'utf8') > NORMALIZE_MAX_BYTES) {
    return { outcome: 'failed', failure: 'budget' };
  }
  return { outcome: 'succeeded', output: { text } };
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const high = code >= 0xd800 && code <= 0xdbff;
    const low = code >= 0xdc00 && code <= 0xdfff;
    if (low) {
      return true;
    }
    if (high) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
