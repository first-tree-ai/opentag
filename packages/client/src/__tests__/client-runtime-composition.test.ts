import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DirectImMessageDeliveryRequest,
  EffectiveRuntimeSnapshot,
  SessionReconcileRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AgentRuntime, AgentRuntimeFactory } from "../agent-runtime/types.js";
import { createLogger } from "../observability/logger.js";
import { CODEX_AGENT_RUNTIME_APP_SERVER_ARGS } from "../providers/codex/agent-runtime.js";
import {
  ComposedClientRuntime,
  createClientRuntime,
  createClientRuntimeHandlers,
  createClientRuntimePreflight,
  resolveCodexHome,
  resolvedCodexFactory,
  resolveExecutable,
  serializeReadiness,
} from "../runtime/client-runtime-composition.js";
import { RuntimeConnection } from "../runtime/runtime-connection.js";
import { RuntimeStorageError } from "../storage/durable-file.js";

const fixture = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const directories: string[] = [];
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createClientRuntime production composition", () => {
  it("runs readiness and Session creation through the resolved, hardened Codex Agent Runtime factory", async () => {
    const home = await temporaryDirectory("opentag-client-composition-");
    const codexHome = resolve(home, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(resolve(codexHome, "auth.json"), "{}", "utf8");
    const argsLog = resolve(home, "codex-args.log");
    const command = resolve(home, "codex-fixture");
    await writeFile(
      command,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsLog}'\nif [ "$1" = "--version" ]; then echo 'codex-cli fixture'; exit 0; fi\nif [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi\nexec '${process.execPath}' '${fixture}'\n`,
      "utf8",
    );
    await chmod(command, 0o755);

    const connection = runtimeConnection();
    const runtime = await createClientRuntime(connection, {
      clientVersion: "0.0.1",
      codexCommand: command,
      codexHome,
      environment: { HOME: home, PATH: process.env.PATH },
      home,
    });
    expect(runtime.messageToolAvailable).toBe(true);
    const result = await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()));
    expect(result).toMatchObject({ status: "ready" });
    expect(await runtime.bindingStore.read("agent-1", "session-1")).toMatchObject({
      schemaVersion: 2,
      runtimeBinding: { providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-1" } },
    });
    const launches = (await readFile(argsLog, "utf8")).trim().split("\n");
    expect(launches).toContain("--version");
    expect(launches).toContain("app-server --help");
    expect(launches).toContain("login status");
    expect(launches.filter((line) => line === CODEX_AGENT_RUNTIME_APP_SERVER_ARGS.join(" "))).toHaveLength(2);

    await runtime.runtimeManager.close();
    runtime.reportOwner.stop();
    runtime.toolHost.close();
  });

  it("keeps the daemon composable and rejects Session placement when Codex is unavailable", async () => {
    const home = await temporaryDirectory("opentag-client-unavailable-");
    const connection = runtimeConnection();
    const runtime = await createClientRuntime(connection, {
      clientVersion: "0.0.1",
      codexCommand: resolve(home, "missing-codex"),
      codexHome: resolve(home, "codex-home"),
      environment: { HOME: home, PATH: process.env.PATH },
      home,
    });
    expect(runtime.messageToolAvailable).toBe(false);
    await expect(
      runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot())),
    ).resolves.toMatchObject({ status: "rejected", reason: "provider_unavailable" });
    runtime.stop();
    runtime.reportOwner.stop();
  });

  it("uses HOME when CODEX_HOME is absent", () => {
    expect(resolveCodexHome({ HOME: "/provider-home" })).toBe(resolve("/provider-home/.codex"));
    expect(resolveCodexHome({ CODEX_HOME: "/explicit-provider-home", HOME: "/ignored" })).toBe(
      resolve("/explicit-provider-home"),
    );
    expect(resolveCodexHome()).toEqual(expect.any(String));
    expect(resolveCodexHome({})).toBe(resolve(homedir(), ".codex"));
  });

  it("fails closed for unregistered providers and caller cancellation during initial readiness", async () => {
    const home = await temporaryDirectory("opentag-client-composition-fences-");
    await expect(
      createClientRuntime(runtimeConnection(), {
        clientVersion: "0.0.1",
        codexHome: resolve(home, "wrong-provider-home"),
        environment: {},
        factory: readyFactory("claude-code"),
        home,
      }),
    ).rejects.toThrow("only registers the reviewed Codex provider");

    const controller = new AbortController();
    const error = new Error("cancel readiness");
    const cancelling = readyFactory("codex", async () => {
      controller.abort(error);
      throw error;
    });
    await expect(
      createClientRuntime(runtimeConnection(), {
        clientVersion: "0.0.1",
        codexHome: resolve(home, "cancelled-home"),
        environment: {},
        factory: cancelling,
        home,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancel readiness");
  });

  it("detects Provider Home replacement after readiness and supports default environment/logger composition", async () => {
    const home = await temporaryDirectory("opentag-client-composition-identity-");
    const codexHome = resolve(home, "codex-home");
    const replacement = resolve(home, "replacement");
    await mkdir(codexHome);
    await mkdir(replacement);
    const replacing = readyFactory("codex", async () => {
      await rm(codexHome, { recursive: true });
      await symlink(replacement, codexHome);
      return { ready: true, issues: [] };
    });
    const replaced = await createClientRuntime(runtimeConnection(), {
      capabilityRefreshIntervalMs: 1,
      clientVersion: "0.0.1",
      codexHome,
      environment: {},
      factory: replacing,
      home,
      logger: { child: () => createLogger("composition-child") } as never,
      signal: new AbortController().signal,
    });
    expect(replaced.messageToolAvailable).toBe(false);
    replaced.stop();
    replaced.stop();

    const defaultEnvironment = await createClientRuntime(runtimeConnection(), {
      clientVersion: "0.0.1",
      codexHome: resolve(home, "default-environment-home"),
      factory: readyFactory(),
      home,
    });
    defaultEnvironment.stop();
  });

  it("tests executable resolution and the resolved factory readiness fence without a shell", async () => {
    const home = await temporaryDirectory("opentag-client-executable-");
    const empty = resolve(home, "empty");
    const bin = resolve(home, "bin");
    await mkdir(empty);
    await mkdir(bin);
    const command = resolve(bin, "codex-fixture");
    await writeFile(command, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(command, 0o755);
    const canonicalCommand = await realpath(command);
    await expect(resolveExecutable(command, {})).resolves.toBe(canonicalCommand);
    await expect(resolveExecutable("codex-fixture", { PATH: `${delimiter}${empty}${delimiter}${bin}` })).resolves.toBe(
      canonicalCommand,
    );
    await expect(resolveExecutable("missing", {})).rejects.toThrow("PATH is unavailable");
    await expect(resolveExecutable("missing", { PATH: empty })).rejects.toThrow("compatible Codex executable");

    const factory = resolvedCodexFactory({
      clientVersion: "0.0.1",
      codexHome: home,
      command: resolve(home, "missing-absolute"),
      environment: {},
      sourceEnvironment: {},
    });
    expect(() => factory.create({} as never)).toThrow("readiness has not been established");
    expect(() => factory.resume({} as never)).toThrow("readiness has not been established");
    await expect(factory.probe({})).resolves.toMatchObject({ ready: false, issues: [{ code: "artifact_missing" }] });
    const aborted = new AbortController();
    aborted.abort(new Error("stop resolution"));
    await expect(factory.probe({ signal: aborted.signal })).rejects.toThrow("stop resolution");
  });

  it("unit-tests composition delegates and every preflight outcome", async () => {
    const accepted = { result: { status: "accepted" } };
    const custody = { accept: vi.fn(async () => accepted) };
    const reportOwner = { handleResult: vi.fn(async () => "handled") };
    const recovery = {
      afterReconciled: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      prepare: vi.fn(async (_request, result) => result),
    };
    const handlers = createClientRuntimeHandlers(custody as never, reportOwner as never, recovery as never);
    await expect(handlers.handleDelivery({} as never)).resolves.toBe(accepted);
    await expect(handlers.handleTurnReportResult({} as never)).resolves.toBeUndefined();
    await expect(handlers.prepareReconcileResult({} as never, { status: "ready" } as never)).resolves.toEqual({
      status: "ready",
    });
    await expect(
      handlers.onReconcileResultSendFailed({} as never, {} as never, new Error("send")),
    ).resolves.toBeUndefined();
    await expect(handlers.onReconciled({} as never, {} as never)).resolves.toBeUndefined();

    const request = delivery(snapshot());
    const ensureProviderReady = vi.fn(async () => undefined);
    const runtime = vi.fn(() => ({ state: { phase: "idle" } }));
    const verifyAgent = vi.fn(async () => undefined);
    const validate = vi.fn(() => undefined as "configuration_unsupported" | undefined);
    const preflight = createClientRuntimePreflight({
      ensureProviderReady,
      isProviderReady: () => false,
      runtimeManager: { runtime, validate } as never,
      workspace: { verifyAgent } as never,
    });
    await expect(preflight(request)).resolves.toBeUndefined();
    expect(ensureProviderReady).toHaveBeenCalledOnce();
    expect(verifyAgent).toHaveBeenCalledOnce();
    expect(runtime).toHaveBeenCalledWith("session-1");

    validate.mockReturnValue("configuration_unsupported");
    await expect(preflight(request)).resolves.toBe("configuration_unsupported");

    validate.mockReturnValue(undefined);
    verifyAgent.mockRejectedValueOnce(new RuntimeStorageError("conflict", "binding conflict"));
    await expect(preflight(request)).resolves.toBe("session_binding_conflict");
    verifyAgent.mockRejectedValueOnce(new Error("provider failed"));
    await expect(preflight(request)).resolves.toBe("provider_unavailable");

    const alreadyReady = createClientRuntimePreflight({
      ensureProviderReady,
      isProviderReady: () => true,
      runtimeManager: { runtime, validate } as never,
      workspace: { verifyAgent: vi.fn(async () => undefined) } as never,
    });
    await expect(alreadyReady(request)).resolves.toBeUndefined();
  });

  it("deduplicates concurrent readiness work and permits a fresh probe after settlement", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const operation = vi.fn(() => gate);
    const readiness = serializeReadiness(operation);
    const first = readiness();
    const second = readiness();
    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledOnce();
    release();
    await first;
    await readiness();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("covers ComposedClientRuntime monitor guards with deterministic component doubles", async () => {
    const runtime = { run: vi.fn(async () => undefined), stop: vi.fn() };
    const components = {
      bindingStore: {},
      custody: {},
      messageToolAvailable: true,
      reconciler: {},
      reportOwner: { stop: vi.fn() },
      runner: { settled: vi.fn(async () => undefined), stop: vi.fn() },
      runtimeManager: { close: vi.fn(async () => undefined) },
      toolHost: { close: vi.fn() },
      workspace: {},
      refreshCapability: vi.fn(async () => undefined),
      capabilityRefreshIntervalMs: 10,
      capabilityAbort: new AbortController(),
    };
    const stopped = new ComposedClientRuntime(runtime as never, components as never);
    stopped.stop();
    stopped.stop();
    await expect(stopped.run()).resolves.toBeUndefined();

    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const concurrentRuntime = { run: vi.fn(() => gate), stop: vi.fn() };
    const concurrent = new ComposedClientRuntime(
      concurrentRuntime as never,
      {
        ...components,
        capabilityAbort: new AbortController(),
      } as never,
    );
    const first = concurrent.run();
    const second = concurrent.run();
    release();
    await Promise.all([first, second]);

    let finishRuntime!: () => void;
    const runtimeGate = new Promise<void>((resolveRuntime) => {
      finishRuntime = resolveRuntime;
    });
    let startRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolveStarted) => {
      startRefresh = resolveStarted;
    });
    let finishRefresh!: () => void;
    const refreshGate = new Promise<void>((resolveRefresh) => {
      finishRefresh = resolveRefresh;
    });
    const refreshing = new ComposedClientRuntime(
      { run: () => runtimeGate, stop: vi.fn() } as never,
      {
        ...components,
        capabilityAbort: new AbortController(),
        refreshCapability: () => {
          startRefresh();
          return refreshGate;
        },
      } as never,
    );
    const running = refreshing.run();
    await refreshStarted;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    finishRuntime();
    await Promise.resolve();
    finishRefresh();
    await running;
  });

  it("revokes and restores the advertised message-tool capability after fresh Provider probes", async () => {
    const home = await temporaryDirectory("opentag-client-capability-");
    const server = await runtimeServer();
    cleanup.push(server.close);
    const connection = runtimeConnection(server.url);
    const observed: number[] = [];
    let ready = true;
    const factory = {
      manifest: {
        providerId: "codex",
        displayName: "Codex fixture",
        contractVersion: 1,
        bindingSchemaVersion: 1,
      },
      probe: async () => ({
        ready,
        issues: ready ? [] : [{ code: "artifact_missing" as const, message: "unavailable" }],
      }),
      create: async () => {
        throw new Error("not used");
      },
      resume: async () => {
        throw new Error("not used");
      },
    } satisfies AgentRuntimeFactory;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
          socket.send(
            JSON.stringify({
              type: "server:welcome",
              protocolVersion: 1,
              capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imMessageTool: 1 },
              heartbeatIntervalMs: 10,
              heartbeatTimeoutMs: 100,
            }),
          );
          return;
        }
        if (frame.type === "computer:register") {
          observed.push((frame.capabilities as { imMessageTool: number }).imMessageTool);
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          return;
        }
        if (frame.type === "heartbeat") {
          observed.push((frame.capabilities as { imMessageTool: number }).imMessageTool);
          socket.send(
            JSON.stringify({
              type: "heartbeat:result",
              requestId: frame.requestId,
              ok: true,
              serverTime: new Date().toISOString(),
            }),
          );
        }
      });
    });
    const runtime = await createClientRuntime(connection, {
      capabilityRefreshIntervalMs: 10,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory,
      home,
    });
    const running = runtime.run();
    await vi.waitFor(() => expect(observed[0]).toBe(1));
    ready = false;
    await vi.waitFor(() => expect(observed).toContain(0));
    ready = true;
    await vi.waitFor(() => expect(observed.slice(observed.indexOf(0) + 1)).toContain(1));
    runtime.stop();
    await running;
  });

  it("aborts and settles an in-flight periodic Provider probe before shutdown completes", async () => {
    const home = await temporaryDirectory("opentag-client-probe-stop-");
    const server = await runtimeServer();
    cleanup.push(server.close);
    const connection = runtimeConnection(server.url);
    const capabilityUpdates = vi.spyOn(connection, "setVerifiedCapabilities");
    let probeCount = 0;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      refreshStarted = resolveStarted;
    });
    let probeOwnerClosed = false;
    const factory = {
      manifest: {
        providerId: "codex",
        displayName: "Codex fixture",
        contractVersion: 1,
        bindingSchemaVersion: 1,
      },
      probe: vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
        probeCount += 1;
        if (probeCount === 1) return { ready: true, issues: [] };
        refreshStarted();
        return new Promise<never>((_resolve, reject) => {
          const abort = () => {
            probeOwnerClosed = true;
            reject(signal?.reason ?? new Error("aborted"));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }),
      create: async () => {
        throw new Error("not used");
      },
      resume: async () => {
        throw new Error("not used");
      },
    } satisfies AgentRuntimeFactory;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
          socket.send(
            JSON.stringify({
              type: "server:welcome",
              protocolVersion: 1,
              capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imMessageTool: 1 },
              heartbeatIntervalMs: 10,
              heartbeatTimeoutMs: 100,
            }),
          );
          return;
        }
        if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          return;
        }
        if (frame.type === "heartbeat") {
          socket.send(
            JSON.stringify({
              type: "heartbeat:result",
              requestId: frame.requestId,
              ok: true,
              serverTime: new Date().toISOString(),
            }),
          );
        }
      });
    });
    const runtime = await createClientRuntime(connection, {
      capabilityRefreshIntervalMs: 10,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory,
      home,
    });
    const running = runtime.run();
    await started;

    runtime.stop();
    await expect(running).resolves.toBeUndefined();
    expect(probeOwnerClosed).toBe(true);
    expect(factory.probe).toHaveBeenCalledTimes(2);
    const updatesAfterStop = capabilityUpdates.mock.calls.length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    expect(capabilityUpdates).toHaveBeenCalledTimes(updatesAfterStop);
  });

  it("waits for deferred Provider creation and closes the late runtime when stop races reconcile", async () => {
    const home = await temporaryDirectory("opentag-client-close-join-");
    const server = await runtimeServer();
    cleanup.push(server.close);
    const connection = runtimeConnection(server.url);
    let registered!: () => void;
    const registration = new Promise<void>((resolveRegistration) => {
      registered = resolveRegistration;
    });
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
          socket.send(
            JSON.stringify({
              type: "server:welcome",
              protocolVersion: 1,
              capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imMessageTool: 1 },
              heartbeatIntervalMs: 10,
              heartbeatTimeoutMs: 100,
            }),
          );
          return;
        }
        if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          registered();
        }
      });
    });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolveCreate) => {
      releaseCreate = resolveCreate;
    });
    let createStarted!: () => void;
    const createStart = new Promise<void>((resolveStarted) => {
      createStarted = resolveStarted;
    });
    let closeCalls = 0;
    const state = { phase: "idle" as "idle" | "closed", queuedRunCount: 0 };
    const agentRuntime: AgentRuntime = {
      manifest: { providerId: "codex", displayName: "Codex", contractVersion: 1, bindingSchemaVersion: 1 },
      capabilities: { steer: "unsupported", interactions: "unsupported" },
      state,
      binding: { providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-1" } },
      prompt: async (request) => ({ runId: request.runId, status: "completed", output: [] }),
      followUp: async (request) => ({ runId: request.runId, status: "completed", output: [] }),
      steer: async () => undefined,
      respond: async () => undefined,
      abort: async () => undefined,
      waitForIdle: async () => undefined,
      close: async () => {
        closeCalls += 1;
        state.phase = "closed";
      },
    };
    const factory = {
      manifest: agentRuntime.manifest,
      probe: async () => ({ ready: true, issues: [] }),
      create: async (request: Parameters<AgentRuntimeFactory["create"]>[0]) => {
        if (!agentRuntime.binding) throw new Error("missing binding");
        await request.eventSink({ type: "binding_changed", binding: agentRuntime.binding });
        createStarted();
        await createGate;
        return agentRuntime;
      },
      resume: async () => agentRuntime,
    } satisfies AgentRuntimeFactory;
    const runtime = await createClientRuntime(connection, {
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory,
      home,
    });
    const running = runtime.run();
    await registration;
    const request = reconcileRequest(connection.computerId, snapshot());
    const reconciling = runtime.reconciler.reconcile(request);
    await createStart;

    runtime.stop();
    let runSettled = false;
    void running.then(() => {
      runSettled = true;
    });
    await Promise.resolve();
    expect(runSettled).toBe(false);
    expect(closeCalls).toBe(0);

    releaseCreate();
    await expect(reconciling).rejects.toThrow("manager is closing");
    await running;
    expect(closeCalls).toBe(1);
    expect(() => runtime.runtimeManager.runtime("session-1")).toThrow("manager is closing");
    await expect(runtime.reconciler.reconcile({ ...request, requestId: randomUUID() })).rejects.toThrow(
      "manager is closing",
    );
  });
});

function runtimeConnection(serverUrl = "http://127.0.0.1:3000"): RuntimeConnection {
  return new RuntimeConnection({
    arch: "arm64",
    clientVersion: "0.0.1",
    computer: {
      version: 1,
      computerId: randomUUID(),
      serverUrl,
      userId: randomUUID(),
    },
    displayName: "test",
    instanceId: randomUUID(),
    platform: "darwin",
    tokenProvider: {
      getAccessTokenLease: async () => ({
        accessToken: "unused",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    },
  });
}

async function runtimeServer(): Promise<{ close(): Promise<void>; url: string; wss: WebSocketServer }> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolveListen) => http.listen(0, "127.0.0.1", resolveListen));
  const address = http.address() as AddressInfo;
  return {
    wss,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
      await new Promise<void>((resolveClose, reject) =>
        http.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function reconcileRequest(computerId: string, runtime: EffectiveRuntimeSnapshot): SessionReconcileRequest {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready",
    runtime,
  };
}

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId: "agent-1",
    provider: "codex",
    instructions: { platform: "platform", agent: "agent", session: "session" },
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}

function delivery(runtime: EffectiveRuntimeSnapshot): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: "delivery-1",
    imMessageId: "message-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: "hello" },
    runtime,
  };
}

function readyFactory(
  providerId = "codex",
  probe: AgentRuntimeFactory["probe"] = async () => ({ ready: true, issues: [] }),
): AgentRuntimeFactory {
  return {
    manifest: { providerId, displayName: providerId, contractVersion: 1, bindingSchemaVersion: 1 },
    probe,
    create: async () => {
      throw new Error("not used");
    },
    resume: async () => {
      throw new Error("not used");
    },
  };
}
