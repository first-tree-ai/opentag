import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactSensitive } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_NAME_PARTS,
  foldCredentialName,
  isCredentialName,
  STRUCTURAL_ONLY_NAME_PARTS,
} from "./sensitive-names.js";

const MARKER = "sk-must-not-survive";

/**
 * The shared vocabulary, read from its source.
 *
 * `SENSITIVE_KEY_PARTS` is private to `packages/shared`, so the mirror cannot be imported. Reading the
 * array is what makes the check two-way: a term added there fails this test until this feature mirrors
 * it or lists it as structural-only, instead of silently leaving a pasted secret shareable. Source
 * reading follows the repository's own contract checks, which assert module contents the same way.
 */
function sharedVocabularyParts(): string[] {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../../../packages/shared/src/structured-errors.ts"),
    "utf8",
  );
  const array = /const SENSITIVE_KEY_PARTS = \[([\s\S]*?)\]/.exec(source);
  if (!array) throw new Error("SENSITIVE_KEY_PARTS was not found in packages/shared/src/structured-errors.ts");
  return [...(array[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("credential name vocabulary", () => {
  it("mirrors the shared vocabulary exactly, minus the structural-only parts", () => {
    const shared = sharedVocabularyParts();
    const credential = shared.filter((part) => !(STRUCTURAL_ONLY_NAME_PARTS as readonly string[]).includes(part));
    expect([...CREDENTIAL_NAME_PARTS].sort()).toEqual([...credential].sort());
    // Every exclusion is still a real shared part, so the list cannot quietly grow to hide a gap.
    for (const part of STRUCTURAL_ONLY_NAME_PARTS) expect(shared).toContain(part);
  });

  /**
   * The two consumers answer one question, so a name this list calls a credential must be one the
   * repository's redactor already hides.
   */
  it.each(CREDENTIAL_NAME_PARTS)("mirrors the shared redactor for %s", (part) => {
    expect(JSON.stringify(redactSensitive({ [part]: MARKER }))).not.toContain(MARKER);
  });

  it("leaves context names alone", () => {
    expect(isCredentialName("X-Workspace-Id")).toBe(false);
    expect(isCredentialName("x-goog-user-project")).toBe(false);
    expect(isCredentialName("X-Payload")).toBe(false);
    expect(isCredentialName("X-Request-Body")).toBe(false);
    expect(isCredentialName("X-Tool-Output")).toBe(false);
  });

  /**
   * HTTP header names are case-insensitive, so classification cannot depend on which spelling survived
   * a paste. These are the spellings a real configuration writes.
   */
  it.each([
    "Authorization",
    "authorization",
    "x-client-secret",
    "X-Client-Secret",
    "x_client_secret",
    "X-ClientSecret",
    "X-PrivateKey",
    "X-Private-Key",
    "x-privatekey",
    "x_private_key",
    "X-BearerKey",
    "X-AccessKey",
    "X-RefreshKey",
    "X-Access-Key",
    "X-Refresh-Key",
    "X-Passwd",
    "X-Credential",
    "Cookie",
    "X-ApiKey",
    "X-Api-Key",
    "X-Goog-Api-Key",
  ])("recognizes %s in every separator and casing convention", (name) => {
    expect(isCredentialName(name)).toBe(true);
  });

  it("folds camelCase before the separators are removed", () => {
    expect(foldCredentialName("X-PrivateKey")).toBe("x_private_key");
    expect(foldCredentialName("X-Private-Key")).toBe("x_private_key");
  });

  /**
   * The predicate and the shared redactor must agree everywhere except where this feature deliberately
   * diverges: the structural-only parts. Without this, a name the repository adds to its vocabulary —
   * or a hole in the separator/casing handling — shows up as a pasted secret in Account-shared
   * configuration, which is the exact failure this feature exists to prevent.
   */
  it("agrees with the shared redactor except where a structural name is shared on purpose", () => {
    // `!shared && local` is never excused: refusing something the redactor considers safe is still an
    // inconsistency. `shared && !local` is excused only by a structural-only part.
    const violations = credentialNameCorpus()
      .map((name) => ({ name, shared: sharedRedacts(name), local: isCredentialName(name) }))
      .filter(({ name, shared, local }) => (shared === local ? false : !(shared && !local && isStructuralOnly(name))));
    expect(violations).toEqual([]);
  });

  it("diverges from the shared redactor only for structural-only names", () => {
    const divergences = credentialNameCorpus().filter((name) => sharedRedacts(name) !== isCredentialName(name));
    expect(divergences.filter((name) => !isStructuralOnly(name))).toEqual([]);
    // The exemption is real and deliberate: the redactor hides `payload`, this feature shares it.
    expect(divergences).toContain("x-payload");
  });

  it("never classifies a context name as a credential", () => {
    const falsePositives = credentialNameCorpus().filter(
      (name) => isCredentialName(name) && /workspace|user-project|trace|content-type|^accept$/.test(name),
    );
    expect(falsePositives).toEqual([]);
  });
});

/** The repository redactor's verdict for a value stored under that name. */
function sharedRedacts(name: string): boolean {
  return !JSON.stringify(redactSensitive({ [name]: MARKER })).includes(MARKER);
}

/** Whether a name would be caught by a structural-only part, which this feature shares on purpose. */
function isStructuralOnly(name: string): boolean {
  const folded = foldCredentialName(name);
  const collapsed = folded.replaceAll("_", "");
  return STRUCTURAL_ONLY_NAME_PARTS.some(
    (part) => folded.includes(part) || collapsed.includes(part.replaceAll("_", "")),
  );
}

/** Credential words a real configuration writes, crossed with the affixes it wraps them in. */
function credentialNameCorpus(): string[] {
  const words = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "token",
    "secret",
    "credential",
    "credentials",
    "password",
    "passwd",
    "api_key",
    "api-key",
    "apikey",
    "apiKey",
    "bearer_key",
    "bearer-key",
    "bearerKey",
    "access_key",
    "access-key",
    "accessKey",
    "refresh_key",
    "refresh-key",
    "refreshKey",
    "private_key",
    "private-key",
    "privateKey",
    "client_secret",
    "clientSecret",
    "client-secret",
    "session_token",
    "sessionToken",
    "auth_token",
    "authToken",
    "personal_access_token",
    "payload",
    "body",
    "key",
    "auth",
    "session",
    "pwd",
    "pin",
    "signature",
  ];
  const affixes = ["", "x-", "x_", "x", "X-", "my", "X-Goog-", "proxy-"];
  const names = new Set<string>();
  for (const word of words) {
    for (const prefix of affixes) {
      names.add(`${prefix}${word}`);
      names.add(`${prefix}${word}-value`);
      names.add(`${prefix}${word}Id`);
    }
  }
  for (const context of [
    "x-workspace-id",
    "x-goog-user-project",
    "x-payload",
    "content-type",
    "accept",
    "x-trace-id",
  ]) {
    names.add(context);
  }
  return [...names];
}
