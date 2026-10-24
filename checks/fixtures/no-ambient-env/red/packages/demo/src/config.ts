// Red fixture for checks/no-ambient-env.mjs: each read below is a finding.
import { env } from 'node:process';

export const apiKey = process.env['DEMO_API_KEY'];
export const baseURL = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:8080';
const { DEMO_MODEL } = process.env;
export const model = DEMO_MODEL;
export const region = env['DEMO_REGION'];
