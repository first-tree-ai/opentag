import { redactSensitive } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_NAME_PARTS, foldCredentialName, isCredentialName } from "./sensitive-names.js";

const MARKER = "sk-must-not-survive";

describe("credential name vocabulary", () => {
  /**
   * The two consumers answer one question, so a name this list calls a credential must be one the
   * repository's redactor already hides. `SENSITIVE_KEY_PARTS` is private, so the agreement is pinned
   * by behavior: if a name is ever dropped from the repository's vocabulary, this fails here instead
   * of leaving a pasted secret shareable.
   */
  it.each(CREDENTIAL_NAME_PARTS)("mirrors the shared redactor for %s", (part) => {
    expect(JSON.stringify(redactSensitive({ [part]: MARKER }))).not.toContain(MARKER);
  });

  it("leaves context names alone", () => {
    expect(isCredentialName("X-Workspace-Id")).toBe(false);
    expect(isCredentialName("x-goog-user-project")).toBe(false);
    expect(isCredentialName("X-Payload")).toBe(false);
    expect(isCredentialName("X-Request-Body")).toBe(false);
  });

  it("recognizes every separator convention the redactor recognizes", () => {
    expect(isCredentialName("Authorization")).toBe(true);
    expect(isCredentialName("x-client-secret")).toBe(true);
    expect(isCredentialName("x_client_secret")).toBe(true);
    expect(isCredentialName("X-PrivateKey")).toBe(true);
    expect(foldCredentialName("X-PrivateKey")).toBe("x_private_key");
  });
});
