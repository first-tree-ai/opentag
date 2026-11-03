import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  it("logs targetHost only by default and includes sanitized targetPath only for fixed API templates", () => {
    expect(sanitizeExternalUrl("https://mcp.pipedream.net/6f1c2a4e-9b7d-4e1a-8c3f-2d5e6a7b8c9d/gmail")).toEqual({
      targetHost: "mcp.pipedream.net",
    });
    expect(sanitizeExternalUrl("https://files.slack.com/files-pri/T0123-F0456/salary_review_2026.pdf")).toEqual({
      targetHost: "files.slack.com",
    });
    expect(
      sanitizeExternalUrl("https://api.github.com/login/oauth/access_token?client_secret=super-secret&code=abc", {
        includePath: true,
      }),
    ).toEqual({
      targetHost: "api.github.com",
      targetPath: "/login/oauth/access_token",
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

  it("preserves Response.redirected, Response.url, and Response.type across a real HTTP redirect", async () => {
    const { logs, perfLogger } = createLogCollector();
    const server = createServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reached: "final" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const instrumentedFetch = createInstrumentedFetch(perfLogger, {
        provider: "github",
      });
      const response = await instrumentedFetch(`${baseUrl}/start`);
      expect({
        redirected: response.redirected,
        url: response.url,
        type: response.type,
        status: response.status,
      }).toEqual({
        redirected: true,
        url: `${baseUrl}/final`,
        type: "basic",
        status: 200,
      });
      expect(await response.json()).toEqual({ reached: "final" });
      expect(logs).toHaveLength(2);
      expect(logs[1]?.payload).toMatchObject({
        outcome: "completed",
        status: 200,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

  it("logs started and completed records for McpOutboundFetcher without exposing secret-bearing path segments", async () => {
    const { logs, perfLogger } = createLogCollector();
    const fetcher = new McpOutboundFetcher({
      allowLoopback: false,
      performanceLogger: perfLogger,
      resolveAddresses: async () => ["93.184.216.34"],
      fetch: vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0" }), { status: 200 })),
    });

    const secretUrls = [
      "https://mcp.pipedream.net/6f1c2a4e-9b7d-4e1a-8c3f-2d5e6a7b8c9d/gmail?secret=hidden",
      "https://mcp.example.com/0123456789abcdef0123456789abcdef/sse",
      "https://mcp.example.com/api/sk-proj-AbCdEf0123456789/mcp",
    ];
    for (const url of secretUrls) {
      const response = await fetcher.fetchOutbound("acc-mcp-1", url, { method: "POST" });
      expect(response.status).toBe(200);
    }

    expect(logs).toHaveLength(6);
    expect(logs[0]?.payload).toMatchObject({
      perfCategory: "external",
      provider: "mcp",
      operation: "external.mcp.http",
      accountId: "acc-mcp-1",
      httpMethod: "POST",
      targetHost: "mcp.pipedream.net",
      outcome: "started",
    });
    expect(logs[0]?.payload.targetPath).toBeUndefined();
    expect(logs[1]?.payload).toMatchObject({
      callId: logs[0]?.payload.callId,
      status: 200,
      outcome: "completed",
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("6f1c2a4e-9b7d-4e1a-8c3f-2d5e6a7b8c9d");
    expect(serialized).not.toContain("0123456789abcdef0123456789abcdef");
    expect(serialized).not.toContain("sk-proj-AbCdEf0123456789");
  });
});
