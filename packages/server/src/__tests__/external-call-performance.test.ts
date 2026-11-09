import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { CLOUD_MODEL_CHAT_COMPLETIONS_PATH, MCP_GATEWAY_PATH, RUNTIME_WEB_SEARCH_PATH } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  createErrorReporter,
  createInstrumentedFetch,
  createPerformanceLogger,
  getCurrentPerformanceContext,
  isExternalTimeoutError,
  runWithPerformanceContext,
  sanitizeExternalUrl,
  traceExternalCall,
  updateCurrentPerformanceContext,
} from "../observability/index.js";
import { CloudSlackAutoSetupOwner } from "../runtime/cloud-slack-auto-setup-owner.js";
import { KeyedTaskScheduler } from "../runtime/keyed-task-scheduler.js";
import { createRuntimeCredentialServices } from "../runtime-credentials/index.js";
import { RuntimeMcpGatewayTokenStore } from "../runtime-credentials/mcp-gateway-token-store.js";
import { RuntimeWebGatewayTokenStore } from "../runtime-credentials/web-gateway-token-store.js";
import { createCloudExecutionContext } from "../services/cloud-model-context.js";
import { CloudModelService } from "../services/cloud-model-service.js";
import { GitHubHttpTransport } from "../services/github-proxy/http-transport.js";
import { ExternalCallPolicy, ExternalCallPolicyError } from "../services/im/external-call-policy.js";
import { FeishuAdapter } from "../services/im-bindings/feishu/adapter.js";
import { createImProviderAdapterResolver } from "../services/im-bindings/provider-adapter-resolver.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";
import { CloudDeliveryOwner } from "../services/sandboxes/cloud-delivery-owner.js";
import { CloudImSteering } from "../services/sandboxes/cloud-im-steering.js";
import { RouterCloudModelCatalog } from "../services/sandboxes/cloud-model-catalog.js";
import { CloudRuntimeFence } from "../services/sandboxes/cloud-runtime-fence.js";
import {
  CloudSessionCollaborationOwner,
  CloudSessionWorkTracker,
} from "../services/sandboxes/cloud-session-collaboration-owner.js";
import { RunnerHub } from "../services/sandboxes/runner-hub.js";
import { SkillSourceFetcher } from "../services/skills/source/source-fetcher.js";

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
      externalService: "github",
      operation: "external.github.http",
      httpMethod: "POST",
      targetHost: "api.github.com",
      targetPath: "/user",
      outcome: "started",
    });
    expect(logs[1]?.payload).toMatchObject({
      callId: logs[0]?.payload.callId,
      startedAt: logs[0]?.payload.startedAt,
      externalService: "github",
      status: 200,
      attemptCount: 1,
      retryCount: 0,
      outcome: "completed",
    });
    expect(logs[3]?.payload).toMatchObject({
      callId: logs[2]?.payload.callId,
      externalService: "github",
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
      externalService: "slack",
      operation: "external.slack.auth.test",
      outcome: "started",
    });
    expect(logs[1]?.payload).toMatchObject({
      callId: logs[0]?.payload.callId,
      startedAt: logs[0]?.payload.startedAt,
      externalService: "slack",
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
      externalService: "feishu",
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
          externalService: "sandbox-runner",
          sandboxId: "sbx-100",
          sessionId: "sess-100",
          turnId: "turn-acc-1",
          deliveryId: "deliv-acc-1",
          outcome: "started",
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          externalService: "sandbox-runner",
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

    // Concurrent requestWorkspaceSeal: leader logs attemptCount: 1, coalesced waiter logs attemptCount: 0, coalesced: true
    logs.length = 0;
    sentFrames.length = 0;
    const [seal1, seal2] = await Promise.all([
      hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 1_000, socket }),
      hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 1_000, socket }),
    ]);
    expect(seal1.ok).toBe(true);
    expect(seal2.ok).toBe(true);
    expect(sentFrames.filter((f) => (f as { type?: string }).type === "workspace:seal")).toHaveLength(1);
    const sealCompletions = logs.filter(
      (l) => l.payload.operation === "external.sandbox-runner.sealWorkspace" && l.payload.outcome === "completed",
    );
    expect(sealCompletions).toHaveLength(2);
    expect(
      sealCompletions.map((l) => ({ attemptCount: l.payload.attemptCount, coalesced: l.payload.coalesced })),
    ).toEqual(
      expect.arrayContaining([
        { attemptCount: 1, coalesced: undefined },
        { attemptCount: 0, coalesced: true },
      ]),
    );

    // Pre-dispatch rejection on disconnected sandbox -> attemptCount: 0
    logs.length = 0;
    await expect(
      hub.runAcceptance("sbx-missing", { mode: "offline", deadlineAtMs: Date.now() + 5_000 }, { timeoutMs: 1_000 }),
    ).rejects.toThrow();
    expect(logs.at(-1)?.payload).toMatchObject({
      externalService: "sandbox-runner",
      operation: "external.sandbox-runner.runAcceptance",
      outcome: "failed",
      attemptCount: 0,
      retryCount: 0,
    });

    // FeishuAdapter via createImProviderAdapterResolver with feishuPolicy and validateBinding
    logs.length = 0;
    const feishuPolicy = new ExternalCallPolicy({
      allowedHosts: ["open.feishu.cn"],
      performanceLogger: perfLogger,
    });
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
    expect(resolved.provider).toBe("feishu");

    const channelAdapter = new FeishuAdapter({
      appId: "cli_1",
      appSecret: "sec_1",
      teamId: "team_1",
      policy: feishuPolicy,
      channel: {
        botIdentity: { openId: "ou_bot_1", name: "Bot" },
        connect: async () => undefined,
        disconnect: async () => undefined,
        on: () => () => undefined,
      },
    });
    await expect(channelAdapter.validateBinding()).resolves.toMatchObject({
      externalAppId: "cli_1",
      externalBotId: "ou_bot_1",
    });
    expect(
      logs.some(
        (l) =>
          l.payload.operation === "external.feishu.channel.connect" &&
          l.payload.externalService === "feishu" &&
          l.payload.outcome === "completed",
      ),
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
          l.payload.externalService === "slack" &&
          l.payload.outcome === "completed",
      ),
    ).toBe(true);
  });

  it("does not deadlock or emit duplicate external logs when re-entering the same ExternalCallPolicy at maxConcurrency and propagates outer deadline AbortSignal", async () => {
    const { logs, perfLogger } = createLogCollector();
    const sharedPolicy = new ExternalCallPolicy({
      allowedHosts: ["open.feishu.cn"],
      maxConcurrency: 8,
      defaultTimeoutMs: 200,
      performanceLogger: perfLogger,
    });
    const adapter = new FeishuAdapter({
      appId: "cli_reentrant",
      appSecret: "sec",
      teamId: "team_1",
      channel: null,
      policy: sharedPolicy,
      http: {
        fetchResource: async () => ({
          stream: Readable.from(Buffer.from("ok")),
        }),
      },
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        sharedPolicy.run(`feishu.resource.outer.${idx}`, () =>
          adapter.fetchResource({
            messageExternalId: `msg-${idx}`,
            providerResourceKey: `key-${idx}`,
            kind: "file",
          }),
        ),
      ),
    );
    expect(results).toHaveLength(8);
    expect(logs).toHaveLength(16);
    expect(logs.filter((l) => l.payload.outcome === "completed")).toHaveLength(8);

    // Outer deadline aborts inner re-entrant action even when inner caller omits signal
    let innerSignal: AbortSignal | undefined;
    const deadlinePolicy = new ExternalCallPolicy({
      defaultTimeoutMs: 20,
      maxAttempts: 1,
      performanceLogger: perfLogger,
    });
    await expect(
      deadlinePolicy.run("feishu.resource.outer-timeout", () =>
        deadlinePolicy.run("feishu.resource.inner-timeout", (sig) => {
          innerSignal = sig;
          return new Promise(() => undefined);
        }),
      ),
    ).rejects.toMatchObject({
      code: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED",
    });
    expect(innerSignal?.aborted).toBe(true);

    // Completed outer attempt retires re-entrant context so detached async descendants acquire a new permit
    const singlePermitPolicy = new ExternalCallPolicy({
      maxConcurrency: 1,
      maxAttempts: 1,
      performanceLogger: perfLogger,
    });
    let releaseDescendantGate: () => void = () => undefined;
    const descendantGate = new Promise<void>((resolve) => {
      releaseDescendantGate = resolve;
    });
    let releaseHolderGate: () => void = () => undefined;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolderGate = resolve;
    });
    let holderAcquired: () => void = () => undefined;
    const holderAcquiredPromise = new Promise<void>((resolve) => {
      holderAcquired = resolve;
    });
    let lateChildStarted = false;
    let lateChildPromise: Promise<string> | undefined;

    await singlePermitPolicy.run("feishu.outer", async () => {
      void descendantGate.then(() => {
        lateChildPromise = singlePermitPolicy.run("feishu.late-child", async () => {
          lateChildStarted = true;
          return "late-ok";
        });
      });
    });

    const holderPromise = singlePermitPolicy.run("feishu.holder", async () => {
      holderAcquired();
      await holderGate;
      return "holder-ok";
    });
    await holderAcquiredPromise;

    releaseDescendantGate();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lateChildStarted).toBe(false);

    releaseHolderGate();
    await expect(holderPromise).resolves.toBe("holder-ok");
    await expect(lateChildPromise).resolves.toBe("late-ok");
    expect(lateChildStarted).toBe(true);
  });

  it("records attemptCount: 0 on pre-dispatch rejections and timedOut: true on owned deadlines (omitting timedOut on caller abort)", async () => {
    const { logs, perfLogger } = createLogCollector();

    const mcpFetcher = new McpOutboundFetcher({
      allowLoopback: false,
      timeoutMs: 25,
      performanceLogger: perfLogger,
      resolveAddresses: async () => ["93.184.216.34"],
      fetch: vi.fn((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        });
      }),
    });
    await expect(mcpFetcher.fetchOutbound("acc-1", "https://127.0.0.1/mcp")).rejects.toThrow();
    expect(logs.at(-1)?.payload).toMatchObject({
      externalService: "mcp",
      operation: "external.mcp.http",
      outcome: "failed",
      attemptCount: 0,
      retryCount: 0,
    });
    expect(logs.at(-1)?.payload.timedOut).toBeUndefined();

    logs.length = 0;
    await expect(mcpFetcher.fetchOutbound("acc-1", "https://mcp.example.com/sse")).rejects.toThrow();
    expect(logs.at(-1)?.payload).toMatchObject({
      externalService: "mcp",
      operation: "external.mcp.http",
      outcome: "failed",
      attemptCount: 1,
      retryCount: 0,
      timedOut: true,
    });

    logs.length = 0;
    const callerAbort = new AbortController();
    const pendingMcp = mcpFetcher.fetchOutbound("acc-1", "https://mcp.example.com/sse", {
      signal: callerAbort.signal,
    });
    callerAbort.abort();
    await expect(pendingMcp).rejects.toThrow();
    expect(logs.at(-1)?.payload.outcome).toBe("failed");
    expect(logs.at(-1)?.payload.timedOut).toBeUndefined();

    logs.length = 0;
    const skillFetcher = new SkillSourceFetcher({
      allowLoopback: false,
      timeoutMs: 25,
      performanceLogger: perfLogger,
      resolveAddresses: async () => ["93.184.216.34"],
      transport: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    await expect(skillFetcher.fetchBytes("https://127.0.0.1/skill.md")).rejects.toThrow();
    expect(logs.at(-1)?.payload).toMatchObject({
      externalService: "skill-source",
      operation: "external.skill-source.http",
      outcome: "failed",
      attemptCount: 0,
      retryCount: 0,
    });
    logs.length = 0;
    await expect(skillFetcher.fetchBytes("https://skills.example.com/SKILL.md")).rejects.toThrow();
    expect(logs.at(-1)?.payload).toMatchObject({
      externalService: "skill-source",
      operation: "external.skill-source.http",
      outcome: "failed",
      attemptCount: 1,
      retryCount: 0,
      timedOut: true,
    });

    logs.length = 0;
    const reporter = createErrorReporter({
      projectId: "demo-project",
      timeoutMs: 15,
      logger: () => undefined,
      performanceLogger: perfLogger,
      createClient: () => ({
        report: () => {
          // never invokes callback
        },
      }),
    });
    await reporter.report({
      source: "web",
      message: "client crash",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(logs.at(-1)?.payload).toMatchObject({
      externalService: "gcp-error-reporting",
      operation: "external.gcp.error-reporting.report",
      outcome: "failed",
      attemptCount: 1,
      retryCount: 0,
      timedOut: true,
    });

    logs.length = 0;
    const catalog = new RouterCloudModelCatalog({
      upstreamBaseUrl: "https://router.example.com/v1",
      masterKey: "secret-key",
      timeoutMs: 15,
      fetchImpl: createInstrumentedFetch(perfLogger, {
        provider: "cloud-router",
        baseFetch: vi.fn((_input, init) => {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted", "AbortError")),
              { once: true },
            );
          });
        }),
      }),
    });
    expect((await catalog.list()).available).toBe(false);
    expect(logs.at(-1)?.payload).toMatchObject({
      externalService: "cloud-router",
      operation: "external.cloud-router.http",
      outcome: "failed",
      timedOut: true,
    });
  });

  it("attributes RuntimeProviderProxy traffic to slack and feishu services, traces CloudImSteering, and isolates KeyedTaskScheduler lane contexts", async () => {
    const { logs, perfLogger } = createLogCollector();
    const baseFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-feishu", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const credServices = createRuntimeCredentialServices({
      database: {} as never,
      cipher: {} as never,
      registry: {
        isCurrentConnection: () => true,
        currentControlIdentity: () => undefined,
      } as never,
      custody: {} as never,
      fetchImpl: baseFetch,
      performanceLogger: perfLogger,
    });
    try {
      const feishuFetch = createInstrumentedFetch(perfLogger, { provider: "feishu", baseFetch });
      const slackFetch = createInstrumentedFetch(perfLogger, { provider: "slack", baseFetch });
      await (
        await feishuFetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { method: "POST" })
      ).json();
      await (await slackFetch("https://slack.com/api/chat.postMessage", { method: "POST" })).json();
    } finally {
      credServices.close();
    }
    expect(logs.some((l) => l.payload.externalService === "feishu" && l.payload.outcome === "completed")).toBe(true);
    expect(logs.some((l) => l.payload.externalService === "slack" && l.payload.outcome === "completed")).toBe(true);

    // CloudImSteering pre-dispatch rejection -> attemptCount: 0
    logs.length = 0;
    const steering = new CloudImSteering({
      database: {} as never,
      custody: {} as never,
      performanceLogger: perfLogger,
      connection: async () => undefined,
      current: () => false,
      validAllocation: async () => false,
      context: () => ({}) as never,
      send: () => false,
    });
    await expect(
      steering.request(
        {
          type: "im:steer",
          requestId: "00000000-0000-4000-8000-000000000010",
          deliveryId: "deliv-steer-1",
          imMessageId: "msg-steer-1",
          sessionId: "sess-steer-1",
          agentId: "agent-steer-1",
          placementGeneration: 1,
          rootDeliveryId: "root-deliv-1",
          expectedTurnId: "turn-steer-1",
          attention: "direct",
          content: {} as never,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        },
        () => undefined,
      ),
    ).rejects.toThrow("CLOUD_STEER_UNAVAILABLE");
    expect(logs.at(-1)?.payload).toMatchObject({
      externalService: "sandbox-runner",
      operation: "external.sandbox-runner.deliverySteer",
      agentId: "agent-steer-1",
      sessionId: "sess-steer-1",
      deliveryId: "deliv-steer-1",
      turnId: "turn-steer-1",
      outcome: "failed",
      attemptCount: 0,
      retryCount: 0,
    });

    // KeyedTaskScheduler isolates sibling tasks' PerformanceExecutionContext stores across a queued lane
    const scheduler = new KeyedTaskScheduler({
      maxConcurrent: 1,
      maxQueuedPerKey: 4,
      maxQueuedTotal: 8,
    });
    let observedInitialDeliveryInB: string | undefined = "unset";
    let observedFinalDeliveryInA: string | undefined;
    let observedFinalDeliveryInB: string | undefined;
    let finishB!: () => void;
    const bDone = new Promise<void>((resolve) => {
      finishB = resolve;
    });

    runWithPerformanceContext({ callId: "root-a", operation: "ImDeliveryWorker.runOnce" }, () => {
      scheduler.enqueue("lane-1", async () => {
        updateCurrentPerformanceContext({ deliveryId: "deliv-A", turnId: "turn-A" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        observedFinalDeliveryInA = getCurrentPerformanceContext()?.deliveryId;
      });
    });

    runWithPerformanceContext({ callId: "root-b", operation: "ImDeliveryWorker.runOnce" }, () => {
      scheduler.enqueue("lane-1", async () => {
        observedInitialDeliveryInB = getCurrentPerformanceContext()?.deliveryId;
        updateCurrentPerformanceContext({ deliveryId: "deliv-B", turnId: "turn-B" });
        observedFinalDeliveryInB = getCurrentPerformanceContext()?.deliveryId;
        finishB();
      });
    });

    await bDone;
    expect(observedInitialDeliveryInB).toBeUndefined();
    expect(observedFinalDeliveryInA).toBe("deliv-A");
    expect(observedFinalDeliveryInB).toBe("deliv-B");

    const hub = new RunnerHub({ performanceLogger: perfLogger });
    const fence = new CloudRuntimeFence();
    const collabScope = {
      sandboxId: "00000000-0000-4000-8000-000000000701",
      sessionId: "00000000-0000-4000-8000-000000000702",
      environmentGeneration: 1,
      resourceName: "projects/p/locations/l/instances/i-701",
    };
    const collabSocket = { send: vi.fn(), close: vi.fn() };
    hub.attach(collabScope, collabSocket);
    const collabConn = fence.attach({
      computerId: "comp-701",
      installationId: "inst-701",
      scope: collabScope,
      socket: collabSocket,
      executionEligible: true,
      sessionCollaborationEligible: true,
      sessionCollaborationVersion: 2,
    });
    const observedTurnIdsBeforeRead: Array<string | undefined> = [];
    const fakeDbQuery = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(async () => {
        observedTurnIdsBeforeRead.push(getCurrentPerformanceContext()?.turnId);
        return [];
      }),
    };
    const collabOwner = new CloudSessionCollaborationOwner({
      database: {
        select: () => fakeDbQuery,
      } as never,
      durableWork: {
        read: async () => {
          observedTurnIdsBeforeRead.push(getCurrentPerformanceContext()?.turnId);
          return undefined;
        },
        write: async () => undefined,
      },
      fence,
      hub,
      work: new CloudSessionWorkTracker(),
      assembler: { assembleForSession: async () => undefined as never },
      performanceLogger: perfLogger,
    });
    expect(collabOwner.activeDispatchTargets).toBe(0);

    await runWithPerformanceContext({ callId: "ws-1", operation: "runner.ws.frame session:message:received" }, () =>
      collabOwner.handleReceived(collabConn, {
        type: "session:message:received",
        requestId: "00000000-0000-4000-8000-000000000711",
        messageId: "00000000-0000-4000-8000-000000000712",
        turnId: "turn-seeded-received",
        status: "accepted",
        phase: "received",
      }),
    );
    await runWithPerformanceContext({ callId: "ws-2", operation: "runner.ws.frame session:message:settled" }, () =>
      collabOwner.handleSettled(collabConn, {
        type: "session:message:settled",
        requestId: "00000000-0000-4000-8000-000000000713",
        messageId: "00000000-0000-4000-8000-000000000714",
        turnId: "turn-seeded-settled",
        outcome: "completed",
      }),
    );
    expect(observedTurnIdsBeforeRead).toEqual(["turn-seeded-received", "turn-seeded-settled"]);
  });

  it("records distinct failure settlements for CloudDeliveryOwner.#queryRunner (no-socket, send-failed, and 10s deadline timeout)", async () => {
    const { logs, perfLogger } = createLogCollector();
    const hub = new RunnerHub({ performanceLogger: perfLogger });
    const fence = new CloudRuntimeFence();
    const queryScope = {
      sandboxId: "00000000-0000-4000-8000-000000000801",
      sessionId: "00000000-0000-4000-8000-000000000802",
      environmentGeneration: 1,
      resourceName: "projects/p/locations/l/instances/i-801",
    };
    let shouldThrowOnSend = false;
    const querySocket = {
      send: () => {
        if (shouldThrowOnSend) throw new Error("not writable");
      },
      close: () => undefined,
    };
    const queryConn = fence.attach({
      computerId: "comp-801",
      installationId: "inst-801",
      scope: queryScope,
      socket: querySocket,
      executionEligible: true,
    });
    const deliveryRow = {
      id: "deliv-q-1",
      sessionId: queryScope.sessionId,
      state: "accepted",
      reportedAt: null,
      turnId: "turn-q-1",
      reportOwnerInstanceId: queryConn.instanceId,
      dispatchPayload: null,
      acceptedAt: new Date(),
    };
    const sandboxRow = {
      id: queryScope.sandboxId,
      sessionId: queryScope.sessionId,
      environmentGeneration: 1,
      currentResourceName: queryScope.resourceName,
      currentResourceUid: "uid-801",
      lifecycle: "ready",
    };
    let selectCall = 0;
    const fakeQueryDb = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(async () => {
        selectCall += 1;
        return selectCall % 2 === 1 ? [deliveryRow] : [sandboxRow];
      }),
    };
    const deliveryOwner = new CloudDeliveryOwner({
      database: {
        select: () => fakeQueryDb,
      } as never,
      custody: {} as never,
      fence,
      hub,
      performanceLogger: perfLogger,
    });
    expect(deliveryOwner.isModelPathConfigured()).toBe(false);

    // 1) No socket attached to hub -> RUNNER_QUERY_SOCKET_UNAVAILABLE, attemptCount: 0
    expect(await deliveryOwner.recoverAccepted("deliv-q-1")).toBe("pending");
    expect(logs.at(-1)?.payload).toMatchObject({
      operation: "external.sandbox-runner.deliveryQuery",
      outcome: "failed",
      errorCode: "RUNNER_QUERY_SOCKET_UNAVAILABLE",
      attemptCount: 0,
      retryCount: 0,
    });
    expect(logs.at(-1)?.payload.timedOut).toBeUndefined();

    // 2) Socket attached, send throws -> RUNNER_QUERY_SEND_FAILED, attemptCount: 1
    logs.length = 0;
    hub.attach(queryScope, querySocket);
    shouldThrowOnSend = true;
    expect(await deliveryOwner.recoverAccepted("deliv-q-1")).toBe("pending");
    expect(logs.at(-1)?.payload).toMatchObject({
      operation: "external.sandbox-runner.deliveryQuery",
      outcome: "failed",
      errorCode: "RUNNER_QUERY_SEND_FAILED",
      attemptCount: 1,
      retryCount: 0,
    });
    expect(logs.at(-1)?.payload.timedOut).toBeUndefined();

    // 3) Socket send succeeds, 10s receipt timer expires -> RUNNER_QUERY_TIMEOUT, attemptCount: 1, timedOut: true
    logs.length = 0;
    shouldThrowOnSend = false;
    vi.useFakeTimers();
    try {
      const pendingRecover = deliveryOwner.recoverAccepted("deliv-q-1");
      await vi.advanceTimersByTimeAsync(10_005);
      expect(await pendingRecover).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
    expect(logs.at(-1)?.payload).toMatchObject({
      operation: "external.sandbox-runner.deliveryQuery",
      outcome: "failed",
      errorCode: "RUNNER_QUERY_TIMEOUT",
      attemptCount: 1,
      retryCount: 0,
      timedOut: true,
    });
  });

  it("traces CloudDeliveryOwner deliveryDispatch (attemptCount 0 on stale socket, 1 on send) and settles deliveryRun on handleDeliveryReceived", async () => {
    const { logs, perfLogger } = createLogCollector();
    const hub = new RunnerHub({ performanceLogger: perfLogger });
    const fence = new CloudRuntimeFence();
    const scope = {
      sandboxId: "00000000-0000-4000-8000-000000000811",
      sessionId: "00000000-0000-4000-8000-000000000812",
      environmentGeneration: 1,
      resourceName: "projects/p/locations/l/instances/i-811",
    };
    let throwOnSend = false;
    const socket = {
      send: () => {
        if (throwOnSend) throw new Error("socket closed");
      },
      close: () => undefined,
    };
    hub.attach(scope, socket);
    hub.markReady(
      scope,
      {
        sandboxName: "i-811",
        rootfs: "default",
        nodeVersion: "24.0.0",
        runnerVersion: "1.0.0",
        piVersion: "1.0.0",
        reportedAt: "2026-01-01T00:00:00.000Z",
      },
      socket,
    );
    const conn = fence.attach({
      computerId: "comp-811",
      installationId: "inst-811",
      scope,
      socket,
      executionEligible: true,
    });
    const sandboxRow = {
      id: scope.sandboxId,
      sessionId: scope.sessionId,
      environmentGeneration: 1,
      currentResourceName: scope.resourceName,
      currentResourceUid: "uid-811",
      lifecycle: "ready",
      idleReclaimAt: null,
    };
    let detachDuringSecondRead = false;
    let managedSelectCalls = 0;
    const fakeDispatchDb = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(async () => {
        managedSelectCalls += 1;
        if (detachDuringSecondRead && managedSelectCalls === 2) {
          hub.detach(scope.sandboxId, socket);
        }
        return [
          {
            sandbox: sandboxRow,
            sessionEndedAt: null,
            agentStatus: "active",
            bindingStatus: "active",
            suspendedAt: null,
            computerId: "comp-811",
            ownerAccountId: "acc-811",
            agentOwnerId: "acc-811",
            runtimeProvider: "pi",
          },
        ];
      }),
    };
    const owner = new CloudDeliveryOwner({
      database: {
        select: () => fakeDispatchDb,
      } as never,
      custody: {
        beginDeliveryDispatch: vi.fn(async () => "dispatched"),
        releaseDeliveryDispatch: vi.fn(async () => undefined),
      } as never,
      fence,
      hub,
      modelBaseUrl: "https://server.example.com/api/v1/cloud-model",
      modelGrants: {
        defaultModel: async () => "gpt-4o",
        isModelAllowed: async () => true,
        issue: async () => undefined,
        revokeExecution: () => 0,
      },
      performanceLogger: perfLogger,
    });
    const req = {
      type: "im:deliver" as const,
      requestId: "00000000-0000-4000-8000-000000000813",
      deliveryId: "00000000-0000-4000-8000-000000000814",
      imMessageId: "00000000-0000-4000-8000-000000000815",
      sessionId: scope.sessionId,
      agentId: "00000000-0000-4000-8000-000000000816",
      placementGeneration: 1,
      attention: "direct" as const,
      content: {
        kind: "text" as const,
        text: "hello",
        providerRef: {
          provider: "feishu" as const,
          teamBrand: "feishu" as const,
          appId: "app",
          botOpenId: "bot",
          chatId: "chat",
          messageId: "msg",
        },
      },
      runtime: { model: "gpt-4o" } as never,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };

    // 1) Stale socket detached before sendToCurrent -> attemptCount: 0
    detachDuringSecondRead = true;
    await expect(
      owner.dispatchDelivery({
        computerId: "comp-811",
        inputHash: "a".repeat(64),
        installationId: "inst-811",
        request: req,
      }),
    ).rejects.toMatchObject({ code: "send_failed" });
    expect(logs.at(-1)?.payload).toMatchObject({
      operation: "external.sandbox-runner.deliveryDispatch",
      outcome: "failed",
      attemptCount: 0,
      retryCount: 0,
    });

    // 2) Reattach socket, throw on socket.send -> attemptCount: 1
    logs.length = 0;
    detachDuringSecondRead = false;
    hub.attach(scope, socket);
    hub.markReady(
      scope,
      {
        sandboxName: "i-811",
        rootfs: "default",
        nodeVersion: "24.0.0",
        runnerVersion: "1.0.0",
        piVersion: "1.0.0",
        reportedAt: "2026-01-01T00:00:00.000Z",
      },
      socket,
    );
    throwOnSend = true;
    await expect(
      owner.dispatchDelivery({
        computerId: "comp-811",
        inputHash: "a".repeat(64),
        installationId: "inst-811",
        request: req,
      }),
    ).rejects.toMatchObject({ code: "send_failed" });
    expect(logs.at(-1)?.payload).toMatchObject({
      operation: "external.sandbox-runner.deliveryDispatch",
      outcome: "failed",
      attemptCount: 1,
      retryCount: 0,
    });

    // 3) Reattach socket, send persisted request twice before receipt -> aggregates attemptCount: 2, retryCount: 1
    logs.length = 0;
    throwOnSend = false;
    hub.attach(scope, socket);
    hub.markReady(
      scope,
      {
        sandboxName: "i-811",
        rootfs: "default",
        nodeVersion: "24.0.0",
        runnerVersion: "1.0.0",
        piVersion: "1.0.0",
        reportedAt: "2026-01-01T00:00:00.000Z",
      },
      socket,
    );
    await owner.dispatchDelivery({
      computerId: "comp-811",
      inputHash: "a".repeat(64),
      installationId: "inst-811",
      request: req,
    });
    await owner.dispatchDelivery({
      computerId: "comp-811",
      inputHash: "a".repeat(64),
      installationId: "inst-811",
      request: req,
    });
    expect(
      logs.filter(
        (l) => l.payload.operation === "external.sandbox-runner.deliveryDispatch" && l.payload.outcome === "completed",
      ),
    ).toHaveLength(2);
    expect(
      logs.filter(
        (l) => l.payload.operation === "external.sandbox-runner.deliveryRun" && l.payload.outcome === "started",
      ),
    ).toHaveLength(1);
    expect(
      logs.filter(
        (l) => l.payload.operation === "external.sandbox-runner.deliveryRun" && l.payload.outcome === "completed",
      ),
    ).toHaveLength(0);

    await owner.handleDeliveryReceived(conn, {
      deliveryId: req.deliveryId,
      requestId: req.requestId,
      turnId: "turn-811",
    });
    await owner.handleDeliveryReceived(conn, {
      deliveryId: req.deliveryId,
      requestId: req.requestId,
      turnId: "turn-811",
    });
    const deliveryRunCompletions = logs.filter(
      (l) => l.payload.operation === "external.sandbox-runner.deliveryRun" && l.payload.outcome === "completed",
    );
    expect(deliveryRunCompletions).toHaveLength(1);
    expect(deliveryRunCompletions[0]?.payload).toMatchObject({
      deliveryId: req.deliveryId,
      turnId: "turn-811",
      attemptCount: 2,
      retryCount: 1,
    });

    // 4) No receipt before request.deadlineAt -> settles as failed with RUNNER_DELIVERY_RUN_TIMEOUT, timedOut: true
    logs.length = 0;
    const timeoutReq = {
      ...req,
      requestId: "00000000-0000-4000-8000-000000000819",
      deadlineAt: new Date(Date.now() + 20).toISOString(),
    };
    await owner.dispatchDelivery({
      computerId: "comp-811",
      inputHash: "a".repeat(64),
      installationId: "inst-811",
      request: timeoutReq,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(
      logs.find((l) => l.payload.operation === "external.sandbox-runner.deliveryRun" && l.payload.outcome === "failed")
        ?.payload,
    ).toMatchObject({
      errorCode: "RUNNER_DELIVERY_RUN_TIMEOUT",
      timedOut: true,
      attemptCount: 1,
      retryCount: 0,
    });
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
            deliveryId: "deliv-turn",
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
        contextForExecution: createCloudExecutionContext({
          select: () => ({
            from: () => ({
              innerJoin: () => ({
                innerJoin: () => ({
                  innerJoin: () => ({
                    where: () => ({
                      limit: async () => [
                        {
                          accountId: "acc-turn",
                          agentId: "agent-turn",
                          sessionId,
                        },
                      ],
                    }),
                  }),
                }),
              }),
            }),
          }),
        } as never),
        modelService: new CloudModelService(
          {
            enabled: true,
            upstreamBaseUrl: "https://router.example.com/v1",
            masterKey: "secret-master-key",
            requestTimeoutMs: 5_000,
            maxRequestBytes: 65_536,
            maxResponseBytes: 65_536,
            maxStreamsPerToken: 2,
            tokenTtlSeconds: 300,
          },
          {
            calls: {
              create: vi.fn(async () => "00000000-0000-4000-8000-000000000881"),
              finalize: vi.fn(async () => undefined),
              markPending: vi.fn(async () => undefined),
            } as never,
            onError: () => undefined,
            fetchImpl: createInstrumentedFetch(
              createPerformanceLogger(() => app.log),
              {
                provider: "cloud-router",
                baseFetch: vi.fn(
                  async () =>
                    new Response(JSON.stringify({ id: "cmpl-1", choices: [] }), {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    }),
                ),
              },
            ),
          },
        ),
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

    const rawLines = chunks.flatMap((c) => c.trim().split("\n")).filter(Boolean);
    const records = rawLines.map((line) => JSON.parse(line) as Record<string, unknown>);

    const mcpExternalLine = rawLines.find(
      (line) => line.includes('"operation":"external.mcp.http"') && line.includes('"outcome":"completed"'),
    );
    expect(mcpExternalLine).toContain('"service":"opentag-server"');
    expect(mcpExternalLine?.match(/"service":/g)).toHaveLength(1);
    expect(mcpExternalLine).toContain('"externalService":"mcp"');

    const mcpExternal = records.find((r) => r.operation === "external.mcp.http" && r.outcome === "completed");
    expect(mcpExternal).toMatchObject({
      service: "opentag-server",
      externalService: "mcp",
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

    const cloudRouterExternal = records.find(
      (r) => r.operation === "external.cloud-router.http" && r.outcome === "completed",
    );
    expect(cloudRouterExternal).toMatchObject({
      service: "opentag-server",
      externalService: "cloud-router",
      accountId: "acc-turn",
      agentId: "agent-turn",
      sessionId,
      sandboxId,
      turnId: "turn-1",
      deliveryId: "deliv-turn",
      attemptCount: 1,
      retryCount: 0,
    });
  });
});
