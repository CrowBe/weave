export async function prompt(input: unknown, port: unknown, now: () => unknown) {
  const slice = await evaluateBooleanSite('loop.preselect', input, port, now);
  const preselected = slice.preselect;
  return { prompt: preselected };
}
