import { describe, expect, it, vi } from "vitest";
import { createInstrumentedFetch, createPerformanceLogger, sanitizeExternalUrl } from "../observability/index.js";
import { ExternalCallPolicy } from "../services/im/external-call-policy.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

function createLogCollector() {
  const logs: Array<{ level: string; payload: Record<string, unknown>; message: string }> = [];
  const perfLogger = createPerformanceLogger(
    () =>
      ({
        isLevelEnabled: () => true,
        info: (payload: Record<string, unknown>, message: string) => logs.push({ level: "info", payload, message }),
        warn: (payload: Record<string, unknown>, message: string) => logs.push({ level: "warn", payload, message }),
      }) as never,
  );
  return { logs, perfLogger };
}

describe("external call performance logging", () => {
  it("strips query credentials, userinfo, and opaque token path segments from logged URLs", () => {
    expect(
      sanitizeExternalUrl("https://api.github.com/login/oauth/access_token?client_secret=super-secret&code=abc"),
    ).toEqual({
      targetHost: "api.github.com",
      targetPath: "/login/oauth/access_token",
    });

    expect(
      sanitizeExternalUrl("https://files.slack.com/files-pri/T1/xoxb-1234567890-secret-token/avatar.png?token=xyz"),
    ).toEqual({
      targetHost: "files.slack.com",
      targetPath: "/files-pri/T1/:redacted/avatar.png",
    });
  });

  it("logs started and completed/failed records for createInstrumentedFetch", async () => {
    const { logs, perfLogger } = createLogCollector();
    const baseFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockRejectedValueOnce(
        new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
      );

    const instrumentedFetch = createInstrumentedFetch(perfLogger, {
      provider: "github",
      baseFetch,
    });

    const response = await instrumentedFetch("https://api.github.com/user?access_token=secret-query-token", {
      method: "POST",
    });
    expect(response.status).toBe(200);

    await expect(instrumentedFetch("https://api.github.com/repos/owner/repo")).rejects.toThrow("fetch failed");

    expect(logs).toHaveLength(4);
    expect(logs[0]?.payload).toMatchObject({
      module: "external",
      perfCategory: "external",
      provider: "github",
      operation: "external.github.http",
      httpMethod: "POST",
      targetHost: "api.github.com",
      targetPath: "/user",
      outcome: "started",
    });
    expect(logs[1]?.payload).toMatchObject({
      callId: logs[0]?.payload.callId,
      startedAt: logs[0]?.payload.startedAt,
      status: 200,
      outcome: "completed",
    });
    expect(logs[3]?.payload).toMatchObject({
      callId: logs[2]?.payload.callId,
      transportCode: "ECONNRESET",
      outcome: "failed",
      code: "ECONNRESET",
      errorCode: "ECONNRESET",
    });
    expect(JSON.stringify(logs)).not.toContain("secret-query-token");
  });

  it("logs started and completed records for ExternalCallPolicy operations", async () => {
    const { logs, perfLogger } = createLogCollector();
    const policy = new ExternalCallPolicy({
      allowedHosts: ["slack.com"],
      performanceLogger: perfLogger,
    });

    const result = await policy.run("slack.auth.test", async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });

    expect(logs).toHaveLength(2);
    expect(logs[0]?.payload).toMatchObject({
      perfCategory: "external",
      provider: "slack",
      operation: "external.slack.auth.test",
      outcome: "started",
    });
    expect(logs[1]?.payload).toMatchObject({
      callId: logs[0]?.payload.callId,
      startedAt: logs[0]?.payload.startedAt,
      outcome: "completed",
    });
    expect(logs[1]?.payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs started and completed records for McpOutboundFetcher requests", async () => {
    const { logs, perfLogger } = createLogCollector();
    const fetcher = new McpOutboundFetcher({
      allowLoopback: false,
      performanceLogger: perfLogger,
      resolveAddresses: async () => ["93.184.216.34"],
      fetch: vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0" }), { status: 200 })),
    });

    const response = await fetcher.fetchOutbound("acc-mcp-1", "https://mcp.example.com/v1/rpc?secret=hidden", {
      method: "POST",
    });
    expect(response.status).toBe(200);

    expect(logs).toHaveLength(2);
    expect(logs[0]?.payload).toMatchObject({
      perfCategory: "external",
      provider: "mcp",
      operation: "external.mcp.http",
      accountId: "acc-mcp-1",
      httpMethod: "POST",
      targetHost: "mcp.example.com",
      targetPath: "/v1/rpc",
      outcome: "started",
    });
    expect(logs[1]?.payload).toMatchObject({
      callId: logs[0]?.payload.callId,
      status: 200,
      outcome: "completed",
    });
    expect(JSON.stringify(logs)).not.toContain("hidden");
  });
});
