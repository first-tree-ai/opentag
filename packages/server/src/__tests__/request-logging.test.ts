import { describe, expect, it } from "vitest";
import { createApp, sanitizeRequestUrl } from "../app.js";

describe("request logging", () => {
  it("removes query credentials and invitation bearer path segments", () => {
    expect(sanitizeRequestUrl("/api/v1/auth/google/callback?code=secret-code&state=secret-state")).toBe(
      "/api/v1/auth/google/callback",
    );
    expect(sanitizeRequestUrl("/api/v1/auth/google/start?next=%2Finvite%2Fsecret-token")).toBe(
      "/api/v1/auth/google/start",
    );
    expect(sanitizeRequestUrl("/invites/secret-token")).toBe("/invites/[REDACTED]");
    expect(sanitizeRequestUrl("/api/v1/invitations/secret-token/redeem")).toBe("/api/v1/invitations/[REDACTED]/redeem");
    expect(sanitizeRequestUrl("/api/v1/invitations/secret-token/redeem/")).toBe(
      "/api/v1/invitations/[REDACTED]/redeem/",
    );
    expect(sanitizeRequestUrl("/api/v1/invitations/secret-token/unknown")).toBe(
      "/api/v1/invitations/[REDACTED]/unknown",
    );
    expect(sanitizeRequestUrl("/invites/secret-token/unknown")).toBe("/invites/[REDACTED]/unknown");
  });

  it("does not emit URL credentials in Fastify request logs", async () => {
    const chunks: string[] = [];
    const app = createApp({ loggerStream: { write: (chunk) => chunks.push(String(chunk)) } });
    try {
      await app.inject({
        method: "GET",
        url: "/api/v1/auth/google/callback?code=secret-code&state=secret-state",
      });
      await app.inject({ method: "GET", url: "/invites/secret-invitation-token" });
      await app.inject({ method: "POST", url: "/api/v1/invitations/secret-api-token/redeem" });
      await app.inject({ method: "POST", url: "/api/v1/invitations/secret-trailing-token/redeem/" });
      await app.inject({ method: "GET", url: "/api/v1/invitations/secret-unknown-api-token/unknown" });
      await app.inject({ method: "GET", url: "/invites/secret-unknown-web-token/unknown" });
    } finally {
      await app.close();
    }

    const logs = chunks.join("");
    expect(logs).not.toContain("secret-code");
    expect(logs).not.toContain("secret-state");
    expect(logs).not.toContain("secret-invitation-token");
    expect(logs).not.toContain("secret-api-token");
    expect(logs).not.toContain("secret-trailing-token");
    expect(logs).not.toContain("secret-unknown-api-token");
    expect(logs).not.toContain("secret-unknown-web-token");
    expect(logs).toContain("/api/v1/auth/google/callback");
    expect(logs).toContain("/invites/[REDACTED]");
  });
});
