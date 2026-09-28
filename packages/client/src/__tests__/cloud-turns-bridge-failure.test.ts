import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerClientFrame, RuntimeCredentialServerFrame, SessionMessageDeliveryRequest } from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCredentialChannel } from "../runner/cloud-credential-connection.js";
import { CloudJournal } from "../runner/cloud-journal.js";
import { CloudTurnRunner, type CloudTurnScope } from "../runner/cloud-turns.js";
import { NativeProviderBridge } from "../runner/native-provider-bridge.js";
import { NativeSandboxError } from "../runner/native-sandbox.js";
import { cloudRunnerDirectories, defaultRunnerStateDir } from "../runner/serve.js";
import { RuntimeCredentialRelay } from "../runtime/runtime-credential-relay.js";
import { RuntimeProxyLoopbackAdapter } from "../runtime/runtime-proxy-loopback-adapter.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

/**
 * Default `#openBridgeExecution` acquisition-lifetime regressions. The credential relay, the
 * loopback adapter and the native provider bridge are controlled local fixtures; every failure
 * below is a REAL filesystem or fixture failure. No Cloud, credential, model, provider or IM
 * operation occurs, and no parent socket may ever be published into the Sandbox material.
 */

const MODEL_GRANT = {
  baseUrl: "https://server.example.com/api/v1/cloud-model",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  model: "deepseek-v4.1-flash-expires-on-0910",
  token: "unit-execution-token-0123456789abcdef",
  contextWindow: 258_000 as const,
  maxTokens: 8_192,
};

interface ChannelFixture {
  readonly channel: CloudCredentialChannel;
  readonly registered: () => number;
  readonly activeListeners: () => number;
}

function credentialChannel(): ChannelFixture {
  const frameListeners = new Set<(frame: RuntimeCredentialServerFrame) => void>();
  const stateListeners = new Set<(state: "registered" | "closed") => void>();
  let registered = 0;
  return {
    channel: {
      onChannelState: (listener) => {
        registered += 1;
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      onCredentialFrame: (listener) => {
        registered += 1;
        frameListeners.add(listener);
        return () => frameListeners.delete(listener);
      },
      sendFrame: () => undefined,
    },
    registered: () => registered,
    activeListeners: () => frameListeners.size + stateListeners.size,
  };
}

function fakeRelay(closeCounter: { count: number }): unknown {
  return {
    cliMetadataFor: () => undefined,
    close: async () => {
      closeCounter.count += 1;
    },
    executionId: "fixture-execution",
    localHandleFor: () => "fixture-handle",
    openProviderStream: () => {
      throw new Error("the fixture never opens provider streams");
    },
    providers: [],
    verifyLocalHandle: () => false,
  };
}

interface AdapterFixture {
  readonly adapter: unknown;
  readonly closed: () => number;
  readonly listening: () => boolean;
}

/** Controlled adapter fixture that owns a REAL listener, so leaks are observable. */
async function fakeAdapter(root: string, caPath: string, closeCounter: { count: number }): Promise<AdapterFixture> {
  const server: Server = createServer();
  const socketPath = join(root, `adapter-${randomUUID().slice(0, 8)}.sock`);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    adapter: {
      caCertPath: caPath,
      close: async () => {
        closeCounter.count += 1;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
      connectProxyUrl: "http://127.0.0.1:18080",
      slackApiHost: "https://127.0.0.1:18443",
    },
    closed: () => closeCounter.count,
    listening: () => server.listening,
  };
}

/** Controlled bridge fixture; the open spy records every input for target/lifetime assertions. */
function fakeBridge(closeCounter: { count: number }, events?: string[]): unknown {
  return {
    close: async () => {
      closeCounter.count += 1;
      events?.push("bridge:close");
    },
    failure: undefined,
  };
}

/** Bounded explicit completion waiter; never an unbounded loop. */
async function waitFor(check: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function reportsOf(sent: RunnerClientFrame[]) {
  return sent.filter((frame) => frame.type === "delivery:report");
}

function settledOf(sent: RunnerClientFrame[]) {
  return sent.filter((frame) => frame.type === "session:message:settled");
}

/** One minimal valid Session message sharing the delivery's Session scope. */
function sessionMessageFixture(sessionId: string): SessionMessageDeliveryRequest {
  const runtime = cloudDeliveryFixture().runtime;
  const messageId = randomUUID();
  return {
    type: "session:message:deliver",
    requestId: messageId,
    messageId,
    sourceSessionId: randomUUID(),
    targetSessionId: sessionId,
    agentId: runtime.agentId,
    placementGeneration: 1,
    content: { kind: "text", text: "child task" },
    runtime,
  };
}

describe("CloudTurnRunner default bridge acquisition lifetime", () => {
  let root: string;
  let stateDirectory: string;
  let publicRoot: string;
  let journal: CloudJournal;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cloud-bridge-failure-"));
    stateDirectory = join(root, "state");
    publicRoot = join(root, "public");
    journal = await CloudJournal.open(join(root, "journal"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function scenario() {
    const delivery = cloudDeliveryFixture();
    const scope: CloudTurnScope = {
      environmentGeneration: 1,
      resourceName: "projects/p/locations/r/instances/ots-s-x-1",
      resourceUid: "uid-1",
      sandboxId: randomUUID(),
      sessionId: delivery.sessionId,
    };
    return { delivery, scope, sent: [] as RunnerClientFrame[], state: credentialChannel() };
  }

  function makeRunner(input: {
    scope: CloudTurnScope;
    sent: RunnerClientFrame[];
    state: ChannelFixture;
    publicDirectory?: string;
    stateDirectory?: string;
    onPersistenceError?: (error: unknown) => void;
    runWorker: (
      stdin: { stdin: string; timeoutMs: number },
      signal: AbortSignal,
    ) => Promise<{ code: number; stderr: string; stdout: string }>;
  }): CloudTurnRunner {
    return new CloudTurnRunner({
      credentialChannel: () => input.state.channel,
      journal,
      ...(input.publicDirectory ? { publicDirectory: input.publicDirectory } : {}),
      runWorker: input.runWorker,
      onPersistenceError: input.onPersistenceError,
      sandbox: {
        name: "ots-cloud-turn-test",
        exec: () => Promise.reject(new Error("unused native seam")),
        openDuplex: () => {
          throw new Error("unused native duplex seam");
        },
      },
      scope: () => input.scope,
      send: (frame) => input.sent.push(frame),
      serverUrl: "https://server.example.com",
      stateDirectory: input.stateDirectory ?? stateDirectory,
    });
  }

  async function driveToReport(
    runner: CloudTurnRunner,
    delivery: ReturnType<typeof cloudDeliveryFixture>,
    sent: RunnerClientFrame[],
  ): Promise<void> {
    const reportsBefore = reportsOf(sent).length;
    await runner.handleDeliveryRun({ type: "delivery:run", requestId: delivery.requestId, delivery });
    await runner.handleVerified({
      type: "delivery:verified",
      requestId: delivery.requestId,
      status: "verified",
      model: { ...MODEL_GRANT, model: delivery.runtime.model ?? MODEL_GRANT.model },
    });
    await waitFor(() => reportsOf(sent).length === reportsBefore + 1, "turn report");
    await waitFor(() => runner.activeDeliveryId === undefined, "turn to settle");
  }

  async function driveToSessionSettled(
    runner: CloudTurnRunner,
    message: SessionMessageDeliveryRequest,
    sent: RunnerClientFrame[],
  ): Promise<void> {
    await runner.handleSessionMessageRun({
      type: "session:message:run",
      requestId: message.requestId,
      message,
      sessionKind: "internal",
    });
    await runner.handleSessionMessageVerified({
      type: "session:message:verified",
      requestId: message.requestId,
      status: "verified",
      model: MODEL_GRANT,
    });
    await waitFor(() => settledOf(sent).length === 1, "Session settlement");
    await waitFor(() => runner.activeMessageId === undefined, "Session turn to settle");
  }

  /** The real relay/adapter fixtures plus a controlled bridge, ready for one turn. */
  async function mockExecutionStack(input: { events?: string[]; withCa?: boolean } = {}) {
    const relayClosed = { count: 0 };
    const adapterClosed = { count: 0 };
    const bridgeClosed = { count: 0 };
    vi.spyOn(RuntimeCredentialRelay, "open").mockResolvedValue(fakeRelay(relayClosed) as never);
    await mkdir(stateDirectory, { recursive: true });
    const caPath = join(root, "ca.pem");
    if (input.withCa !== false) {
      await writeFile(caPath, "-----BEGIN CERTIFICATE-----fixture-----END CERTIFICATE-----\n");
    }
    const adapter = await fakeAdapter(root, caPath, adapterClosed);
    vi.spyOn(RuntimeProxyLoopbackAdapter, "start").mockResolvedValue(adapter.adapter as never);
    const bridgeOpen = vi.spyOn(NativeProviderBridge, "open").mockImplementation(async () => {
      input.events?.push("bridge:open");
      return fakeBridge(bridgeClosed, input.events) as never;
    });
    return { adapter, adapterClosed, bridgeClosed, bridgeOpen, relayClosed };
  }

  it("closes the credential connection when RuntimeCredentialRelay.open rejects", async () => {
    const s = scenario();
    vi.spyOn(RuntimeCredentialRelay, "open").mockRejectedValue(new Error("relay open rejected"));
    const adapterStart = vi.spyOn(RuntimeProxyLoopbackAdapter, "start");
    const bridgeOpen = vi.spyOn(NativeProviderBridge, "open");
    const runner = makeRunner({
      runWorker: async () => {
        throw new Error("the worker must never execute after a bridge failure");
      },
      scope: s.scope,
      sent: s.sent,
      state: s.state,
    });
    await driveToReport(runner, s.delivery, s.sent);
    await runner.close();
    // The connection constructor registered both listeners and cleanup unregistered them.
    expect(s.state.registered()).toBe(2);
    expect(s.state.activeListeners()).toBe(0);
    expect(adapterStart).not.toHaveBeenCalled();
    expect(bridgeOpen).not.toHaveBeenCalled();
    expect((reportsOf(s.sent)[0] as { report: { outcome: string } }).report.outcome).toBe("unknown");
    // No scratch directory was created before the failure.
    await expect(stat(stateDirectory)).rejects.toThrow();
  });

  it("closes the opened relay and connection when the private scratch directory cannot be created", async () => {
    const s = scenario();
    const relayClosed = { count: 0 };
    vi.spyOn(RuntimeCredentialRelay, "open").mockResolvedValue(fakeRelay(relayClosed) as never);
    const bridgeOpen = vi.spyOn(NativeProviderBridge, "open");
    // A regular file at the state directory path makes the real mkdtemp fail.
    await writeFile(stateDirectory, "not-a-directory");
    const runner = makeRunner({
      runWorker: async () => {
        throw new Error("the worker must never execute after a bridge failure");
      },
      scope: s.scope,
      sent: s.sent,
      state: s.state,
    });
    await driveToReport(runner, s.delivery, s.sent);
    await runner.close();
    expect(relayClosed.count).toBe(1);
    expect(s.state.activeListeners()).toBe(0);
    expect(bridgeOpen).not.toHaveBeenCalled();
    // The public root is only created after the private directory exists.
    await expect(stat(publicRoot)).rejects.toThrow();
  });

  it("closes the started adapter, relay and connection when publication fails after partial acquisition", async () => {
    const s = scenario();
    // The adapter fixture points at a CA file that does not exist: the real publish copy fails
    // after the adapter (with its real listener) was acquired.
    const { adapter, adapterClosed, bridgeOpen, relayClosed } = await mockExecutionStack({ withCa: false });
    const runner = makeRunner({
      publicDirectory: publicRoot,
      runWorker: async () => {
        throw new Error("the worker must never execute after a bridge failure");
      },
      scope: s.scope,
      sent: s.sent,
      state: s.state,
    });
    await driveToReport(runner, s.delivery, s.sent);
    await runner.close();
    expect(relayClosed.count).toBe(1);
    expect(adapterClosed.count).toBe(1);
    expect(adapter.listening()).toBe(false);
    expect(s.state.activeListeners()).toBe(0);
    expect(bridgeOpen).not.toHaveBeenCalled();
    // Both scratch trees are gone: no partially published material survives the failure.
    expect(await readdir(stateDirectory)).toEqual([]);
    expect(await readdir(publicRoot)).toEqual([]);
  });

  it("closes the adapter, relay and connection when the provider bridge fails to open", async () => {
    const s = scenario();
    const relayClosed = { count: 0 };
    const adapterClosed = { count: 0 };
    vi.spyOn(RuntimeCredentialRelay, "open").mockResolvedValue(fakeRelay(relayClosed) as never);
    await mkdir(stateDirectory, { recursive: true });
    const caPath = join(root, "ca.pem");
    await writeFile(caPath, "-----BEGIN CERTIFICATE-----fixture-----END CERTIFICATE-----\n");
    const adapter = await fakeAdapter(root, caPath, adapterClosed);
    vi.spyOn(RuntimeProxyLoopbackAdapter, "start").mockResolvedValue(adapter.adapter as never);
    // A startup failure of the in-Sandbox helper (e.g. an entry port that will not bind).
    vi.spyOn(NativeProviderBridge, "open").mockRejectedValue(new Error("bridge helper did not become ready"));
    let workerRan = false;
    const runner = makeRunner({
      publicDirectory: publicRoot,
      runWorker: async () => {
        workerRan = true;
        throw new Error("the worker must never execute after a bridge open failure");
      },
      scope: s.scope,
      sent: s.sent,
      state: s.state,
    });
    await driveToReport(runner, s.delivery, s.sent);
    await runner.close();
    expect(workerRan).toBe(false);
    expect(relayClosed.count).toBe(1);
    expect(adapterClosed.count).toBe(1);
    expect(adapter.listening()).toBe(false);
    expect(s.state.activeListeners()).toBe(0);
    expect((reportsOf(s.sent)[0] as { report: { outcome: string } }).report.outcome).toBe("unknown");
    expect(await readdir(stateDirectory)).toEqual([]);
    expect(await readdir(publicRoot)).toEqual([]);
  });

  it("publishes files-only material at the worst valid default path and never a parent socket", async () => {
    // Random per-run identities so concurrent independent test processes never share a fixture.
    const maxName = `a${randomUUID().replaceAll("-", "")}`.padEnd(63, "z");
    const productionStateDir = defaultRunnerStateDir(maxName, "/tmp");
    const directories = cloudRunnerDirectories(productionStateDir);
    await mkdir(productionStateDir, { recursive: true, mode: 0o700 });
    try {
      const { adapterClosed, bridgeClosed, bridgeOpen, relayClosed } = await mockExecutionStack();
      const s = scenario();
      let inspected: string[] | undefined;
      const runner = makeRunner({
        publicDirectory: directories.publicRoot,
        runWorker: async () => {
          // Mid-turn the published per-turn directory must carry files only, never parent sockets.
          const turns = await readdir(directories.publicRoot);
          expect(turns).toHaveLength(1);
          inspected = await readdir(join(directories.publicRoot, turns[0] as string));
          return {
            code: 0,
            stderr: "",
            stdout: `${JSON.stringify({
              kind: "result",
              completion: { executionEffects: "completed", finalText: "prod-path", outcome: "completed" },
            })}\n`,
          };
        },
        scope: s.scope,
        sent: s.sent,
        state: s.state,
        stateDirectory: productionStateDir,
      });
      await driveToReport(runner, s.delivery, s.sent);
      expect((reportsOf(s.sent)[0] as { report: { outcome: string } }).report.outcome).toBe("completed");
      expect(inspected).toBeDefined();
      expect(inspected).toContain("environment.json");
      expect(inspected).toContain("ca.pem");
      expect(inspected).not.toContain("connect.sock");
      expect(inspected).not.toContain("slack.sock");
      // The bridge was opened for exactly the two enumerated adapter loopback targets.
      expect(bridgeOpen).toHaveBeenCalledTimes(1);
      expect(bridgeOpen.mock.calls[0]?.[0]).toMatchObject({ targets: { connect: 18_080, slack: 18_443 } });
      expect(relayClosed.count).toBe(1);
      expect(adapterClosed.count).toBe(1);
      expect(bridgeClosed.count).toBe(1);
      expect(s.state.activeListeners()).toBe(0);
      // Only the persistent public root remains; the turn's material and private scratch are gone.
      expect(await readdir(directories.publicRoot)).toEqual([]);
      expect(await readdir(productionStateDir)).toEqual(["bridge-public"]);
    } finally {
      await rm(productionStateDir, { recursive: true, force: true });
    }
  });

  it.each(["open", "close"])("blocks reuse when helper termination cannot be confirmed during %s", async (phase) => {
    const s = scenario();
    const stack = await mockExecutionStack();
    const terminationError = new NativeSandboxError("delete_failed", "helper termination unconfirmed");
    if (phase === "open") stack.bridgeOpen.mockRejectedValue(terminationError);
    else
      stack.bridgeOpen.mockResolvedValue({
        close: async () => {
          throw terminationError;
        },
      } as never);
    const runWorker = vi.fn(async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        kind: "result",
        completion: { outcome: "completed", executionEffects: "completed", finalText: "done" },
      }),
    }));
    const onPersistenceError = vi.fn();
    const runner = makeRunner({ ...s, runWorker, onPersistenceError, publicDirectory: publicRoot });
    await driveToReport(runner, s.delivery, s.sent);
    const before = runWorker.mock.calls.length;
    const successor = cloudDeliveryFixture({ sessionId: s.delivery.sessionId });
    await runner.handleDeliveryRun({ type: "delivery:run", requestId: successor.requestId, delivery: successor });
    await expect(
      runner.handleVerified({
        type: "delivery:verified",
        requestId: successor.requestId,
        status: "verified",
        model: MODEL_GRANT,
      }),
    ).rejects.toThrow(/namespace could not be verified clean/);
    await runner.waitForActive();
    expect(runWorker).toHaveBeenCalledTimes(before);
    expect(stack.bridgeOpen).toHaveBeenCalledTimes(1);
    expect(onPersistenceError).toHaveBeenCalled();
    expect(stack.adapterClosed.count).toBe(1);
    expect(stack.relayClosed.count).toBe(1);
    expect(s.state.activeListeners()).toBe(0);
    await runner.close();
  });

  it("closes the first execution's bridge before the successor execution opens its own", async () => {
    const s = scenario();
    const events: string[] = [];
    const { bridgeOpen, relayClosed } = await mockExecutionStack({ events });
    const runner = makeRunner({
      publicDirectory: publicRoot,
      runWorker: async () => ({
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          kind: "result",
          completion: { executionEffects: "completed", finalText: "done", outcome: "completed" },
        })}\n`,
      }),
      scope: s.scope,
      sent: s.sent,
      state: s.state,
    });
    await driveToReport(runner, s.delivery, s.sent);
    const second = cloudDeliveryFixture({ sessionId: s.delivery.sessionId });
    await driveToReport(runner, second, s.sent);
    await runner.close();
    // Two executions, two bridges; the predecessor's helper and in-flight connections were gone
    // before the successor's helper ever started.
    expect(bridgeOpen).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["bridge:open", "bridge:close", "bridge:open", "bridge:close"]);
    expect(relayClosed.count).toBe(2);
    expect(await readdir(stateDirectory)).toEqual([]);
    expect(await readdir(publicRoot)).toEqual([]);
  });

  it("opens the same files-only bridge for a Session-message execution and closes it on settle", async () => {
    const s = scenario();
    const { bridgeClosed, bridgeOpen, relayClosed } = await mockExecutionStack();
    let inspected: string[] | undefined;
    const runner = makeRunner({
      publicDirectory: publicRoot,
      runWorker: async () => {
        const turns = await readdir(publicRoot);
        expect(turns).toHaveLength(1);
        inspected = await readdir(join(publicRoot, turns[0] as string));
        return {
          code: 0,
          stderr: "",
          stdout: `${JSON.stringify({
            kind: "result",
            completion: { executionEffects: "completed", finalText: "session-done", outcome: "completed" },
          })}\n`,
        };
      },
      scope: s.scope,
      sent: s.sent,
      state: s.state,
    });
    await driveToSessionSettled(runner, sessionMessageFixture(s.delivery.sessionId), s.sent);
    await runner.close();
    expect((settledOf(s.sent)[0] as { outcome: string }).outcome).toBe("completed");
    expect(bridgeOpen).toHaveBeenCalledTimes(1);
    expect(bridgeOpen.mock.calls[0]?.[0]).toMatchObject({ targets: { connect: 18_080, slack: 18_443 } });
    expect(inspected).toBeDefined();
    expect(inspected).toContain("environment.json");
    expect(inspected).not.toContain("connect.sock");
    expect(inspected).not.toContain("slack.sock");
    expect(bridgeClosed.count).toBe(1);
    expect(relayClosed.count).toBe(1);
    expect(s.state.activeListeners()).toBe(0);
    expect(await readdir(stateDirectory)).toEqual([]);
    expect(await readdir(publicRoot)).toEqual([]);
  });

  it("releases every acquired resource exactly once per successful turn and never accumulates", async () => {
    const s = scenario();
    const { adapter, adapterClosed, bridgeClosed, relayClosed } = await mockExecutionStack();
    const runner = makeRunner({
      publicDirectory: publicRoot,
      runWorker: async () => ({
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          kind: "result",
          completion: { executionEffects: "completed", finalText: "done", outcome: "completed" },
        })}\n`,
      }),
      scope: s.scope,
      sent: s.sent,
      state: s.state,
    });
    await driveToReport(runner, s.delivery, s.sent);
    expect(relayClosed.count).toBe(1);
    expect(adapterClosed.count).toBe(1);
    expect(bridgeClosed.count).toBe(1);
    expect(adapter.listening()).toBe(false);
    expect(s.state.activeListeners()).toBe(0);
    expect(await readdir(stateDirectory)).toEqual([]);
    expect(await readdir(publicRoot)).toEqual([]);
    // A second turn acquires and releases its own resources exactly once; the first close is
    // never repeated.
    const second = cloudDeliveryFixture({ sessionId: s.delivery.sessionId });
    await driveToReport(runner, second, s.sent);
    expect(relayClosed.count).toBe(2);
    expect(adapterClosed.count).toBe(2);
    expect(bridgeClosed.count).toBe(2);
    expect(adapter.listening()).toBe(false);
    expect(s.state.activeListeners()).toBe(0);
    expect(await readdir(stateDirectory)).toEqual([]);
    expect(await readdir(publicRoot)).toEqual([]);
    await runner.close();
    expect(relayClosed.count).toBe(2);
    expect(adapterClosed.count).toBe(2);
    expect(bridgeClosed.count).toBe(2);
  });
});
