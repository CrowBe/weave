/**
 * Smoke test for the Vercel AI Gateway credential and model access.
 *
 * This is the raw AI SDK call, deliberately unmediated: it proves the account,
 * the key and the model, and nothing about Weave. The architecture-shaped path
 * — a bounded request under explicit terms — is `examples/holiday.ts`.
 *
 *   npm run example
 */
import { generateText } from 'ai';

// gpt-5.5 needs paid AI Gateway credits; override to run on a free-tier key.
const MODEL = process.env.AI_MODEL ?? 'openai/gpt-5.5';

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error('AI_GATEWAY_API_KEY is not set. Put it in .env.local (git-ignored) and rerun `npm run example`.');
  process.exit(1);
}

const { text, usage } = await generateText({
  model: MODEL,
  prompt: 'Invent a new holiday and describe its traditions.',
});

console.log(text);
console.log(`\n[${MODEL}] in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'} tokens`);
