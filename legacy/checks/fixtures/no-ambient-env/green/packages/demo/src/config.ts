// Green fixture for checks/no-ambient-env.mjs: configuration arrives from the caller.
/** The caller reads process.env at its root and passes the narrowed values in. */
export interface DemoConfig {
  readonly apiKey: string;
  readonly baseURL: string;
}

export function describe(config: DemoConfig): string {
  // Naming process.env in a comment is not a read.
  return `${config.baseURL}/v1 (key ${config.apiKey.length} chars)`;
}
