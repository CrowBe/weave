// Red: formatted across lines, these still read the environment.
import {
  env,
} from 'node:process';
const {
  env: inherited,
} = process;
export const apiKey = env.API_KEY;
export const endpoint = inherited.ENDPOINT;
