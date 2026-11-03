import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { CLOUD_MODEL_CHAT_COMPLETIONS_PATH, MCP_GATEWAY_PATH, RUNTIME_WEB_SEARCH_PATH } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  createInstrumentedFetch,
  createPerformanceLogger,
  isExternalTimeoutError,
  sanitizeExternalUrl,
  traceExternalCall,
  updateCurrentPerformanceContext,
} from "../observability/index.js";
import { CloudSlackAutoSetupOwner } from "../runtime/cloud-slack-auto-setup-owner.js";
import { RuntimeMcpGatewayTokenStore } from "../runtime-credentials/mcp-gateway-token-store.js";
import { RuntimeWebGatewayTokenStore } from "../runtime-credentials/web-gateway-token-store.js";
import { GitHubHttpTransport } from "../services/github-proxy/http-transport.js";
import { ExternalCallPolicy, ExternalCallPolicyError } from "../services/im/external-call-policy.js";
import { FeishuAdapter } from "../services/im-bindings/feishu/adapter.js";
import { createImProviderAdapterResolver } from "../services/im-bindings/provider-adapter-resolver.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";
import { RunnerHub } from "../services/sandboxes/runner-hub.js";

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
      service: "github",
      operation: "external.github.http",
      httpMethod: "POST",
      targetHost: "api.github.com",
      targetPath: "/user",
      outcome: "started",
    });
    expect(logs[1]?.payload).toMatchObject({
      callId: logs[0]?.payload.callId,
      startedAt: logs[0]?.payload.startedAt,
      service: "github",
      status: 200,
      attemptCount: 1,
      retryCount: 0,
      outcome: "completed",
    });
    expect(logs[3]?.payload).toMatchObject({
      callId: logs[2]?.payload.callId,
      service: "github",
      attemptCount: 1,
      retryCount: 0,
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

  it("logs started and completed records for ExternalCallPolicy operations with retryCount and attemptCount", async () => {
    const { logs, perfLogger } = createLogCollector();
    const policy = new ExternalCallPolicy({
      allowedHosts: ["slack.com"],
      backoffBaseMs: 0,
      maxAttempts: 3,
      performanceLogger: perfLogger,
    });

    let calls = 0;
    const result = await policy.run("slack.auth.test", async () => {
      calls += 1;
      if (calls === 1) {
        throw new ExternalCallPolicyError("IM_PROVIDER_TEMP_FAILURE", "temporary", {
          retryability: "retryable",
        });
      }
      return { ok: true };
    });
    expect(result).toEqual({ ok: true });

    expect(logs).toHaveLength(2);
    expect(logs[0]?.payload).toMatchObject({
      perfCategory: "external",
      provider: "slack",
      service: "slack",
      operation: "external.slack.auth.test",
      outcome: "started",
    });
    expect(logs[1]?.payload).toMatchObject({
      callId: logs[0]?.payload.callId,
      startedAt: logs[0]?.payload.startedAt,
      service: "slack",
      attemptCount: 2,
      retryCount: 1,
      outcome: "completed",
    });
    expect(logs[1]?.payload.durationMs).toBeGreaterThanOrEqual(0);

    logs.length = 0;
    const timeoutPolicy = new ExternalCallPolicy({
      defaultTimeoutMs: 5,
      maxAttempts: 1,
      performanceLogger: perfLogger,
    });
    await expect(timeoutPolicy.run("feishu.chat.get", () => new Promise(() => undefined))).rejects.toMatchObject({
      code: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED",
    });
    expect(logs).toHaveLength(2);
    expect(logs[1]?.payload).toMatchObject({
      service: "feishu",
      operation: "external.feishu.chat.get",
      outcome: "failed",
      code: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED",
      errorCode: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED",
      attemptCount: 1,
      retryCount: 0,
      timedOut: true,
    });
    expect(isExternalTimeoutError(new Error("timeout"), undefined, "UND_ERR_HEADERS_TIMEOUT")).toBe(true);
    expect(isExternalTimeoutError(new Error("reset"), undefined, "ECONNRESET")).toBe(false);
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

  it("logs external calls for Sandbox RunnerHub acceptance and workspace seal, FeishuAdapter probes, and CloudSlackAutoSetupOwner", async () => {
    const { logs, perfLogger } = createLogCollector();
    const hub = new RunnerHub({ performanceLogger: perfLogger });
    const scope = {
      sandboxId: "sbx-100",
      sessionId: "sess-100",
      environmentGeneration: 1,
      resourceName: "res-100",
    };
    const sentFrames: unknown[] = [];
    const socket = {
      send: (frame: unknown) => {
        sentFrames.push(frame);
        const typed = frame as { type?: string; requestId?: string };
        const reqId = typed.requestId;
        if (typed.type === "acceptance:run" && reqId) {
          queueMicrotask(() => {
            hub.resolveAcceptanceResult(
              scope.sandboxId,
              { type: "acceptance:result", requestId: reqId, outcome: "passed" },
              socket,
            );
          });
        }
        if (typed.type === "workspace:seal" && reqId) {
          queueMicrotask(() => {
            hub.settleWorkspaceSeal(
              scope.sandboxId,
              { type: "workspace:seal:result", requestId: reqId, ok: true },
              socket,
            );
          });
        }
      },
      close: () => undefined,
    };
    hub.attach(scope, socket);
    hub.markReady(
      scope,
      {
        sandboxName: "sbx-100",
        rootfs: "default",
        nodeVersion: "24.0.0",
        runnerVersion: "1.0.0",
        piVersion: "1.0.0",
        reportedAt: "2026-01-01T00:00:00.000Z",
      },
      socket,
    );

    const accRes = await hub.runAcceptance(
      scope.sandboxId,
      {
        mode: "offline",
        deadlineAtMs: Date.now() + 5_000,
        turnId: "turn-acc-1",
        deliveryId: "deliv-acc-1",
      },
      { timeoutMs: 1_000, socket },
    );
    expect(accRes.outcome).toBe("passed");

    const sealRes = await hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 1_000, socket });
    expect(sealRes.ok).toBe(true);

    expect(logs.filter((l) => l.payload.operation === "external.sandbox-runner.runAcceptance")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          service: "sandbox-runner",
          sandboxId: "sbx-100",
          sessionId: "sess-100",
          turnId: "turn-acc-1",
          deliveryId: "deliv-acc-1",
          outcome: "started",
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          service: "sandbox-runner",
          sandboxId: "sbx-100",
          sessionId: "sess-100",
          turnId: "turn-acc-1",
          deliveryId: "deliv-acc-1",
          attemptCount: 1,
          retryCount: 0,
          acceptanceOutcome: "passed",
          outcome: "completed",
        }),
      }),
    ]);
    expect(logs.filter((l) => l.payload.operation === "external.sandbox-runner.sealWorkspace")).toHaveLength(2);

    // FeishuAdapter via createImProviderAdapterResolver with feishuPolicy
    logs.length = 0;
    const feishuPolicy = new ExternalCallPolicy({
      allowedHosts: ["open.feishu.cn"],
      performanceLogger: perfLogger,
    });
    const postSpy = vi.spyOn(defaultHttpInstance, "post").mockResolvedValue({
      code: 0,
      tenant_access_token: "test-token",
      expire: 7200,
    });
    const reqSpy = vi.spyOn(defaultHttpInstance, "request").mockResolvedValue({
      code: 0,
      bot: { open_id: "ou_bot_1", activate_status: 2, app_name: "Bot" },
    });
    try {
      const resolver = createImProviderAdapterResolver({
        imBindings: {
          getSlackConnectionMaterial: async () => undefined,
          getFeishuConnectionMaterial: async () => ({
            appId: "cli_1",
            appSecret: "sec_1",
            teamId: "team_1",
            teamBrand: "feishu" as const,
            botOpenId: "ou_bot_1",
            generation: 1,
          }),
        } as never,
        slackApi: {} as never,
        feishuPolicy,
      });
      const resolved = (await resolver("binding-1", 1)) as FeishuAdapter;
      const bot = await resolved.probeBotIdentity();
      expect(bot.openId).toBe("ou_bot_1");

      const directAdapter = new FeishuAdapter({
        appId: "cli_1",
        appSecret: "sec_1",
        teamId: "team_1",
        channel: null,
        policy: feishuPolicy,
        scopeList: async () => ({
          code: 0,
          data: { scopes: [{ scope_name: "im:message", grant_status: 1 }] },
        }),
      });
      expect(await directAdapter.listGrantedWorkspaceScopes()).toEqual(["im:message"]);
    } finally {
      reqSpy.mockRestore();
      postSpy.mockRestore();
    }

    expect(
      logs.some((l) => l.payload.operation === "external.feishu.bot.info" && l.payload.outcome === "completed"),
    ).toBe(true);
    expect(
      logs.some((l) => l.payload.operation === "external.feishu.scope.list" && l.payload.outcome === "completed"),
    ).toBe(true);

    // CloudSlackAutoSetupOwner with instrumented fetch
    logs.length = 0;
    const slackSetup = new CloudSlackAutoSetupOwner({
      fetchImpl: createInstrumentedFetch(perfLogger, {
        provider: "slack",
        baseFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true, ticket: "t-123" }), { status: 200 })),
      }),
    });
    const setupRes = await slackSetup.start({
      computerId: "comp-1",
      agentId: "agent-1",
      input: { action: "authorize", force: true },
    });
    expect(setupRes).toEqual({ status: "authorization_required", ticket: "t-123" });
    expect(
      logs.some(
        (l) =>
          l.payload.operation === "external.slack.http" &&
          l.payload.service === "slack" &&
          l.payload.outcome === "completed",
      ),
    ).toBe(true);
  });

  it("propagates agentId, sessionId, deliveryId, turnId, and sandboxId across Turn execution entrypoints into external call logs", async () => {
    const chunks: string[] = [];
    const mcpTokens = new RuntimeMcpGatewayTokenStore();
    const webTokens = new RuntimeWebGatewayTokenStore();
    const executionId = "00000000-0000-4000-8000-000000000111";
    const sessionId = "00000000-0000-4000-8000-000000000222";
    const sandboxId = "00000000-0000-4000-8000-000000000333";
    const computerId = "00000000-0000-4000-8000-000000000444";
    const mcpBearer = mcpTokens.issue({ executionId, expiresAt: Date.now() + 60_000 }).token;
    const webBearer = webTokens.issue({ executionId, expiresAt: Date.now() + 60_000 }).token;

    const app = createApp({
      loggerLevel: "debug",
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
      mcpGateway: {
        tokens: mcpTokens,
        authorizer: {
          authorize: vi.fn(async () => ({
            executionId,
            accountId: "acc-turn",
            agentId: "agent-turn",
            sessionId,
            computerId,
            source: { kind: "delivery", deliveryId: "deliv-turn", turnId: "turn-1" },
            sandbox: { sandboxId, resourceUid: "uid-1", environmentGeneration: 1 },
          })),
        } as never,
        service: {
          catalog: vi.fn(async () => []),
          callTool: vi.fn(async () => {
            await traceExternalCall(
              createPerformanceLogger(() => app.log),
              { provider: "mcp", operation: "external.mcp.http" },
              async () => ({ status: 200 }),
              { statusFromResult: (r) => r.status },
            );
            return { result: { content: [{ type: "text", text: "ok" }] } };
          }),
        } as never,
      },
      runtimeWeb: {
        machineAuth: { verifyMachineToken: vi.fn() },
        tokens: webTokens,
        service: {
          executionComputerId: () => computerId,
          executionContext: () => ({
            accountId: "acc-turn",
            agentId: "agent-turn",
            sessionId,
            computerId,
            deliveryId: "deliv-turn",
            turnId: "turn-1",
            sandboxId,
          }),
          search: vi.fn(async () => ({
            requestId: "r-web-1",
            status: "ok",
            retrievedAt: "2026-01-01T00:00:00.000Z",
            effectiveDepth: "basic",
            results: [],
          })),
          fetch: vi.fn(),
        } as never,
      },
      cloudModel: {
        config: {
          enabled: true,
          upstreamBaseUrl: "https://router.example.com/v1",
          masterKey: "secret-master-key",
          requestTimeoutMs: 5_000,
          maxRequestBytes: 65_536,
          maxResponseBytes: 65_536,
          maxStreamsPerToken: 2,
          tokenTtlSeconds: 300,
        },
        grants: {
          verify: vi.fn(async () => ({
            jti: "00000000-0000-4000-8000-000000000999",
            executionId: "turn-1",
            sandboxId,
            sessionId,
            model: "gpt-4o",
            maxTokens: 1024,
          })),
          beginRequest: vi.fn(() => ({
            signal: new AbortController().signal,
            release: () => undefined,
          })),
          close: () => undefined,
        } as never,
        contextForExecution: vi.fn(async () => ({
          accountId: "acc-turn",
          agentId: "agent-turn",
          sessionId,
          source: "execution" as const,
        })),
        modelService: {
          request: vi.fn(async () => {
            updateCurrentPerformanceContext({ deliveryId: "deliv-turn" });
            return new Response(JSON.stringify({ id: "cmpl-1", choices: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }),
          close: async () => undefined,
        } as never,
      },
    });

    try {
      const mcpRes = await app.inject({
        method: "POST",
        url: MCP_GATEWAY_PATH,
        headers: { authorization: `Bearer ${mcpBearer}` },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "demo__tool", arguments: {} },
        },
      });
      expect(mcpRes.statusCode).toBe(200);

      const webRes = await app.inject({
        method: "POST",
        url: RUNTIME_WEB_SEARCH_PATH,
        headers: { authorization: `Bearer ${webBearer}` },
        payload: {
          protocolVersion: 1,
          executionId,
          toolCallId: "00000000-0000-4000-8000-000000000555",
          query: "hello",
        },
      });
      expect(webRes.statusCode).toBe(200);

      const modelRes = await app.inject({
        method: "POST",
        url: CLOUD_MODEL_CHAT_COMPLETIONS_PATH,
        headers: { authorization: "Bearer valid-model-token" },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(modelRes.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    const records = chunks
      .flatMap((c) => c.trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const mcpExternal = records.find((r) => r.operation === "external.mcp.http" && r.outcome === "completed");
    expect(mcpExternal).toMatchObject({
      accountId: "acc-turn",
      agentId: "agent-turn",
      sessionId,
      computerId,
      deliveryId: "deliv-turn",
      turnId: "turn-1",
      sandboxId,
      attemptCount: 1,
      retryCount: 0,
    });

    const webServiceEnd = records.find((r) => r.operation === "RuntimeWebService.search" && r.outcome === "completed");
    expect(webServiceEnd).toMatchObject({
      accountId: "acc-turn",
      agentId: "agent-turn",
      sessionId,
      computerId,
      deliveryId: "deliv-turn",
      turnId: "turn-1",
      sandboxId,
    });

    const modelServiceEnd = records.find(
      (r) => r.operation === "CloudModelService.request" && r.outcome === "completed",
    );
    expect(modelServiceEnd).toMatchObject({
      accountId: "acc-turn",
      agentId: "agent-turn",
      sessionId,
      sandboxId,
      turnId: "turn-1",
      deliveryId: "deliv-turn",
    });
  });
});
