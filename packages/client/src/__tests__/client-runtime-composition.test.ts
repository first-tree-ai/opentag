import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  type SessionReconcileRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { AgentRuntime, AgentRuntimeFactory } from "../agent-runtime/types.js";
import { createLogger } from "../observability/logger.js";
import { claudeCodeRuntimePolicy, validateClaudeCodeRuntimePolicy } from "../providers/claude-code/runtime-policy.js";
import { CODEX_AGENT_RUNTIME_APP_SERVER_ARGS } from "../providers/codex/agent-runtime.js";
import { AgentRuntimeProviderRegistry } from "../runtime/agent-runtime-provider-registry.js";
import {
  ComposedClientRuntime,
  codexProviderReadiness,
  createClientRuntime,
  createClientRuntimeHandlers,
  createClientRuntimePreflight,
  probeImCliReadiness,
  refreshImCliReadiness,
  resolveAgentRuntimeProviders,
  resolveCodexHome,
  resolvedClaudeCodeFactory,
  resolvedCodexFactory,
  resolveExecutable,
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
  it("resolves the production Agent Runtime factories without a Server connection", async () => {
    const home = await temporaryDirectory("opentag-provider-composition-");
    const environment = { HOME: home };

    const resolved = await resolveAgentRuntimeProviders({ clientVersion: "0.0.0-test", environment });

    expect(resolved.factories.map((factory) => factory.manifest.providerId)).toEqual(["codex", "claude-code"]);
    expect(resolved.providerHomes).toEqual({
      codex: resolve(home, ".codex"),
      "claude-code": resolve(home, ".claude"),
    });
    expect(resolved.artifactIdentities.codex).toBe(
      createHash("sha256").update(resolved.providerHomes.codex, "utf8").digest("hex"),
    );
    await expect(resolved.factories[0]?.probe({})).resolves.toEqual({
      ready: false,
      issues: [{ code: "artifact_missing", message: "Codex CLI could not be executed" }],
    });
  });

  it("names provider homes it must not create, and still surfaces a broken one", async () => {
    const home = await temporaryDirectory("opentag-provider-read-only-");

    const resolved = await resolveAgentRuntimeProviders({
      clientVersion: "0.0.0-test",
      ensureProviderHomes: false,
      environment: { HOME: home },
    });

    expect(resolved.providerHomes).toEqual({
      codex: resolve(home, ".codex"),
      "claude-code": resolve(home, ".claude"),
    });
    await expect(stat(resolve(home, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(home, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });

    // A home that cannot exist is a real fault rather than a home waiting to be created.
    const file = resolve(home, "not-a-directory");
    await writeFile(file, "", "utf8");
    await expect(
      resolveAgentRuntimeProviders({
        clientVersion: "0.0.0-test",
        ensureProviderHomes: false,
        environment: { HOME: file },
      }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("observes messaging CLI readiness without publishing it", async () => {
    const home = await temporaryDirectory("opentag-im-cli-probe-");
    const lark = resolve(home, "lark-cli");
    await writeFile(
      lark,
      '#!/bin/sh\nif [ "$1" = "--version" ] || { [ "$1" = "im" ] && [ "$2" = "--help" ]; }; then exit 0; fi\nexit 1\n',
      "utf8",
    );
    await chmod(lark, 0o755);

    await expect(probeImCliReadiness("feishu", lark, {})).resolves.toBe("ready");
    await expect(probeImCliReadiness("slack", lark, {})).resolves.toBe("unavailable");
    await expect(probeImCliReadiness("feishu", resolve(home, "missing"), {})).resolves.toBe("install");
  });

  it("probes Feishu and Slack CLI readiness independently from Agent Runtime providers", async () => {
    const home = await temporaryDirectory("opentag-im-cli-readiness-");
    const lark = resolve(home, "lark-cli");
    const slack = resolve(home, "slack");
    const brokenSlack = resolve(home, "broken-slack");
    await writeFile(
      lark,
      '#!/bin/sh\nif [ "$1" = "--version" ] || { [ "$1" = "im" ] && [ "$2" = "--help" ]; }; then exit 0; fi\nexit 1\n',
      "utf8",
    );
    await writeFile(
      slack,
      '#!/bin/sh\nif [ "$1" = "version" ] || { [ "$1" = "api" ] && [ "$2" = "--help" ]; }; then exit 0; fi\nexit 1\n',
      "utf8",
    );
    await writeFile(brokenSlack, "#!/bin/sh\nexit 1\n", "utf8");
    await Promise.all([chmod(lark, 0o700), chmod(slack, 0o700), chmod(brokenSlack, 0o700)]);
    const setImCliReadiness = vi.fn();

    await refreshImCliReadiness({ setImCliReadiness } as never, "feishu", lark, {});
    await refreshImCliReadiness({ setImCliReadiness } as never, "slack", slack, {});
    await refreshImCliReadiness({ setImCliReadiness } as never, "slack", brokenSlack, {});
    await refreshImCliReadiness({ setImCliReadiness } as never, "slack", resolve(home, "missing"), {});

    expect(setImCliReadiness.mock.calls.map(([observation]) => observation)).toEqual([
      { provider: "feishu", status: "checking" },
      { provider: "feishu", status: "ready" },
      { provider: "slack", status: "checking" },
      { provider: "slack", status: "ready" },
      { provider: "slack", status: "checking" },
      { provider: "slack", status: "unavailable" },
      { provider: "slack", status: "checking" },
      { provider: "slack", status: "install" },
    ]);

    const abortedBeforeStart = new AbortController();
    abortedBeforeStart.abort(new Error("stop before IM probe"));
    await refreshImCliReadiness({ setImCliReadiness } as never, "feishu", lark, {}, abortedBeforeStart.signal);
    expect(setImCliReadiness).toHaveBeenCalledTimes(8);

    const abortAfterChecking = new AbortController();
    const checkingUpdates = vi.fn((observation: { status: string }) => {
      if (observation.status === "checking") abortAfterChecking.abort(new Error("stop after checking"));
    });
    await refreshImCliReadiness(
      { setImCliReadiness: checkingUpdates } as never,
      "feishu",
      lark,
      {},
      abortAfterChecking.signal,
    );
    expect(checkingUpdates.mock.calls.map(([observation]) => observation)).toEqual([
      { provider: "feishu", status: "checking" },
    ]);

    const slowLark = resolve(home, "slow-lark");
    await writeFile(slowLark, "#!/bin/sh\nsleep 1\nexit 0\n", "utf8");
    await chmod(slowLark, 0o700);
    const abortDuringProbe = new AbortController();
    const inFlightUpdates = vi.fn();
    const inFlight = refreshImCliReadiness(
      { setImCliReadiness: inFlightUpdates } as never,
      "feishu",
      slowLark,
      {},
      abortDuringProbe.signal,
    );
    await vi.waitFor(() => expect(inFlightUpdates).toHaveBeenCalledWith({ provider: "feishu", status: "checking" }));
    abortDuringProbe.abort(new Error("stop during IM probe"));
    await inFlight;
    expect(inFlightUpdates).toHaveBeenCalledTimes(1);
  });

  it("projects Codex probe outcomes without exposing provider diagnostics", () => {
    expect(
      codexProviderReadiness(false, { ready: false, issues: [{ code: "artifact_missing", message: "secret" }] }),
    ).toEqual({ provider: "codex", status: "install" });
    expect(
      codexProviderReadiness(false, {
        ready: false,
        issues: [{ code: "credential_missing", message: "secret" }],
      }),
    ).toEqual({ provider: "codex", status: "sign-in" });
    expect(codexProviderReadiness(true, { ready: true, issues: [] })).toEqual({
      provider: "codex",
      status: "ready",
    });
    expect(
      codexProviderReadiness(false, {
        ready: false,
        issues: [{ code: "temporarily_unavailable", message: "secret" }],
      }),
    ).toEqual({ provider: "codex", status: "unavailable" });
  });

  it("rejects invalid Provider probe deadlines before probing", async () => {
    const home = await temporaryDirectory("opentag-client-probe-deadline-");
    const probe = vi.fn(async () => ({ ready: true as const, issues: [] }));
    const factory = readyFactory("codex", probe);

    for (const providerProbeDeadlineMs of [0, 1.5]) {
      await expect(
        createClientRuntime(runtimeConnection(), {
          clientVersion: "0.0.1",
          environment: { HOME: home, PATH: process.env.PATH },
          factory,
          home,
          providerProbeDeadlineMs,
        }),
      ).rejects.toThrow("Agent Runtime provider probe deadline must be a positive safe integer");
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("propagates unexpected capability publication failures after the bounded refresh settles", async () => {
    const home = await temporaryDirectory("opentag-client-capability-publication-");
    const connection = runtimeConnection();
    const publicationFailure = new Error("readiness publication failed");
    vi.spyOn(connection, "setProviderReadiness").mockImplementationOnce(() => {
      throw publicationFailure;
    });

    await expect(
      createClientRuntime(connection, {
        clientVersion: "0.0.1",
        environment: { HOME: home, PATH: process.env.PATH },
        factory: readyFactory("codex"),
        home,
      }),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [publicationFailure],
    });
  });

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
    const result = await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()));
    expect(result).toMatchObject({ status: "ready" });
    await runtime.runtimeManager.ensureRuntime("session-1", new AbortController().signal);
    expect(await runtime.bindingStore.read("agent-1", "session-1")).toMatchObject({
      schemaVersion: 3,
      runtimeBinding: { providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-1" } },
    });
    const launches = (await readFile(argsLog, "utf8")).trim().split("\n");
    expect(launches).toContain("--version");
    expect(launches).toContain("app-server --help");
    expect(launches).toContain("login status");
    expect(launches.filter((line) => line === CODEX_AGENT_RUNTIME_APP_SERVER_ARGS.join(" "))).toHaveLength(4);
    await expect(
      runtime.reconciler.reconcile({
        ...reconcileRequest(connection.computerId, snapshot()),
        requestId: randomUUID(),
        desired: "stopped",
        runtime: undefined,
      }),
    ).resolves.toMatchObject({ status: "stopped" });

    await runtime.runtimeManager.close();
    runtime.reportOwner.stop();
    await runtime.credentialEnvironment.close();
  });

  it("keeps placement composable and defers unavailable Codex failure to the exact Turn runtime start", async () => {
    const home = await temporaryDirectory("opentag-client-unavailable-");
    const connection = runtimeConnection();
    const runtime = await createClientRuntime(connection, {
      clientVersion: "0.0.1",
      codexCommand: resolve(home, "missing-codex"),
      codexHome: resolve(home, "codex-home"),
      environment: { HOME: home, PATH: process.env.PATH },
      home,
    });
    await expect(
      runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot())),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(runtime.runtimeManager.ensureRuntime("session-1", new AbortController().signal)).rejects.toMatchObject(
      {
        name: "AgentRuntimeProviderUnavailableError",
        providerId: "codex",
      },
    );
    runtime.stop();
    runtime.reportOwner.stop();

    const throwingConnection = runtimeConnection();
    const throwingRuntime = await createClientRuntime(throwingConnection, {
      clientVersion: "0.0.1",
      codexHome: resolve(home, "throwing-codex-home"),
      environment: {},
      factory: readyFactory("codex", async () => {
        throw new Error("probe transport failed");
      }),
      home: resolve(home, "throwing-runtime"),
    });
    await throwingRuntime.reconciler.reconcile(reconcileRequest(throwingConnection.computerId, snapshot()));
    await expect(throwingRuntime.runtimeManager.ensureRuntime("session-1")).rejects.toMatchObject({
      result: { issues: [{ code: "temporarily_unavailable" }] },
    });
    throwingRuntime.stop();
    throwingRuntime.reportOwner.stop();
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
        factory: readyFactory("pi"),
        home,
      }),
    ).rejects.toThrow("does not register the unreviewed provider");

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
    await expect(resolveExecutable("missing", { PATH: empty })).rejects.toThrow(
      "compatible Agent Runtime provider executable",
    );

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

  it("resolves the production Claude Code factory and enforces its reviewed runtime policy", async () => {
    const home = await temporaryDirectory("opentag-client-claude-factory-");
    const command = resolve(home, "claude-fixture");
    await writeFile(
      command,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2.1.210 (Claude Code)\\n"; exit 0; fi\nif [ "$1" = "--help" ]; then printf "stream-json --session-id --resume --mcp-config --strict-mcp-config --allowedTools --append-system-prompt\\n"; exit 0; fi\nexit 1\n',
      "utf8",
    );
    await chmod(command, 0o755);
    const resolved = resolvedClaudeCodeFactory({
      claudeCodeHome: home,
      command,
      environment: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "fixture" },
      sourceEnvironment: { PATH: process.env.PATH },
    });
    expect(() => resolved.create({} as never)).toThrow("readiness has not been established");
    expect(() => resolved.resume({} as never)).toThrow("readiness has not been established");
    const missing = resolvedClaudeCodeFactory({
      claudeCodeHome: home,
      command: resolve(home, "missing-claude"),
      environment: {},
      sourceEnvironment: {},
    });
    await expect(missing.probe({})).resolves.toMatchObject({
      ready: false,
      issues: [{ code: "artifact_missing" }],
    });
    const abortedMissing = new AbortController();
    abortedMissing.abort(new Error("stop Claude resolution"));
    await expect(missing.probe({ signal: abortedMissing.signal })).rejects.toThrow("stop Claude resolution");
    await expect(resolved.probe({})).resolves.toMatchObject({ ready: true });
    await expect(resolved.create({} as never)).rejects.toThrow("eventSink is required");
    await expect(resolved.resume({} as never)).rejects.toThrow("eventSink is required");

    const claudeSnapshot: EffectiveRuntimeSnapshot = {
      ...snapshot(),
      provider: "claude-code",
      execution: { approvalPolicy: "never", networkAccess: true },
    };
    expect(claudeCodeRuntimePolicy(claudeSnapshot)).toEqual({
      fileSystem: "unrestricted",
      network: "enabled",
      approvals: "never",
      tools: { mode: "provider-default" },
    });
    expect(validateClaudeCodeRuntimePolicy(claudeSnapshot)).toBeUndefined();
    expect(
      validateClaudeCodeRuntimePolicy({
        ...claudeSnapshot,
        execution: { approvalPolicy: "on-request", networkAccess: true },
      } as unknown as EffectiveRuntimeSnapshot),
    ).toBe("configuration_unsupported");
    expect(
      validateClaudeCodeRuntimePolicy({
        ...claudeSnapshot,
        execution: { approvalPolicy: "never", networkAccess: false },
      }),
    ).toBe("configuration_unsupported");
  });

  it("unit-tests composition delegates and every preflight outcome", async () => {
    const accepted = { result: { status: "accepted" } };
    const steered = { status: "steered" };
    const custody = {
      accept: vi.fn(async () => accepted),
      acceptSteer: vi.fn(async () => steered),
    };
    const reportOwner = { handleResult: vi.fn(async () => "handled") };
    const recovery = {
      afterReconciled: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      prepare: vi.fn(async (_request, result) => result),
    };
    const handlers = createClientRuntimeHandlers(custody as never, reportOwner as never, recovery as never);
    await expect(handlers.handleDelivery({} as never)).resolves.toBe(accepted);
    await expect(handlers.handleSteer({} as never)).resolves.toBe(steered);
    await expect(handlers.handleTurnReportResult({} as never)).resolves.toBeUndefined();
    await expect(handlers.prepareReconcileResult({} as never, { status: "ready" } as never)).resolves.toEqual({
      status: "ready",
    });
    await expect(
      handlers.onReconcileResultSendFailed({} as never, {} as never, new Error("send")),
    ).resolves.toBeUndefined();
    await expect(handlers.onReconciled({} as never, {} as never)).resolves.toBeUndefined();

    const request = delivery(snapshot());
    const verifyAgent = vi.fn(async () => undefined);
    const validateProviderConfiguration = vi.fn(() => undefined as "configuration_unsupported" | undefined);
    const preflight = createClientRuntimePreflight({
      providers: { validateConfiguration: validateProviderConfiguration },
      workspace: { verifyAgent } as never,
    });
    await expect(preflight(request)).resolves.toBeUndefined();
    expect(verifyAgent).toHaveBeenCalledOnce();

    validateProviderConfiguration.mockReturnValue("configuration_unsupported");
    await expect(preflight(request)).resolves.toBe("configuration_unsupported");

    validateProviderConfiguration.mockReturnValue(undefined);
    verifyAgent.mockRejectedValueOnce(new RuntimeStorageError("conflict", "binding conflict"));
    await expect(preflight(request)).resolves.toBe("session_binding_conflict");
    verifyAgent.mockRejectedValueOnce(new Error("provider failed"));
    await expect(preflight(request)).resolves.toBe("configuration_unsupported");
  });

  it("covers ComposedClientRuntime monitor guards with deterministic component doubles", async () => {
    const runtime = { run: vi.fn(async () => undefined), stop: vi.fn() };
    const components = {
      bindingStore: {},
      custody: {},
      credentialEnvironment: { close: vi.fn(async () => undefined) },
      collaboration: { close: vi.fn() },
      sessionMessageInbox: { settled: vi.fn(async () => undefined), stop: vi.fn() },
      reconciler: {},
      reportOwner: { stop: vi.fn() },
      runner: { settled: vi.fn(async () => undefined), stop: vi.fn() },
      runtimeManager: { close: vi.fn(async () => undefined) },
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
    const refreshCapability = vi.fn(() => {
      startRefresh();
      return refreshGate;
    });
    const refreshing = new ComposedClientRuntime(
      { run: () => runtimeGate, stop: vi.fn() } as never,
      {
        ...components,
        capabilityAbort: new AbortController(),
        refreshCapability,
      } as never,
    );
    const running = refreshing.run();
    await refreshStarted;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(refreshCapability).toHaveBeenCalledOnce();
    finishRuntime();
    await Promise.resolve();
    finishRefresh();
    await running;

    const runtimeCloseFailure = new Error("runtime close failed");
    const credentialClose = vi.fn(async () => undefined);
    const failingClose = new ComposedClientRuntime(
      { run: vi.fn(async () => undefined), stop: vi.fn() } as never,
      {
        ...components,
        capabilityAbort: new AbortController(),
        credentialEnvironment: { close: credentialClose },
        runtimeManager: {
          close: vi.fn(async () => {
            throw runtimeCloseFailure;
          }),
        },
      } as never,
    );
    await expect(failingClose.run()).rejects.toBe(runtimeCloseFailure);
    expect(credentialClose).toHaveBeenCalledOnce();
  });

  it("keeps the credential-grant capability while refreshing Provider readiness", async () => {
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
        contractVersion: 2,
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
          completeLegacyAuth(socket, frame);
          return;
        }
        if (frame.type === "computer:register") {
          observed.push((frame.capabilities as { imCredentialGrant: number }).imCredentialGrant);
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          return;
        }
        if (frame.type === "heartbeat") {
          observed.push((frame.capabilities as { imCredentialGrant: number }).imCredentialGrant);
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
    await vi.waitFor(() => expect(observed.filter((value) => value === 1).length).toBeGreaterThan(1));
    runtime.stop();
    await running;
  });

  it("publishes delivery-triggered Provider recovery before the next periodic refresh", async () => {
    const home = await temporaryDirectory("opentag-client-delivery-readiness-");
    const server = await runtimeServer();
    cleanup.push(server.close);
    const connection = runtimeConnection(server.url);
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    const observed: string[] = [];
    let probeCount = 0;
    const binding = { providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-1" } };
    const state = { phase: "idle" as "idle" | "closed", queuedRunCount: 0 };
    const agentRuntime: AgentRuntime = {
      manifest: { providerId: "codex", displayName: "Codex", contractVersion: 2, bindingSchemaVersion: 1 },
      capabilities: { steer: "unsupported", interactions: "unsupported" },
      state,
      binding,
      prompt: async (request) => ({ runId: request.runId, status: "completed", output: [] }),
      followUp: async (request) => ({ runId: request.runId, status: "completed", output: [] }),
      steer: async () => undefined,
      respond: async () => undefined,
      abort: async () => undefined,
      waitForIdle: async () => undefined,
      close: async () => {
        state.phase = "closed";
      },
    };
    const factory = {
      manifest: agentRuntime.manifest,
      probe: vi.fn(async () => {
        probeCount += 1;
        return probeCount === 2
          ? { ready: false, issues: [{ code: "artifact_missing" as const, message: "temporarily missing" }] }
          : { ready: true, issues: [] };
      }),
      create: async () => agentRuntime,
      resume: async () => agentRuntime,
    } satisfies AgentRuntimeFactory;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeLegacyAuth(socket, frame, true);
          return;
        }
        if (frame.type === "computer:register") {
          for (const item of (frame.providerReadiness as Array<{ status: string }> | undefined) ?? []) {
            observed.push(item.status);
          }
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          return;
        }
        if (frame.type === "heartbeat") {
          for (const item of (frame.providerReadiness as Array<{ status: string }> | undefined) ?? []) {
            observed.push(item.status);
          }
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
      capabilityRefreshIntervalMs: 250,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory,
      home,
    });
    expect(await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()))).toMatchObject({
      status: "ready",
    });
    const running = runtime.run();
    await vi.waitFor(() => expect(observed).toContain("install"), { timeout: 1_000 });

    const accepted = await runtime.custody.accept(delivery(snapshot()));

    expect(accepted.result).toMatchObject({ status: "accepted" });
    await accepted.onAcceptedSent?.();
    await vi.waitFor(() => expect(factory.probe).toHaveBeenCalledTimes(3));
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" });
    const unavailableIndex = observed.lastIndexOf("install");
    await vi.waitFor(() => expect(observed.slice(unavailableIndex + 1)).toContain("ready"));
    expect(factory.probe).toHaveBeenCalledTimes(3);
    runtime.stop();
    await running;
  });

  it("aborts and settles an in-flight periodic Provider probe before shutdown completes", async () => {
    const home = await temporaryDirectory("opentag-client-probe-stop-");
    const server = await runtimeServer();
    cleanup.push(server.close);
    const connection = runtimeConnection(server.url);
    const capabilityUpdates = vi.spyOn(connection, "setVerifiedCapabilities");
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    const releaseLease = vi.fn();
    const leaseProviderReadiness = connection.leaseProviderReadiness.bind(connection);
    const readinessLeases = vi.spyOn(connection, "leaseProviderReadiness").mockImplementation((observation) => {
      const release = leaseProviderReadiness(observation);
      return () => {
        release();
        releaseLease();
      };
    });
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
        contractVersion: 2,
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
          completeLegacyAuth(socket, frame);
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

    expect(runtime.runtimeManager.validate(snapshot())).toBeUndefined();
    expect(readinessLeases).toHaveBeenCalledWith({ provider: "codex", status: "ready" });
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" });

    runtime.stop();
    await expect(running).resolves.toBeUndefined();
    expect(probeOwnerClosed).toBe(true);
    expect(releaseLease).toHaveBeenCalledOnce();
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
          completeLegacyAuth(socket, frame);
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
      manifest: { providerId: "codex", displayName: "Codex", contractVersion: 2, bindingSchemaVersion: 1 },
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
    await runtime.reconciler.reconcile(request);
    const starting = runtime.runtimeManager.ensureRuntime("session-1");
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
    await expect(starting).rejects.toThrow("manager is closing");
    await running;
    expect(closeCalls).toBe(1);
    expect(() => runtime.runtimeManager.runtime("session-1")).toThrow("manager is closing");
  });

  it("recovers other Provider and IM readiness when one periodic probe never settles", async () => {
    const home = await temporaryDirectory("opentag-client-hung-probe-");
    const { lark, slack } = await writeReadyImClis(home);
    const server = await runtimeServer();
    cleanup.push(server.close);
    let currentTime = Date.now();
    const connection = runtimeConnection(server.url, () => currentTime);
    const capabilityUpdates = vi.spyOn(connection, "setVerifiedCapabilities");
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    const imUpdates = vi.spyOn(connection, "setImCliReadiness");
    const heartbeats: Array<Record<string, unknown>> = [];
    let releaseHung!: (result: { ready: true; issues: [] } | { ready: false; issues: [] }) => void;
    const hung = new Promise<{ ready: true; issues: [] } | { ready: false; issues: [] }>((resolve) => {
      releaseHung = resolve;
    });
    cleanup.push(async () => {
      releaseHung({ ready: true, issues: [] });
    });
    const codexProbe = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      if (codexProbe.mock.calls.length === 1) {
        return {
          ready: false as const,
          issues: [{ code: "temporarily_unavailable" as const, message: "cold" }],
        };
      }
      if (codexProbe.mock.calls.length === 2) {
        void signal;
        return hung;
      }
      return {
        ready: false as const,
        issues: [{ code: "temporarily_unavailable" as const, message: "bounded retry" }],
      };
    });
    const claudeProbe = vi.fn(async () => ({ ready: true as const, issues: [] }));
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeLegacyAuth(socket, frame, ["codex", "claude-code"]);
          return;
        }
        if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          return;
        }
        if (frame.type === "heartbeat") {
          heartbeats.push(frame);
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
      capabilityRefreshIntervalMs: 80,
      providerProbeDeadlineMs: 25,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factories: [readyFactory("codex", codexProbe), readyFactory("claude-code", claudeProbe)],
      home,
      larkCliCommand: lark,
      slackCliCommand: slack,
    });
    expect(codexProbe).toHaveBeenCalledOnce();
    expect(claudeProbe).toHaveBeenCalledOnce();
    expect(readinessUpdates.mock.calls.map(([observation]) => observation)).toEqual(
      expect.arrayContaining([
        { provider: "codex", status: "unavailable" },
        { provider: "claude-code", status: "ready" },
      ]),
    );
    expect(imUpdates.mock.calls.map(([observation]) => observation)).toEqual(
      expect.arrayContaining([
        { provider: "feishu", status: "ready" },
        { provider: "slack", status: "ready" },
      ]),
    );
    const codexUnavailableAtStart = readinessUpdates.mock.calls.filter(
      ([observation]) => observation.provider === "codex" && observation.status === "unavailable",
    ).length;
    const running = runtime.run();
    await vi.waitFor(() => expect(codexProbe).toHaveBeenCalledTimes(2));
    const claudeAtHungRefresh = claudeProbe.mock.calls.length;
    const imReadyAtHungRefresh = imUpdates.mock.calls.filter(([{ status }]) => status === "ready").length;
    const capabilitiesAtHungRefresh = capabilityUpdates.mock.calls.length;
    await vi.waitFor(() =>
      expect(
        readinessUpdates.mock.calls.filter(
          ([observation]) => observation.provider === "codex" && observation.status === "unavailable",
        ).length,
      ).toBeGreaterThan(codexUnavailableAtStart),
    );

    const lateReadyCalls = readinessUpdates.mock.calls.filter(
      ([observation]) => observation.provider === "codex" && observation.status === "ready",
    ).length;
    releaseHung({ ready: true, issues: [] });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(
      readinessUpdates.mock.calls.filter(
        ([observation]) => observation.provider === "codex" && observation.status === "ready",
      ).length,
    ).toBe(lateReadyCalls);
    expect(
      [...readinessUpdates.mock.calls].reverse().find(([observation]) => observation.provider === "codex")?.[0],
    ).toEqual({ provider: "codex", status: "unavailable" });

    await vi.waitFor(() => expect(claudeProbe.mock.calls.length).toBeGreaterThan(claudeAtHungRefresh));
    await vi.waitFor(() =>
      expect(imUpdates.mock.calls.filter(([{ status }]) => status === "ready").length).toBeGreaterThan(
        imReadyAtHungRefresh,
      ),
    );
    await vi.waitFor(() => expect(capabilityUpdates.mock.calls.length).toBeGreaterThan(capabilitiesAtHungRefresh));

    currentTime += RUNTIME_CLIENT_CAPABILITY_TTL_MS + 1;
    const heartbeatAfterTtl = heartbeats.length;
    await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThan(heartbeatAfterTtl));
    await vi.waitFor(() => {
      const latest = heartbeats.at(-1);
      expect(latest).toMatchObject({
        capabilities: { imCredentialGrant: 1 },
        providerReadiness: expect.arrayContaining([
          { provider: "codex", status: "unavailable" },
          { provider: "claude-code", status: "ready" },
        ]),
        imCliReadiness: expect.arrayContaining([
          { provider: "feishu", status: "ready" },
          { provider: "slack", status: "ready" },
        ]),
      });
    });

    runtime.stop();
    await expect(running).resolves.toBeUndefined();
  });

  it("settles shutdown without publishing late hung-probe results", async () => {
    const home = await temporaryDirectory("opentag-client-hung-stop-");
    const { lark, slack } = await writeReadyImClis(home);
    const server = await runtimeServer();
    cleanup.push(server.close);
    const connection = runtimeConnection(server.url);
    const capabilityUpdates = vi.spyOn(connection, "setVerifiedCapabilities");
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    const imUpdates = vi.spyOn(connection, "setImCliReadiness");
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      refreshStarted = resolveStarted;
    });
    let releaseHung!: (result: { ready: true; issues: [] }) => void;
    const hung = new Promise<{ ready: true; issues: [] }>((resolve) => {
      releaseHung = resolve;
    });
    cleanup.push(async () => {
      releaseHung({ ready: true, issues: [] });
    });
    let probeCount = 0;
    const countingFactory = readyFactory("codex", async ({ signal }) => {
      probeCount += 1;
      if (probeCount === 1) return { ready: true, issues: [] };
      refreshStarted();
      void signal;
      return hung;
    });
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeLegacyAuth(socket, frame, ["codex"]);
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
      capabilityRefreshIntervalMs: 20,
      providerProbeDeadlineMs: 1_000,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory: countingFactory,
      home,
      larkCliCommand: lark,
      slackCliCommand: slack,
    });
    const running = runtime.run();
    await started;

    runtime.stop();
    await expect(running).resolves.toBeUndefined();
    const capabilitiesAfterStop = capabilityUpdates.mock.calls.length;
    const readinessAfterStop = readinessUpdates.mock.calls.length;
    const imAfterStop = imUpdates.mock.calls.length;
    releaseHung({ ready: true, issues: [] });
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    expect(capabilityUpdates).toHaveBeenCalledTimes(capabilitiesAfterStop);
    expect(readinessUpdates).toHaveBeenCalledTimes(readinessAfterStop);
    expect(imUpdates).toHaveBeenCalledTimes(imAfterStop);
    expect(
      [...readinessUpdates.mock.calls].reverse().find(([observation]) => observation.provider === "codex")?.[0],
    ).toEqual({ provider: "codex", status: "ready" });
  });

  it("ignores a stale overlapping Provider probe once a newer refresh has started", async () => {
    const home = await temporaryDirectory("opentag-client-stale-probe-");
    const server = await runtimeServer();
    cleanup.push(server.close);
    const connection = runtimeConnection(server.url);
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const probe = vi.fn(async () => {
      if (probe.mock.calls.length === 1) {
        return {
          ready: false as const,
          issues: [{ code: "temporarily_unavailable" as const, message: "cold" }],
        };
      }
      await gate;
      return { ready: true as const, issues: [] };
    });
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeLegacyAuth(socket, frame, ["codex"]);
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
      capabilityRefreshIntervalMs: 20,
      providerProbeDeadlineMs: 500,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory: readyFactory("codex", probe),
      home,
    });
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "unavailable" });
    expect(await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()))).toMatchObject({
      status: "ready",
    });
    expect(
      await runtime.reconciler.reconcile({
        ...reconcileRequest(connection.computerId, snapshot()),
        requestId: randomUUID(),
        sessionId: "session-2",
      }),
    ).toMatchObject({ status: "ready" });
    const first = runtime.runtimeManager.ensureRuntime("session-1", new AbortController().signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    const second = runtime.runtimeManager.ensureRuntime("session-2", new AbortController().signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    release();
    await vi.waitFor(() => expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.stringContaining("not used"),
      expect.stringContaining("not used"),
    ]);
    runtime.stop();
  });

  it("publishes a shared probe success after a newer waiter cancels", async () => {
    const home = await temporaryDirectory("opentag-client-shared-cancel-");
    const server = await runtimeServer();
    cleanup.push(server.close);
    const connection = runtimeConnection(server.url);
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    const heartbeats: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const probe = vi.fn(async () => {
      if (probe.mock.calls.length === 1) {
        return {
          ready: false as const,
          issues: [{ code: "temporarily_unavailable" as const, message: "cold" }],
        };
      }
      await gate;
      return { ready: true as const, issues: [] };
    });
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeLegacyAuth(socket, frame, ["codex"]);
          return;
        }
        if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          return;
        }
        if (frame.type === "heartbeat") {
          heartbeats.push(frame);
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
      capabilityRefreshIntervalMs: 60_000,
      providerProbeDeadlineMs: 5_000,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory: readyFactory("codex", probe),
      home,
    });
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "unavailable" });
    expect(await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()))).toMatchObject({
      status: "ready",
    });
    expect(
      await runtime.reconciler.reconcile({
        ...reconcileRequest(connection.computerId, snapshot()),
        requestId: randomUUID(),
        sessionId: "session-2",
      }),
    ).toMatchObject({ status: "ready" });
    const running = runtime.run();
    await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThan(0));
    const ownerSignal = new AbortController();
    const owner = runtime.runtimeManager.ensureRuntime("session-1", ownerSignal.signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    const joinedSignal = new AbortController();
    const joined = runtime.runtimeManager.ensureRuntime("session-2", joinedSignal.signal);
    const joinedResult = joined.then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    joinedSignal.abort(new Error("cancel joined waiter"));
    await expect(joinedResult).resolves.toBe("cancel joined waiter");
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "checking" });
    expect(probe).toHaveBeenCalledTimes(2);
    const heartbeatsBeforeReady = heartbeats.length;
    release();
    await vi.waitFor(() => expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" }));
    await expect(owner).resolves.toContain("not used");
    await vi.waitFor(() => {
      const afterReady = heartbeats.slice(heartbeatsBeforeReady);
      expect(
        afterReady.some((heartbeat) =>
          ((heartbeat.providerReadiness as Array<{ provider: string; status: string }> | undefined) ?? []).some(
            (observation) => observation.provider === "codex" && observation.status === "ready",
          ),
        ),
      ).toBe(true);
    });
    const onDemand = runtime.runtimeManager.ensureRuntime("session-2", new AbortController().signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await expect(onDemand).resolves.toContain("not used");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" });
    runtime.stop();
    await expect(running).resolves.toBeUndefined();
  });

  it("keeps a completed shared ready publication if a waiter cancels afterwards", async () => {
    const home = await temporaryDirectory("opentag-client-complete-before-cancel-");
    const connection = runtimeConnection();
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const probe = vi.fn(async () => {
      if (probe.mock.calls.length === 1) {
        return {
          ready: false as const,
          issues: [{ code: "temporarily_unavailable" as const, message: "cold" }],
        };
      }
      await gate;
      return { ready: true as const, issues: [] };
    });
    const runtime = await createClientRuntime(connection, {
      capabilityRefreshIntervalMs: 60_000,
      providerProbeDeadlineMs: 5_000,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory: readyFactory("codex", probe),
      home,
    });
    expect(await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()))).toMatchObject({
      status: "ready",
    });
    expect(
      await runtime.reconciler.reconcile({
        ...reconcileRequest(connection.computerId, snapshot()),
        requestId: randomUUID(),
        sessionId: "session-2",
      }),
    ).toMatchObject({ status: "ready" });
    const owner = runtime.runtimeManager.ensureRuntime("session-1", new AbortController().signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    const joinedSignal = new AbortController();
    const joined = runtime.runtimeManager.ensureRuntime("session-2", joinedSignal.signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    release();
    await vi.waitFor(() => expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" }));
    await expect(Promise.all([owner, joined])).resolves.toEqual([
      expect.stringContaining("not used"),
      expect.stringContaining("not used"),
    ]);
    const published = readinessUpdates.mock.calls.length;
    joinedSignal.abort(new Error("cancel after completion"));
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(readinessUpdates).toHaveBeenCalledTimes(published);
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" });
    runtime.stop();
  });

  it("does not let a joined waiter extend the shared owner deadline or a late probe overwrite a newer result", async () => {
    const home = await temporaryDirectory("opentag-client-stale-deadline-");
    const connection = runtimeConnection();
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    let releaseHung!: () => void;
    const hung = new Promise<void>((resolveHung) => {
      releaseHung = resolveHung;
    });
    cleanup.push(async () => releaseHung());
    const probe = vi.fn(async () => {
      if (probe.mock.calls.length === 1) {
        return {
          ready: false as const,
          issues: [{ code: "temporarily_unavailable" as const, message: "cold" }],
        };
      }
      if (probe.mock.calls.length === 2) {
        await hung;
        return { ready: true as const, issues: [] };
      }
      return { ready: true as const, issues: [] };
    });
    const runtime = await createClientRuntime(connection, {
      capabilityRefreshIntervalMs: 60_000,
      providerProbeDeadlineMs: 40,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory: readyFactory("codex", probe),
      home,
    });
    expect(await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()))).toMatchObject({
      status: "ready",
    });
    expect(
      await runtime.reconciler.reconcile({
        ...reconcileRequest(connection.computerId, snapshot()),
        requestId: randomUUID(),
        sessionId: "session-2",
      }),
    ).toMatchObject({ status: "ready" });
    const first = runtime.runtimeManager.ensureRuntime("session-1", new AbortController().signal).then(
      () => "created",
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    const second = runtime.runtimeManager.ensureRuntime("session-2", new AbortController().signal).then(
      () => "created",
      (error: unknown) => error,
    );
    await vi.waitFor(() =>
      expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "unavailable" }),
    );
    expect(probe).toHaveBeenCalledTimes(2);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ name: "AgentRuntimeProviderUnavailableError" }),
      expect.objectContaining({ name: "AgentRuntimeProviderUnavailableError" }),
    ]);

    const fresh = runtime.runtimeManager.ensureRuntime("session-1", new AbortController().signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() => expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" }));
    await expect(fresh).resolves.toContain("not used");
    expect(probe).toHaveBeenCalledTimes(3);
    const published = readinessUpdates.mock.calls.length;
    releaseHung();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(readinessUpdates).toHaveBeenCalledTimes(published);
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" });
    runtime.stop();
  });

  it("does not publish Provider readiness after the caller aborts the Client Runtime", async () => {
    const home = await temporaryDirectory("opentag-client-abort-publish-");
    const connection = runtimeConnection();
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    const caller = new AbortController();
    const runtime = await createClientRuntime(connection, {
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory: readyFactory("codex", async () => ({
        ready: false,
        issues: [{ code: "temporarily_unavailable" as const, message: "cold" }],
      })),
      home,
      signal: caller.signal,
    });
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "unavailable" });
    expect(await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()))).toMatchObject({
      status: "ready",
    });
    const published = readinessUpdates.mock.calls.length;
    caller.abort(new Error("stop caller"));
    await expect(runtime.runtimeManager.ensureRuntime("session-1", new AbortController().signal)).rejects.toThrow();
    expect(readinessUpdates).toHaveBeenCalledTimes(published);
    runtime.stop();
  });

  it("propagates ensure-time cancellation without treating it as a probe deadline", async () => {
    const home = await temporaryDirectory("opentag-client-ensure-cancel-");
    const connection = runtimeConnection();
    let started!: () => void;
    const sawProbe = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    let probes = 0;
    const factory = readyFactory("codex", async ({ signal }) => {
      probes += 1;
      if (probes === 1) {
        return { ready: false, issues: [{ code: "temporarily_unavailable" as const, message: "cold" }] };
      }
      started();
      return new Promise((_, reject) => {
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const runtime = await createClientRuntime(connection, {
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory,
      home,
      providerProbeDeadlineMs: 5_000,
    });
    expect(await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()))).toMatchObject({
      status: "ready",
    });
    const ensureSignal = new AbortController();
    const ensuring = runtime.runtimeManager.ensureRuntime("session-1", ensureSignal.signal);
    await sawProbe;
    ensureSignal.abort(new Error("stop ensure"));
    await expect(ensuring).rejects.toThrow("stop ensure");
    runtime.stop();
  });

  it("does not let a cancelled sole waiter hand its draining owner to a later caller", async () => {
    const home = await temporaryDirectory("opentag-client-owner-evict-");
    const connection = runtimeConnection();
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    let releaseOldOwner!: () => void;
    let oldOwnerReturned = false;
    const oldOwnerDrain = new Promise<void>((resolveDrain) => {
      releaseOldOwner = resolveDrain;
    });
    const refresh = vi.spyOn(AgentRuntimeProviderRegistry.prototype, "refresh");
    refresh
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        await oldOwnerDrain;
        oldOwnerReturned = true;
        return true;
      })
      .mockResolvedValue(true);
    cleanup.push(async () => {
      releaseOldOwner();
      refresh.mockRestore();
    });
    const runtime = await createClientRuntime(connection, {
      capabilityRefreshIntervalMs: 60_000,
      providerProbeDeadlineMs: 5_000,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory: readyFactory("codex"),
      home,
    });
    expect(await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()))).toMatchObject({
      status: "ready",
    });
    const firstSignal = new AbortController();
    const first = runtime.runtimeManager.ensureRuntime("session-1", firstSignal.signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refresh).toHaveBeenCalledTimes(2);
    firstSignal.abort(new Error("cancel sole waiter"));
    await expect(first).resolves.toBe("cancel sole waiter");
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "checking" });

    const second = runtime.runtimeManager.ensureRuntime("session-1", new AbortController().signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    await expect(second).resolves.toContain("not used");
    await expect(second).resolves.not.toContain("has no waiters");
    await vi.waitFor(() => expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" }));
    expect(oldOwnerReturned).toBe(false);
    const published = readinessUpdates.mock.calls.length;
    releaseOldOwner();
    await vi.waitFor(() => expect(oldOwnerReturned).toBe(true));
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(readinessUpdates).toHaveBeenCalledTimes(published);
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" });
    runtime.stop();
  });

  it("does not let cancelled-owner cleanup evict or publish over its live successor", async () => {
    const home = await temporaryDirectory("opentag-client-owner-identity-");
    const connection = runtimeConnection();
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    let releaseOldOwner!: () => void;
    let releaseNewOwner!: () => void;
    let oldOwnerReturned = false;
    const oldOwnerDrain = new Promise<void>((resolveDrain) => {
      releaseOldOwner = resolveDrain;
    });
    const newOwnerDrain = new Promise<void>((resolveDrain) => {
      releaseNewOwner = resolveDrain;
    });
    const refresh = vi.spyOn(AgentRuntimeProviderRegistry.prototype, "refresh");
    refresh
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        await oldOwnerDrain;
        oldOwnerReturned = true;
        return true;
      })
      .mockImplementationOnce(async () => {
        await newOwnerDrain;
        return true;
      })
      .mockResolvedValue(false);
    cleanup.push(async () => {
      releaseOldOwner();
      releaseNewOwner();
      refresh.mockRestore();
    });
    const runtime = await createClientRuntime(connection, {
      capabilityRefreshIntervalMs: 60_000,
      providerProbeDeadlineMs: 5_000,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory: readyFactory("codex"),
      home,
    });
    for (const sessionId of ["session-1", "session-2", "session-3"]) {
      expect(
        await runtime.reconciler.reconcile({
          ...reconcileRequest(connection.computerId, snapshot()),
          requestId: randomUUID(),
          sessionId,
        }),
      ).toMatchObject({ status: "ready" });
    }

    const firstSignal = new AbortController();
    const first = runtime.runtimeManager.ensureRuntime("session-1", firstSignal.signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refresh).toHaveBeenCalledTimes(2);
    firstSignal.abort(new Error("cancel old owner"));
    await expect(first).resolves.toBe("cancel old owner");

    const second = runtime.runtimeManager.ensureRuntime("session-2", new AbortController().signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    releaseOldOwner();
    await vi.waitFor(() => expect(oldOwnerReturned).toBe(true));
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "checking" });

    const third = runtime.runtimeManager.ensureRuntime("session-3", new AbortController().signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(refresh).toHaveBeenCalledTimes(3);
    releaseNewOwner();
    await expect(Promise.all([second, third])).resolves.toEqual([
      expect.stringContaining("not used"),
      expect.stringContaining("not used"),
    ]);
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" });
    runtime.stop();
  });

  it("starts a fresh owner after the previous cancelled owner has already drained", async () => {
    const home = await temporaryDirectory("opentag-client-owner-drained-");
    const connection = runtimeConnection();
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    let releaseHung!: () => void;
    const hung = new Promise<void>((resolveHung) => {
      releaseHung = resolveHung;
    });
    const probe = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      if (probe.mock.calls.length === 1) {
        return {
          ready: false as const,
          issues: [{ code: "temporarily_unavailable" as const, message: "cold" }],
        };
      }
      if (probe.mock.calls.length === 2) {
        await hung;
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        return { ready: true as const, issues: [] };
      }
      return { ready: true as const, issues: [] };
    });
    const runtime = await createClientRuntime(connection, {
      capabilityRefreshIntervalMs: 60_000,
      providerProbeDeadlineMs: 5_000,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory: readyFactory("codex", probe),
      home,
    });
    expect(await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()))).toMatchObject({
      status: "ready",
    });
    const firstSignal = new AbortController();
    const first = runtime.runtimeManager.ensureRuntime("session-1", firstSignal.signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    firstSignal.abort(new Error("cancel before drain"));
    await expect(first).resolves.toBe("cancel before drain");
    releaseHung();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "checking" });

    const second = runtime.runtimeManager.ensureRuntime("session-1", new AbortController().signal).then(
      () => "created",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await expect(second).resolves.toContain("not used");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "ready" });
    runtime.stop();
  });

  it("marks a never-resolving ensure probe unavailable when its deadline elapses", async () => {
    const home = await temporaryDirectory("opentag-client-ensure-deadline-");
    const connection = runtimeConnection();
    const readinessUpdates = vi.spyOn(connection, "setProviderReadiness");
    const probe = vi.fn(async () => {
      if (probe.mock.calls.length === 1) {
        return {
          ready: false as const,
          issues: [{ code: "temporarily_unavailable" as const, message: "cold" }],
        };
      }
      return new Promise<never>(() => undefined);
    });
    const runtime = await createClientRuntime(connection, {
      capabilityRefreshIntervalMs: 60_000,
      providerProbeDeadlineMs: 20,
      clientVersion: "0.0.1",
      environment: { HOME: home, PATH: process.env.PATH },
      factory: readyFactory("codex", probe),
      home,
    });
    expect(await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, snapshot()))).toMatchObject({
      status: "ready",
    });
    const ensuring = runtime.runtimeManager.ensureRuntime("session-1", new AbortController().signal);
    const ensured = ensuring.then(
      () => "created",
      (error: unknown) => error,
    );
    await vi.waitFor(() =>
      expect(readinessUpdates).toHaveBeenLastCalledWith({ provider: "codex", status: "unavailable" }),
    );
    await expect(ensured).resolves.toMatchObject({
      name: "AgentRuntimeProviderUnavailableError",
      result: {
        ready: false,
        issues: [
          {
            code: "temporarily_unavailable",
            message: "Provider readiness probe exceeded its deadline",
          },
        ],
      },
    });
    runtime.stop();
  });
});

function runtimeConnection(serverUrl = "http://127.0.0.1:3000", now?: () => number): RuntimeConnection {
  return new RuntimeConnection({
    arch: "arm64",
    clientVersion: "0.0.1",
    computer: {
      version: 2,
      computerId: randomUUID(),
      serverUrl,
    },
    displayName: "test",
    instanceId: randomUUID(),
    now,
    platform: "darwin",
    machineToken: "machine-token",
  });
}

function completeLegacyAuth(
  socket: WebSocket,
  frame: Record<string, unknown>,
  providerReadiness: boolean | readonly string[] = false,
): void {
  if (frame.protocolVersion !== 1) {
    socket.send(
      JSON.stringify({
        type: "error",
        requestId: frame.requestId,
        code: "PROTOCOL_VERSION_UNSUPPORTED",
        message: "The test Server supports runtime protocol v1 only",
      }),
    );
    socket.close(4400, "Protocol version unsupported");
    return;
  }
  socket.send(
    JSON.stringify({
      type: "auth:result",
      requestId: frame.requestId,
      ok: true,
      workspaceComputerId: randomUUID(),
      workspaceId: randomUUID(),
      computerId: randomUUID(),
    }),
  );
  const providers = Array.isArray(providerReadiness) ? providerReadiness : providerReadiness ? ["codex"] : undefined;
  socket.send(
    JSON.stringify({
      type: "server:welcome",
      protocolVersion: 1,
      capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imCredentialGrant: 1 },
      ...(providers ? { providerReadiness: { version: 1, providers } } : {}),
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 100,
    }),
  );
}

async function writeReadyImClis(home: string): Promise<{ lark: string; slack: string }> {
  const lark = resolve(home, "lark-cli");
  const slack = resolve(home, "slack");
  await writeFile(
    lark,
    '#!/bin/sh\nif [ "$1" = "--version" ] || { [ "$1" = "im" ] && [ "$2" = "--help" ]; }; then exit 0; fi\nexit 1\n',
    "utf8",
  );
  await writeFile(
    slack,
    '#!/bin/sh\nif [ "$1" = "version" ] || { [ "$1" = "api" ] && [ "$2" = "--help" ]; }; then exit 0; fi\nexit 1\n',
    "utf8",
  );
  await Promise.all([chmod(lark, 0o700), chmod(slack, 0o700)]);
  return { lark, slack };
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
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), prefix)));
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
    execution: { approvalPolicy: "never", networkAccess: true },
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
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "workspace-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000001",
      },
    },
    runtime,
  };
}

function readyFactory(
  providerId = "codex",
  probe: AgentRuntimeFactory["probe"] = async () => ({ ready: true, issues: [] }),
): AgentRuntimeFactory {
  return {
    manifest: { providerId, displayName: providerId, contractVersion: 2, bindingSchemaVersion: 1 },
    probe,
    create: async () => {
      throw new Error("not used");
    },
    resume: async () => {
      throw new Error("not used");
    },
  };
}
