// Red fixture for checks/no-ambient-env.mjs: the environment taken whole from `process`.
const { env } = process;

export const home = env['HOME'];
