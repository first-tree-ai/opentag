import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createInstrumentedFetch, createPerformanceLogger, sanitizeExternalUrl } from "../observability/index.js";
import { GitHubHttpTransport } from "../services/github-proxy/http-transport.js";
import { ExternalCallPolicy } from "../services/im/external-call-policy.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

function createLogCollector() {
  const logs: Array<{ level: string; payload: Record<string, unknown>; message: string }> = [];
  const perfLogger = createPerformanceLogger(
    () =>
      ({
        isLevelEnabled: () => true,
        debug: (payload: Record<string, unknown>, message: string) => logs.push({ level: "debug", payload, message }),
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

  it("logs started and completed/failed records for createInstrumentedFetch and preserves original fetch when disabled", async () => {
    const { logs, perfLogger } = createLogCollector();
    const baseFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockRejectedValueOnce(
        new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
      );

    const disabledPerf = createPerformanceLogger(() => undefined, { enabled: false });
    expect(createInstrumentedFetch(disabledPerf, { provider: "github", baseFetch })).toBe(baseFetch);

    const instrumentedFetch = createInstrumentedFetch(perfLogger, {
      provider: "github",
      baseFetch,
    });

    const response = await instrumentedFetch("https://api.github.com/user?access_token=secret-query-token", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

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

  it("settles streaming fetch and GitHubHttpTransport on body EOF or body error rather than header arrival", async () => {
    const { logs, perfLogger } = createLogCollector();
    const errorStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(Object.assign(new Error("body truncated"), { code: "ECONNRESET" }));
      },
    });
    const fetchWithErrorBody = createInstrumentedFetch(perfLogger, {
      provider: "github",
      baseFetch: vi.fn(async () => new Response(errorStream, { status: 200 })),
    });

    const res = await fetchWithErrorBody("https://api.github.com/repos/owner/repo/tarball");
    await expect(res.text()).rejects.toThrow("body truncated");

    expect(logs).toHaveLength(2);
    expect(logs[0]?.payload).toMatchObject({
      operation: "external.github.http",
      outcome: "started",
    });
    expect(logs[1]?.payload).toMatchObject({
      callId: logs[0]?.payload.callId,
      status: 200,
      outcome: "failed",
      transportCode: "ECONNRESET",
    });

    // GitHubHttpTransport settles only after body iteration completes or fails
    logs.length = 0;
    const responseStream = new PassThrough();
    Object.assign(responseStream, { statusCode: 200, headers: {} });
    const transport = new GitHubHttpTransport({
      performanceLogger: perfLogger,
      resolveAddresses: async () => ["93.184.216.34"],
      connect: (_url, _options, listener) => {
        const req = new PassThrough();
        Object.assign(req, { setTimeout: () => req });
        queueMicrotask(() => listener(responseStream as never));
        return req as never;
      },
    });

    const proxyRes = await transport.request({
      url: new URL("https://github.com/owner/repo.git/info/refs"),
      method: "GET",
      headers: {},
      body: (async function* () {})(),
      token: "secret",
      signal: new AbortController().signal,
    });
    // Only started record before body is consumed
    expect(logs).toHaveLength(1);
    expect(logs[0]?.payload.outcome).toBe("started");

    responseStream.destroy(new Error("mid-stream disconnect"));
    const consume = async () => {
      for await (const _chunk of proxyRes.body) {
        // consume stream
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "github_response_truncated" });
    expect(logs).toHaveLength(2);
    expect(logs[1]?.payload).toMatchObject({
      callId: logs[0]?.payload.callId,
      status: 200,
      outcome: "failed",
      code: "github_response_truncated",
    });
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
