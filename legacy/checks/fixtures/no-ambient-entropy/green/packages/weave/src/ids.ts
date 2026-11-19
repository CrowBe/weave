// Green: entropy is only mentioned in comments and template text. Math.random()
/*
 * randomUUID() in a block comment
 */
export const docs = `the runId port replaces randomUUID() and Math.random()`;
export const url = 'https://example.test/run'; // randomBytes(16)
export function fresh(runId: () => string): string {
  return runId();
}
