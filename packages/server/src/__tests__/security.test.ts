import { describe, expect, it } from "vitest";
import { hashSecret, redactSecrets } from "../services/auth/security.js";

describe("auth secret handling", () => {
  it("uses deterministic SHA-256 hashes without retaining plaintext", () => {
    expect(hashSecret("secret")).toBe("2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b");
    expect(hashSecret("secret")).not.toContain("secret");
  });

  it("redacts bearer and credential fields", () => {
    const input = 'accessToken=abc refreshToken:xyz code="one-time" Authorization: Bearer token.value';
    const redacted = redactSecrets(input);
    expect(redacted).not.toContain("abc");
    expect(redacted).not.toContain("xyz");
    expect(redacted).not.toContain("token.value");
  });
});
