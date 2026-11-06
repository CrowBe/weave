export async function run(input: unknown, port: unknown, now: () => unknown) {
  await evaluateSite('input.route', input, port, now);
  const intake = transitionSite('intake.classify', input, recorded, now);
  const progress = evaluateSite('loop.continue', input, port, now);
  return { intake, progress };
}
