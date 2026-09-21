import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { RunnerBootstrapTokenService } from "../services/sandboxes/runner-bootstrap-token.js";

const secret = "unit-runner-renewal-secret-at-least-32-characters";
const now = new Date("2026-09-18T00:00:00Z");
const claims = {
  sandboxId: randomUUID(),
  sessionId: randomUUID(),
  environmentGeneration: 1,
  resourceName: "projects/test/locations/us-west1/instances/test-runner",
};

describe("Runner renewal-only evidence", () => {
  it("accepts a fresh token across small issuing and verifying replica clock skew", async () => {
    const issuer = new RunnerBootstrapTokenService(secret, { now: () => new Date(now.getTime() + 1_000) });
    const verifier = new RunnerBootstrapTokenService(secret, { now: () => now });
    expect(await verifier.verify(await issuer.issue(claims))).toEqual(claims);
  });

  it("preserves expiry for access while exposing signed allocation claims only for renewal", async () => {
    let clock = now;
    const service = new RunnerBootstrapTokenService(secret, { now: () => clock, ttlSeconds: 60 });
    const token = await service.issue(claims);
    expect(await service.verify(token)).toEqual(claims);
    expect(await service.expiredClaimsForRenewal(token)).toBeUndefined();
    clock = new Date(now.getTime() + 3600_000);
    await expect(service.verify(token)).rejects.toThrow("invalid or expired");
    expect(await service.expiredClaimsForRenewal(token)).toEqual(claims);
  });

  it.each([
    "issuer",
    "audience",
    "iat_missing",
    "iat_future",
    "exp_missing",
    "exp_before_iat",
    "not_before",
    "scope",
    "signature",
  ] as const)("refuses %s without converting it to expiry recovery", async (invalid) => {
    const seconds = now.getTime() / 1000;
    const payload: Record<string, unknown> = {
      ...claims,
      iss: "opentag",
      aud: "opentag-cloud-runner",
      iat: seconds - 3600,
      exp: seconds - 1800,
    };
    Object.assign(
      payload,
      {
        issuer: { iss: "foreign" },
        audience: { aud: "opentag-cloud-model" },
        iat_missing: { iat: undefined },
        iat_future: { iat: seconds + 60 },
        exp_missing: { exp: undefined },
        exp_before_iat: { exp: seconds - 4000 },
        not_before: { nbf: seconds + 60 },
        scope: { environmentGeneration: -1 },
        signature: {},
      }[invalid],
    );
    const key = new TextEncoder().encode(
      invalid === "signature" ? "a-different-signing-key-with-enough-bytes" : secret,
    );
    const token = await new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).sign(key);
    const service = new RunnerBootstrapTokenService(secret, { now: () => now });
    await expect(service.verify(token)).rejects.toThrow("invalid or expired");
    expect(await service.expiredClaimsForRenewal(token)).toBeUndefined();
  });
});
