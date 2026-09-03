import { describe, expect, it } from "vitest";
import { formatStartupError, hashSecret, redactSecrets } from "../services/auth/security.js";

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

  it("preserves startup root causes while redacting database credentials and known secrets", () => {
    const secret = "jwt-secret-that-must-not-leak";
    const googleSecret = "google-secret-that-must-not-leak";
    const encryptionKey = "encryption-key-that-must-not-leak";
    const output = formatStartupError(
      new Error(
        `permission denied for database opentag at postgresql://user:password@localhost/opentag ${secret} ${googleSecret} ${encryptionKey}`,
      ),
      [secret, googleSecret, encryptionKey],
    );
    expect(output).toContain("permission denied for database opentag");
    expect(output).not.toContain("password");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(googleSecret);
    expect(output).not.toContain(encryptionKey);
  });
});
