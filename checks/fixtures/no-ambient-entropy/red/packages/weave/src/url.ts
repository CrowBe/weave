// Red: a `//` inside a string or a template is text, so the draw after it is real.
import { randomUUID } from 'node:crypto';
export const id = 'https://example.test/' + randomUUID();
export const run = `see // the log ${Math.random()}`;
export const nested = `outer ${`inner // ${crypto.getRandomValues(new Uint8Array(4))}`}`;
/* a later comment */ export const tail = 'a//b' + Math.random();
