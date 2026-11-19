// Red fixture: optional chaining on process still reads the environment.
export const token = process?.env.DEMO_TOKEN;
export const zone = process?.['env'].DEMO_ZONE;
