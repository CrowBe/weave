export async function run(input: unknown, port: unknown, now: () => unknown, extract: unknown, record: unknown) {
  await evaluateSite('input.route', { ...input, origin: modelOrigin(extract) }, port, now);
  const intake = transitionSite('intake.classify', { ...input, origin: { kind: 'model', extract } }, recorded, now);
  const progress = evaluateSite('loop.continue', { ...input, origin: structuralOrigin('progress.delta@1') }, port, now);
  const other = transitionSite('loop.route', { ...input, origin: modelOrigin(record) }, recorded, now);
  return { intake, progress, other };
}
