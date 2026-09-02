import { describe, expect, it, vi } from "vitest";
import { createApp, sanitizeRequestUrl } from "../app.js";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import { AuthServiceError } from "../services/auth/index.js";

describe("request logging", () => {
  it("uses an inbound x-request-id and echoes it on the response", async () => {
    const requestId = "request-id-from-client";
    let observedRequestId: string | undefined;
    const app = createApp({ loggerStream: { write: () => undefined } });
    app.addHook("onRequest", async (request) => {
      observedRequestId = request.id;
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-request-id": requestId },
      });
      expect(response.headers["x-request-id"]).toBe(requestId);
      expect(observedRequestId).toBe(requestId);
    } finally {
      await app.close();
    }
  });

  it("rejects an inbound request id that breaks the bounded contract", async () => {
    const oversized = "a".repeat(1024);
    let observed: string | undefined;
    const app = createApp({ loggerStream: { write: () => undefined } });
    app.addHook("onRequest", async (request) => {
      observed = request.id;
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-request-id": oversized },
      });
      expect(observed).not.toBe(oversized);
      expect((observed ?? "").length).toBeLessThanOrEqual(256);
      expect(response.headers["x-request-id"]).not.toBe(oversized);
    } finally {
      await app.close();
    }
  });

  it("names the request id field as the documented requestId", async () => {
    const chunks: string[] = [];
    const app = createApp({ loggerStream: { write: (chunk) => chunks.push(String(chunk)) } });
    try {
      await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "probe-1" } });
    } finally {
      await app.close();
    }
    const logs = chunks.join("");
    expect(logs).toContain('"requestId"');
    expect(logs).not.toContain('"reqId"');
  });

  it("removes query credentials from logged URLs", () => {
    expect(sanitizeRequestUrl("/api/v1/auth/google/callback?code=secret-code&state=secret-state")).toBe(
      "/api/v1/auth/google/callback",
    );
    expect(sanitizeRequestUrl("/api/v1/im-bindings/slack/oauth/callback?code=slack-code&state=slack-state")).toBe(
      "/api/v1/im-bindings/slack/oauth/callback",
    );
    expect(sanitizeRequestUrl("/api/v1/auth/google/start?next=%2Finvite%2Fsecret-token")).toBe(
      "/api/v1/auth/google/start",
    );
  });

  it("does not emit URL credentials in Fastify request logs", async () => {
    const chunks: string[] = [];
    const app = createApp({
      authService: {
        getAuthenticatedUser: vi.fn().mockResolvedValue({
          me: { user: { id: crypto.randomUUID() }, setupCompletedAt: null },
          tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
        }),
      } as never,
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    });
    try {
      await app.inject({
        method: "GET",
        url: "/api/v1/auth/google/callback?code=secret-code&state=secret-state",
      });
      await app.inject({
        method: "GET",
        url: "/api/v1/im-bindings/slack/oauth/callback?code=slack-code&state=slack-state",
      });
    } finally {
      await app.close();
    }

    const logs = chunks.join("");
    expect(logs).not.toContain("secret-code");
    expect(logs).not.toContain("secret-state");
    expect(logs).not.toContain("slack-code");
    expect(logs).not.toContain("slack-state");
    expect(logs).toContain("/api/v1/auth/google/callback");
    expect(logs).toContain("/api/v1/im-bindings/slack/oauth/callback");
  });

  it("whitelists error fields and bounds the serialized stack", async () => {
    const chunks: string[] = [];
    const error = Object.assign(new Error("Database write failed"), {
      detail: "offending-row-secret",
      where: "complete-database-internal-context",
    });
    error.name = "DrizzleQueryError";
    error.stack = `DrizzleQueryError: Database write failed\n${"stack-frame\n".repeat(2_000)}`;
    const app = createApp({
      loggerLevel: "error",
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    });
    app.get("/test/database-error", async () => {
      throw error;
    });

    try {
      const response = await app.inject({ method: "GET", url: "/test/database-error" });
      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
    }

    const failure = chunks
      .flatMap((chunk) => chunk.trim().split("\n"))
      .map((line) => JSON.parse(line) as { err?: Record<string, unknown>; msg?: string })
      .find((record) => record.msg === "Request failed");
    expect(failure?.err).toEqual({
      type: "DrizzleQueryError",
      message: "Database write failed",
      stack: error.stack.slice(0, 8_192),
    });
    expect(JSON.stringify(failure)).not.toContain("offending-row-secret");
    expect(JSON.stringify(failure)).not.toContain("complete-database-internal-context");
  });

  it("emits classified failures with the status-based level and request context", async () => {
    const chunks: string[] = [];
    const app = createApp({
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    });
    app.get("/test/conflict", async () => {
      throw new AuthServiceError("AUTH_EMAIL_CONFLICT", "deterministic", "An Account already exists", 409);
    });

    try {
      const response = await app.inject({ method: "GET", url: "/test/conflict" });
      expect(response.statusCode).toBe(409);
    } finally {
      await app.close();
    }

    const failure = chunks
      .flatMap((chunk) => chunk.trim().split("\n"))
      .map((line) => JSON.parse(line) as { code?: string; level?: number; statusCode?: number; requestId?: string })
      .find((record) => record.code === "AUTH_EMAIL_CONFLICT");
    expect(failure).toMatchObject({ level: 40, statusCode: 409 });
    expect(failure?.requestId).toEqual(expect.any(String));
  });

  it("does not emit a classified log for an anonymous authentication failure", async () => {
    const chunks: string[] = [];
    const app = createApp({
      authService: { getAuthenticatedUser: vi.fn() } as never,
      loggerLevel: "error",
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    });
    app.get("/test/private", { preHandler: createUserAuthPreHandler({} as never) }, async () => ({ ok: true }));

    try {
      const response = await app.inject({ method: "GET", url: "/test/private" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }

    expect(chunks).toEqual([]);
  });

  it("logs one email rate-limit trigger with only its key kind", async () => {
    const chunks: string[] = [];
    const email = "sensitive-member@example.com";
    const app = createApp({
      browserAuth: {
        betterAuth: { instance: {} as never, publicUrl: "http://localhost:8000" },
        passwordSignIn: true,
        publicOrigin: "http://localhost:8000",
        rateLimiter: {
          check: (key) => {
            if (key.startsWith("sign-in:")) {
              throw new AuthServiceError("RATE_LIMITED", "rate_limit", "Too many browser sign-in attempts", 429);
            }
          },
        },
        secureCookies: false,
        sessionTtlSeconds: 3600,
      },
      loggerLevel: "warn",
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    });

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/auth/email/sign-in",
          headers: { "content-type": "application/json", origin: "http://localhost:8000" },
          payload: { email, password: "correct-horse-battery" },
        });
        expect(response.statusCode).toBe(429);
      }
    } finally {
      await app.close();
    }

    const failures = chunks
      .flatMap((chunk) => chunk.trim().split("\n"))
      .map((line) => JSON.parse(line) as { code?: string; keyKind?: string })
      .filter((record) => record.code === "RATE_LIMITED");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ keyKind: "email" });
    expect(JSON.stringify(failures)).not.toContain(email);
    expect(JSON.stringify(failures)).not.toContain(`sign-in:${email}`);
  });
});
