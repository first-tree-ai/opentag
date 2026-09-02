import { describe, expect, it, vi } from "vitest";
import { createApp, sanitizeRequestUrl } from "../app.js";

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
});
