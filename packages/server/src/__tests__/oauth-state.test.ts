import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { invitationTokenFromNext, OAuthFlowService, validateOAuthNext } from "../services/auth/index.js";

const secret = "oauth-state-secret-that-is-at-least-32-characters";
const now = new Date("2026-08-19T00:00:00.000Z");

describe("OAuthFlowService", () => {
  it("binds state to a signed context without putting an invitation bearer in state", async () => {
    const token = "A".repeat(43);
    const service = new OAuthFlowService(secret, { now: () => now });
    const started = await service.start(`/invites/${token}`);
    expect(JSON.stringify(decodeJwt(started.state))).not.toContain(token);
    expect(await service.verify(started.state, started.context)).toMatchObject({ next: `/invites/${token}` });
    expect(invitationTokenFromNext(`/invites/${token}`)).toBe(token);
  });

  it("rejects flow substitution, expiry, and unsafe redirect destinations", async () => {
    const service = new OAuthFlowService(secret, { now: () => now, ttlSeconds: 60 });
    const first = await service.start("/agents/example/runtime");
    const second = await service.start("/agents");
    await expect(service.verify(first.state, second.context)).rejects.toMatchObject({ code: "AUTH_OAUTH_FAILED" });
    expect(() => validateOAuthNext("https://evil.example")).toThrow();
    expect(() => validateOAuthNext("//evil.example")).toThrow();
    expect(() => validateOAuthNext("/agents\\evil")).toThrow();
    expect(() => validateOAuthNext("/admin")).toThrow();
  });
});
