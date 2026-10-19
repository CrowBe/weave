/**
 * The credential screen Weft applies at token starts. `Bearer` counts only
 * when whitespace follows it, as in an authorization header, so an ordinary id
 * such as `bearer_x` is not a credential (#158). Ids cannot hold whitespace;
 * the token after `Bearer ` is still caught by its own marker.
 */
const CREDENTIAL = /(?<![A-Za-z0-9])(?:sk[-_]|Bearer\s+|eyJ|gh[pousr]_|github_pat_|AKIA)/i;

export const hasCredential = (text: string): boolean => CREDENTIAL.test(text);
