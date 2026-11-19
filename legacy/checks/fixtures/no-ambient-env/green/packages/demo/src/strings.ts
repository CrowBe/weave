// Green: these only mention the environment inside template text and comments.
export const docs = `
import {
  env,
} from 'node:process';
const {
  env: inherited,
} = process;
`;
/* process.env.IN_A_COMMENT */
export const url = 'https://example.test/process'; // process.env.TRAILING
