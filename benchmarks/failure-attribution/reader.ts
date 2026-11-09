import { productionReader } from './reader-core.ts';
const reader = productionReader(
  'benchmarks/failure-attribution/fixtures/manifest.json',
  'sha256:e448801e5178055f1ec893443cc9a4b5d2edda5b854171a4fabd4f0c4b1b336b',
);
export type SealedOptions = { sealedLabelPath: string; sealedLabelDigest: string; holdoutSetDigest: string };
export function readTuneArtifact(
  path: string,
  expectedStoredByteDigest?: string,
  ...unexpected: unknown[]
): Uint8Array {
  if (unexpected.length) throw new Error('g7-reader: unsupported options');
  return reader.readArtifact(path, expectedStoredByteDigest);
}
export function readSealedInputs(options: SealedOptions, ...unexpected: unknown[]) {
  if (unexpected.length) throw new Error('g7-reader: unsupported options');
  return reader.readSealed(options);
}

export type SealedInputs = ReturnType<typeof reader.readSealed>;
