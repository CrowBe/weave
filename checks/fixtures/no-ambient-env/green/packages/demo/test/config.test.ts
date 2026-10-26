// Tests are not package source; a test may read the environment.
export const optIn = process.env['DEMO_LIVE'] === '1';
