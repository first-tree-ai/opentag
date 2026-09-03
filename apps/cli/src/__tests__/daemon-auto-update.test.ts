import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientLogBindings, ClientLogger, UpdaterStateSnapshot } from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPERVISOR_RESTART_EXIT_CODE } from "../core/daemon/handoff.js";

const clientMocks = vi.hoisted(() => ({
  configureClientLoggerForService: vi.fn(),
  createClientRuntime: vi.fn(),
  readMachineCredentials: vi.fn(),
  resolveComputerIdentity: vi.fn(),
}));

vi.mock("@opentag/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opentag/client")>();
  return {
    ...original,
    configureClientLoggerForService: clientMocks.configureClientLoggerForService,
    OpenTagApi: class {},
    createClientRuntime: clientMocks.createClientRuntime,
    readMachineCredentials: clientMocks.readMachineCredentials,
    resolveComputerIdentity: clientMocks.resolveComputerIdentity,
  };
});

import { runDaemonService, runDaemonServiceEntry } from "../core/daemon/runtime.js";

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-daemon-update-"));
  directories.push(home);
  return home;
}

function computerIdentity() {
  return {
    version: 2 as const,
    computerId: "00000000-0000-4000-8000-000000000001",
    serverUrl: "http://127.0.0.1:3000",
  };
}

function machineCredentials() {
  return {
    version: 3 as const,
    computer: {
      computerId: "00000000-0000-4000-8000-000000000002",
      installationId: computerIdentity().computerId,
      machineToken: `otmc_${"a".repeat(64)}`,
      serverUrl: computerIdentity().serverUrl,
    },
  };
}

function noopLogger(): ClientLogger {
  return {
    child: () => noopLogger(),
    debug: (_fields: ClientLogBindings, _message: string) => undefined,
    error: (_fields: ClientLogBindings, _message: string) => undefined,
    info: (_fields: ClientLogBindings, _message: string) => undefined,
    warn: (_fields: ClientLogBindings, _message: string) => undefined,
  };
}

interface FakeRuntime {
  run(): Promise<void>;
  stop(): void;
  quiesced: boolean;
  stopped: boolean;
}

function fakeRuntime(protectedWork: { total: number }): FakeRuntime {
  const runtime: FakeRuntime = {
    quiesced: false,
    stopped: false,
    run: () =>
      new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (runtime.stopped) {
            clearInterval(timer);
            resolve();
          }
        }, 5);
        timer.unref();
      }),
    stop: () => {
      runtime.stopped = true;
    },
  };
  clientMocks.createClientRuntime.mockResolvedValue({
    run: runtime.run,
    stop: runtime.stop,
    quiesceForUpdate: () => {
      runtime.quiesced = true;
      return () => {
        runtime.quiesced = false;
      };
    },
    protectedWork: () => ({
      sessionActivities: 0,
      pendingRecoveries: 0,
      custodyTurns: 0,
      activeTurns: 0,
      pendingReports: protectedWork.total,
      queuedSessionMessages: 0,
      total: protectedWork.total,
    }),
  });
  return runtime;
}

function memoryStore(initial?: UpdaterStateSnapshot) {
  let stored = initial;
  return {
    state: () => stored,
    loadState: async () => stored,
    saveState: async (state: UpdaterStateSnapshot) => {
      stored = structuredClone(state);
    },
  };
}

describe("daemon automatic upgrade", () => {
  it("installs the advertised target, refreshes through the new binary, and hands off with the reserved exit code", async () => {
    const home = await tempHome();
    const signals = new EventEmitter();
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockResolvedValue(computerIdentity());
    const runtime = fakeRuntime({ total: 0 });
    const store = memoryStore();
    const installs: string[] = [];
    const refreshes: number[] = [];

    const exitCode = await runDaemonServiceEntry({
      home,
      logger: noopLogger(),
      signals: signals as unknown as NodeJS.Process,
      autoUpdate: {
        attach: true,
        installMode: { mode: "portable", root: "/portable/root", binDir: "/portable/bin" },
        installTarget: async (target) => {
          installs.push(target);
        },
        refreshService: async () => {
          refreshes.push(1);
        },
        stateStore: store,
        initialTarget: { channel: "dev", version: "0.0.3" },
      },
    });

    expect(exitCode).toBe(SUPERVISOR_RESTART_EXIT_CODE);
    expect(installs).toEqual(["0.0.3"]);
    expect(refreshes).toHaveLength(1);
    expect(runtime.stopped).toBe(true);
    expect(runtime.quiesced).toBe(true);
    expect(store.state()).toMatchObject({ state: "installed", target: "0.0.3" });
    expect(store.state()?.attempts["0.0.3"]).toMatchObject({ result: "installed" });
  });

  it("waits for protected work and reports a blocked failure without handing off", async () => {
    const home = await tempHome();
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockResolvedValue(computerIdentity());
    const protectedWork = { total: 3 };
    const runtime = fakeRuntime(protectedWork);
    const store = memoryStore();
    const installs: string[] = [];

    const daemon = runDaemonService({
      home,
      logger: noopLogger(),
      signals: new EventEmitter() as unknown as NodeJS.Process,
      autoUpdate: {
        attach: true,
        installMode: { mode: "portable", root: "/portable/root", binDir: "/portable/bin" },
        installTarget: async (target) => {
          installs.push(target);
          throw new Error("checksum mismatch");
        },
        refreshService: async () => undefined,
        stateStore: store,
        checkIntervalMs: 5,
        initialTarget: { channel: "dev", version: "0.0.3" },
      },
    });
    // Protected work is present: the updater must wait indefinitely and never force-install.
    await vi.waitFor(() => expect(store.state()?.state).toBe("awaiting_protected_work"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(installs).toEqual([]);
    expect(runtime.stopped).toBe(false);
    expect(runtime.quiesced).toBe(true);

    // Protected work drains; the attempt then fails once and becomes blocked without a handoff.
    protectedWork.total = 0;
    await vi.waitFor(() => expect(store.state()?.state).toBe("blocked"));
    expect(installs).toEqual(["0.0.3"]);
    expect(store.state()?.attempts["0.0.3"]).toMatchObject({ result: "failed", failureReason: "checksum mismatch" });
    expect(runtime.stopped).toBe(false);
    expect(runtime.quiesced).toBe(false);

    runtime.stop();
    const result = await daemon;
    expect(result.supervisorRestartRequested).toBe(false);
  });

  it("does not attach the updater for npm-global installs", async () => {
    const home = await tempHome();
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockResolvedValue(computerIdentity());
    const runtime = fakeRuntime({ total: 0 });
    const store = memoryStore();
    const installs: string[] = [];

    const daemon = runDaemonService({
      home,
      logger: noopLogger(),
      signals: new EventEmitter() as unknown as NodeJS.Process,
      autoUpdate: {
        attach: true,
        installMode: { mode: "npm-global" },
        installTarget: async (target) => {
          installs.push(target);
        },
        stateStore: store,
        initialTarget: { channel: "dev", version: "0.0.3" },
      },
    });
    await vi.waitFor(() => expect(clientMocks.createClientRuntime).toHaveBeenCalledOnce());
    runtime.stop();
    await daemon;
    expect(installs).toEqual([]);
    expect(store.state()).toBeUndefined();
  });
});
