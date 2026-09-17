import { RUNTIME_MAX_DURATION_MS, RunnerServerFrameSchema } from "@opentag/shared";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_MODEL_GRANT_MAX_TTL_MS, CloudModelGrantService } from "../services/sandboxes/cloud-model-grants.js";

const SECRET = "unit-test-jwt-secret-at-least-32-characters";
const SANDBOX_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function issueInput(overrides: Partial<Parameters<CloudModelGrantService["issue"]>[0]> = {}) {
  return {
    executionId: "turn-1",
    model: "model-a",
    sandboxId: SANDBOX_ID,
    sessionId: SESSION_ID,
    ...overrides,
  };
}

function makeService(
  options: {
    allowedModels?: string[];
    now?: () => Date;
    maxStreamsPerToken?: number;
    maxTrackedGrants?: number;
    sweepIntervalMs?: number;
    ttlSeconds?: number;
  } = {},
) {
  return new CloudModelGrantService(SECRET, {
    allowedModels: options.allowedModels ?? ["model-a", "model-b"],
    maxStreamsPerToken: options.maxStreamsPerToken ?? 2,
    maxTrackedGrants: options.maxTrackedGrants ?? 32,
    sweepIntervalMs: options.sweepIntervalMs ?? 0,
    ttlSeconds: options.ttlSeconds ?? 60,
    ...(options.now ? { now: options.now } : {}),
  });
}

describe("CloudModelGrantService", () => {
  let service: CloudModelGrantService | undefined;
  afterEach(() => {
    service?.close();
    service = undefined;
  });

  it("mints a verifiable execution-scoped token and exposes the configured default model", async () => {
    service = makeService();
    expect(service.defaultModel).toBe("model-a");
    const issued = await service.issue(issueInput());
    if (!issued) throw new Error("grant issue failed");
    const claims = await service.verify(issued.token);
    expect(claims).toEqual({
      executionId: "turn-1",
      jti: issued.claims.jti,
      model: "model-a",
      sandboxId: SANDBOX_ID,
      sessionId: SESSION_ID,
    });
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("never mints a token for a model outside the allowlist", async () => {
    service = makeService();
    expect(await service.issue(issueInput({ model: "model-z" }))).toBeUndefined();
    expect(service.isModelAllowed("model-z")).toBe(false);
  });

  it("reuses one live token per execution and rejects conflicting scope or model", async () => {
    service = makeService();
    const first = await service.issue(issueInput());
    const second = await service.issue(issueInput());
    if (!first || !second) throw new Error("grant issue failed");
    expect(second.token).toBe(first.token);
    expect(second.claims.jti).toBe(first.claims.jti);
    expect(second.expiresAt.getTime()).toBe(first.expiresAt.getTime());
    expect(service.trackedGrantCount).toBe(1);
    expect(await service.issue(issueInput({ model: "model-b" }))).toBeUndefined();
    expect(await service.issue(issueInput({ sandboxId: "33333333-3333-4333-8333-333333333333" }))).toBeUndefined();
    expect(await service.issue(issueInput({ sessionId: "44444444-4444-4444-8444-444444444444" }))).toBeUndefined();
    // Revocation is final for the execution: a duplicate receipt cannot mint a fresh permission.
    expect(service.revokeExecution("turn-1")).toBe(1);
    expect(await service.issue(issueInput())).toBeUndefined();
  });

  it("rotates a revoked but unfinished execution only with the explicit recovery flag", async () => {
    service = makeService();
    const first = await service.issue(issueInput());
    if (!first) throw new Error("grant issue failed");
    const admission = service.beginRequest(first.claims.jti);
    admission?.signal.addEventListener("abort", () => undefined);
    expect(service.revokeExecution("turn-1")).toBe(1);
    expect(await service.verify(first.token)).toBeUndefined();
    // A revoked execution is never silently re-minted.
    expect(await service.issue(issueInput())).toBeUndefined();

    const rotated = await service.issue(issueInput({ supersedeRevoked: true }));
    if (!rotated) throw new Error("rotation failed");
    expect(rotated.claims.jti).not.toBe(first.claims.jti);
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.claims.executionId).toBe("turn-1");
    // The old generation stays an invalid tombstone; the new one is live and admitted.
    expect(await service.verify(first.token)).toBeUndefined();
    expect(service.beginRequest(first.claims.jti)).toBeUndefined();
    expect(await service.verify(rotated.token)).toEqual(rotated.claims);
    expect(service.beginRequest(rotated.claims.jti)).toBeDefined();

    // Revocation of the turn kills every generation it has produced.
    expect(service.revokeExecution("turn-1")).toBe(1);
    expect(await service.verify(rotated.token)).toBeUndefined();
  });

  it("refuses recovery rotation for a conflicting scope or an expired execution", async () => {
    let now = new Date("2026-09-17T00:00:00.000Z");
    service = makeService({ now: () => now });
    const expiring = new Date(now.getTime() + 10 * 60 * 1_000);
    const first = await service.issue(issueInput({ expiresAt: expiring }));
    if (!first) throw new Error("grant issue failed");
    expect(service.revokeExecution("turn-1")).toBe(1);

    // A different model, Sandbox, or Session is a different execution identity: never rotated.
    expect(await service.issue(issueInput({ supersedeRevoked: true, model: "model-b" }))).toBeUndefined();
    expect(
      await service.issue(issueInput({ supersedeRevoked: true, sandboxId: "33333333-3333-4333-8333-333333333333" })),
    ).toBeUndefined();
    expect(
      await service.issue(issueInput({ supersedeRevoked: true, sessionId: "44444444-4444-4444-8444-444444444444" })),
    ).toBeUndefined();

    // Once the original window has passed, the execution is temporally final: no rotation.
    now = new Date(now.getTime() + 11 * 60 * 1_000);
    expect(
      await service.issue(issueInput({ supersedeRevoked: true, expiresAt: new Date(now.getTime() + 10 * 60 * 1_000) })),
    ).toBeUndefined();
    expect(await service.verify(first.token)).toBeUndefined();
  });

  it("honours an explicit bounded per-turn expiry and falls back to the configured ttl", async () => {
    const now = new Date("2026-09-17T00:00:00.000Z");
    service = makeService({ now: () => now });
    const deadline = new Date(now.getTime() + 30 * 60 * 1_000);
    const explicit = await service.issue(issueInput({ expiresAt: deadline, executionId: "turn-deadline" }));
    if (!explicit) throw new Error("grant issue failed");
    expect(explicit.expiresAt.getTime()).toBe(deadline.getTime());
    const fallback = await service.issue(issueInput({ executionId: "turn-fallback" }));
    if (!fallback) throw new Error("grant issue failed");
    expect(fallback.expiresAt.getTime()).toBe(now.getTime() + 60_000);

    const max = await service.issue(
      issueInput({ executionId: "turn-max", expiresAt: new Date(now.getTime() + CLOUD_MODEL_GRANT_MAX_TTL_MS) }),
    );
    expect(max).toBeDefined();
    expect(
      await service.issue(
        issueInput({
          executionId: "turn-over-max",
          expiresAt: new Date(now.getTime() + CLOUD_MODEL_GRANT_MAX_TTL_MS + 1),
        }),
      ),
    ).toBeUndefined();
    expect(
      await service.issue(issueInput({ executionId: "turn-past", expiresAt: new Date(now.getTime() - 1) })),
    ).toBeUndefined();
    expect(await service.issue(issueInput({ executionId: "turn-now", expiresAt: now }))).toBeUndefined();
    expect(
      await service.issue(issueInput({ executionId: "turn-invalid", expiresAt: new Date(Number.NaN) })),
    ).toBeUndefined();
    expect(CLOUD_MODEL_GRANT_MAX_TTL_MS).toBe(RUNTIME_MAX_DURATION_MS + 60_000);
  });

  it("rejects foreign, tampered, unbounded, and cross-purpose JWTs", async () => {
    const now = new Date("2026-09-17T00:00:00.000Z");
    service = makeService({ now: () => now });
    const issued = await service.issue(issueInput());
    if (!issued) throw new Error("grant issue failed");
    expect(await service.verify(`${issued.token}x`)).toBeUndefined();
    expect(await service.verify("")).toBeUndefined();
    expect(await service.verify("a".repeat(5_000))).toBeUndefined();
    // A different service instance has no grant state for this jti.
    const other = makeService({ now: () => now });
    expect(await other.verify(issued.token)).toBeUndefined();
    other.close();

    const claims = {
      executionId: "turn-1",
      jti: issued.claims.jti,
      model: "model-a",
      sandboxId: SANDBOX_ID,
      sessionId: SESSION_ID,
    };
    const key = new TextEncoder().encode(SECRET);
    const iat = Math.floor(now.getTime() / 1_000);
    const sign = (extra: (jwt: SignJWT) => SignJWT) =>
      extra(
        new SignJWT(claims)
          .setProtectedHeader({ alg: "HS256", typ: "JWT" })
          .setIssuer("opentag")
          .setAudience("opentag-cloud-model")
          .setIssuedAt(iat)
          .setJti(claims.jti),
      ).sign(key);

    expect(
      await service.verify(await sign((jwt) => jwt.setExpirationTime(iat + 60).setAudience("other-audience"))),
    ).toBeUndefined();
    expect(
      await service.verify(await sign((jwt) => jwt.setExpirationTime(iat + 60).setIssuer("other-issuer"))),
    ).toBeUndefined();
    expect(await service.verify(await sign((jwt) => jwt))).toBeUndefined(); // no exp
    expect(
      await service.verify(await sign((jwt) => jwt.setExpirationTime(iat + RUNTIME_MAX_DURATION_MS / 1_000 + 61))),
    ).toBeUndefined();
    expect(
      await service.verify(await sign((jwt) => jwt.setIssuedAt(iat + 3_600).setExpirationTime(iat + 3_600 + 60))),
    ).toBeUndefined();
    expect(await service.verify(await sign((jwt) => jwt.setExpirationTime(iat + 60)))).toBeDefined(); // control: the same secret and valid envelope verifies
  });

  it("expires tokens with the injected clock and rejects them afterwards", async () => {
    let now = new Date("2026-09-17T00:00:00.000Z");
    service = makeService({ now: () => now });
    const issued = await service.issue(issueInput());
    if (!issued) throw new Error("grant issue failed");
    expect(await service.verify(issued.token)).toBeDefined();
    now = new Date(now.getTime() + 61_000);
    expect(await service.verify(issued.token)).toBeUndefined();
    expect(service.beginRequest(issued.claims.jti)).toBeUndefined();
  });

  it("revokes immediately, aborts in-flight streams, and is idempotent", async () => {
    service = makeService();
    const issued = await service.issue(issueInput());
    if (!issued) throw new Error("grant issue failed");
    const admission = service.beginRequest(issued.claims.jti);
    if (!admission) throw new Error("admission failed");
    let aborted = false;
    admission.signal.addEventListener("abort", () => {
      aborted = true;
    });
    expect(service.revokeExecution("turn-1")).toBe(1);
    expect(service.revokeExecution("turn-1")).toBe(0);
    expect(aborted).toBe(true);
    admission.release();
    expect(service.beginRequest(issued.claims.jti)).toBeUndefined();
    expect(await service.verify(issued.token)).toBeUndefined();
  });

  it("bounds concurrency per token and releases admission", async () => {
    service = makeService({ maxStreamsPerToken: 2 });
    const issued = await service.issue(issueInput());
    if (!issued) throw new Error("grant issue failed");
    const first = service.beginRequest(issued.claims.jti);
    const second = service.beginRequest(issued.claims.jti);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(service.beginRequest(issued.claims.jti)).toBeUndefined();
    first?.release();
    expect(service.beginRequest(issued.claims.jti)).toBeDefined();
  });

  it("sweeps expired grants and aborts streams that outlived their permission", async () => {
    let now = new Date("2026-09-17T00:00:00.000Z");
    service = makeService({ now: () => now });
    const issued = await service.issue(issueInput());
    if (!issued) throw new Error("grant issue failed");
    const admission = service.beginRequest(issued.claims.jti);
    if (!admission) throw new Error("admission failed");
    now = new Date(now.getTime() + 61_000);
    expect(service.sweep()).toBe(1);
    expect(admission.signal.aborted).toBe(true);
    expect(service.trackedGrantCount).toBe(0);
  });

  it("keeps retained grant state hard-bounded and evicts revoked tombstones first", async () => {
    service = makeService({ maxTrackedGrants: 2 });
    expect(await service.issue(issueInput({ executionId: "turn-1" }))).toBeDefined();
    expect(service.revokeExecution("turn-1")).toBe(1);
    expect(await service.issue(issueInput({ executionId: "turn-2" }))).toBeDefined();
    expect(await service.issue(issueInput({ executionId: "turn-3" }))).toBeDefined();
    expect(service.trackedGrantCount).toBeLessThanOrEqual(2);
    // All retained entries are live now: a further distinct execution must not exceed the bound.
    const overflowed = await service.issue(issueInput({ executionId: "turn-4" }));
    if (overflowed) {
      expect(service.trackedGrantCount).toBeLessThanOrEqual(2);
    }
  });

  it("runs a bounded recurring sweep when enabled", async () => {
    let now = new Date("2026-09-17T00:00:00.000Z");
    service = makeService({ now: () => now, sweepIntervalMs: 10 });
    const issued = await service.issue(issueInput());
    expect(issued).toBeDefined();
    now = new Date(now.getTime() + 61_000);
    await vi.waitFor(() => expect(service?.trackedGrantCount).toBe(0), { interval: 5, timeout: 1_000 });
  });

  it("composes maximum-length claims into the real Runner wire frame", async () => {
    const model = "m".repeat(128);
    service = makeService({ allowedModels: [model] });
    const issued = await service.issue(
      issueInput({
        executionId: "t".repeat(256),
        model,
      }),
    );
    if (!issued) throw new Error("grant issue failed");
    const tokenBytes = Buffer.byteLength(issued.token, "utf8");
    expect(tokenBytes).toBeLessThanOrEqual(4_096);
    const frame = {
      type: "delivery:verified",
      requestId: "request-1",
      status: "verified",
      model: {
        baseUrl: "https://models.example.com/api/v1/cloud-model",
        model: "m".repeat(128),
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
      },
    };
    const parsed = RunnerServerFrameSchema.safeParse(frame);
    if (!parsed.success) {
      throw new Error(
        `The real Runner wire schema rejected a limit-claims token (${tokenBytes} bytes): ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    expect(parsed.success).toBe(true);
    expect(await service.verify(issued.token)).toBeDefined();
  });
});
