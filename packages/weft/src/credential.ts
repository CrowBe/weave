/**
 * The repository's credential markers at token starts, the same markers the
 * gateway screens inference content for (`packages/gateway/src/privacy.ts`).
 * Weft imports nothing in-repo, so it keeps its own copy. `Bearer` counts only
 * when whitespace follows it, as in an authorization header, so an ordinary id
 * such as `bearer_x` is not a credential (#158). Ids cannot hold whitespace;
 * the token after `Bearer ` is still caught by its own marker.
 */
const CREDENTIAL =
  /(?<![A-Za-z0-9])(?:sk[-_]|Bearer\s+|eyJ|gh[pousr]_|github_pat_|AKIA|AIza|xox[abp]-|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/i;

export const hasCredential = (text: string): boolean => CREDENTIAL.test(text);
