import { describe, expect, it } from "vitest";
import { hashSecret, redactSecrets } from "../services/auth/security.js";
import { AuthTokenService } from "../services/auth/tokens.js";

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

describe("stateless auth tokens", () => {
  it("separates access and refresh audiences and enforces each expiry", async () => {
    let now = new Date("2026-08-18T00:00:00.000Z");
    const tokens = new AuthTokenService("test-secret-that-is-at-least-32-characters", 60, 3600, {
      now: () => now,
    });
    const pair = await tokens.issuePairForUser("53e2babe-e4ac-4e2c-b7d1-d092d5a4568e");

    await expect(tokens.verifyAccess(pair.accessToken)).resolves.toEqual({
      userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
    });
    await expect(tokens.verifyAccess(pair.refreshToken)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });

    now = new Date("2026-08-18T00:01:01.000Z");
    await expect(tokens.verifyAccess(pair.accessToken)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    await expect(tokens.verifyRefresh(pair.refreshToken)).resolves.toEqual({
      userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
    });

    now = new Date("2026-08-18T01:00:01.000Z");
    await expect(tokens.verifyRefresh(pair.refreshToken)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
  });
});
