/**
 * The vocabulary that decides which names carry a credential rather than configuration.
 *
 * Two questions need one answer: "should this value be redacted?" and "may this value become
 * Account-shared configuration?" The list mirrors the credential-carrying part of
 * `SENSITIVE_KEY_PARTS` in `packages/shared/src/structured-errors.ts`, so a name the product already
 * redacts in a log cannot become shareable just because it arrived in a pasted MCP configuration.
 *
 * `sensitive-names.test.ts` pins the mirror by reading that array out of the shared source, so a term
 * added there fails the test until it is mirrored here or listed as structural-only. It also pins the
 * two deliberate ways this predicate is wider than the redactor, which is the safe direction: the
 * structural names that are not credentials, and the separatorless lowercase spellings a paste may
 * produce, which the redactor's key matching does not fold.
 */
export const CREDENTIAL_NAME_PARTS = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "credential",
  "password",
  "passwd",
  "api_key",
  "apikey",
  "bearer_key",
  "access_key",
  "refresh_key",
  "private_key",
] as const;

/**
 * The shared vocabulary's parts that are sensitive to log but are not credentials.
 *
 * `body`, `payload`, `prompt`, and the tool/request/response variants describe *structural* content.
 * A Server may legitimately want a header of that name, and refusing it would drop configuration that
 * has nothing to do with a credential.
 */
export const STRUCTURAL_ONLY_NAME_PARTS = [
  "request_body",
  "response_body",
  "body",
  "payload",
  "prompt",
  "tool_input",
  "tool_output",
] as const;

/**
 * Fold every separator convention onto underscores, including camelCase, exactly as the shared
 * redactor folds a key. The split runs before lowercasing because afterwards there is no case boundary
 * left to find: `privateKey` would fold to `privatekey` and match nothing.
 */
export function foldCredentialName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
}

/**
 * Whether a name carries a credential.
 *
 * HTTP header names are case-insensitive, so a paste may arrive as `X-PrivateKey`, `X-Private-Key`,
 * `x_private_key`, or `x-privatekey`, and classification cannot depend on which spelling survived.
 * Every part is therefore matched in both its separated and its separatorless form, over the folded
 * name and the fully collapsed one. Case is still folded the way the shared redactor folds it, so a
 * camelCase boundary is used when it is there and a name that had already lost it still matches.
 */
export function isCredentialName(name: string): boolean {
  const folded = foldCredentialName(name.trim());
  const collapsed = folded.replaceAll("_", "");
  return CREDENTIAL_NAME_PARTS.some((part) => folded.includes(part) || collapsed.includes(part.replaceAll("_", "")));
}
