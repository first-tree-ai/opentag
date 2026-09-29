/**
 * The vocabulary that decides which names carry a credential rather than configuration.
 *
 * Two questions need one answer: "should this value be redacted?" and "may this value become
 * Account-shared configuration?" A name the product redacts in a log must not become shareable just
 * because it arrived in a pasted MCP configuration, so the MCP import reads the list here instead of
 * keeping one of its own.
 *
 * The list mirrors the credential-carrying part of `SENSITIVE_KEY_PARTS` in
 * `packages/shared/src/structured-errors.ts`, which is not exported as a constant.
 * `sensitive-names.test.ts` pins the mirror by asking the shared `redactSensitive()` to redact a value
 * under every name listed here: a name dropped from the repository's vocabulary fails that test rather
 * than silently leaving a paste's secret shareable.
 *
 * The structural parts of that list — `body`, `payload`, `prompt`, `tool_input`, `tool_output`, and
 * their request/response variants — are deliberately absent. They are sensitive to log, but they are
 * not credentials, and refusing a header named for one would drop configuration a Server may need.
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

/** Whether a name carries a credential, judged by containment the way the shared redactor judges keys. */
export function isCredentialName(name: string): boolean {
  const folded = foldCredentialName(name.trim());
  return CREDENTIAL_NAME_PARTS.some((part) => folded.includes(part));
}
