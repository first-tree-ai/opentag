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
});
