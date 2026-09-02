import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientLogBindings, ClientLogger } from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  configureClientLoggerForService: vi.fn(),
  createClientRuntime: vi.fn(),
  createLogger: vi.fn(),
  readMachineCredentials: vi.fn(),
  resolveComputerIdentity: vi.fn(),
}));
const ownershipMocks = vi.hoisted(() => ({
  acquireDaemonOwner: vi.fn(),
}));

vi.mock("@opentag/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opentag/client")>();
  return {
    ...original,
    configureClientLoggerForService: clientMocks.configureClientLoggerForService,
    createLogger: clientMocks.createLogger.mockImplementation(original.createLogger),
    OpenTagApi: class {},
    createClientRuntime: clientMocks.createClientRuntime,
    readMachineCredentials: clientMocks.readMachineCredentials,
    resolveComputerIdentity: clientMocks.resolveComputerIdentity,
  };
});

vi.mock("../core/daemon/ownership.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../core/daemon/ownership.js")>();
  ownershipMocks.acquireDaemonOwner.mockImplementation(original.acquireDaemonOwner);
  return { ...original, acquireDaemonOwner: ownershipMocks.acquireDaemonOwner };
});

import { acquireDaemonOwner } from "../core/daemon/ownership.js";
import { resolveDaemonPaths } from "../core/daemon/paths.js";
import { runDaemonLifecycle, runDaemonService, runDaemonServiceEntry } from "../core/daemon/runtime.js";

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  delete process.env.OPENTAG_SERVICE_MODE;
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("daemon service runtime", () => {
  it("configures the Client-owned service log before daemon startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-log-"));
    directories.push(home);
    process.env.OPENTAG_SERVICE_MODE = "1";
    clientMocks.readMachineCredentials.mockResolvedValue(undefined);

    await expect(runDaemonService({ home, logger: noopLogger() })).rejects.toThrow("not connected");

    expect(clientMocks.configureClientLoggerForService).toHaveBeenCalledOnce();
    expect(clientMocks.configureClientLoggerForService).toHaveBeenCalledWith(join(home, "logs"));
  });

  it("logs malformed daemon environment lines without exposing their values", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-malformed-env-"));
    directories.push(home);
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.config, { mode: 0o700, recursive: true });
    await writeFile(paths.daemonEnvironment, "BROKEN\n", { mode: 0o600 });
    const entries: Array<{ fields: ClientLogBindings; message: string }> = [];
    clientMocks.readMachineCredentials.mockResolvedValue(undefined);

    await expect(runDaemonService({ home, logger: recordingLogger(entries) })).rejects.toThrow("not connected");
    expect(entries).toContainEqual(expect.objectContaining({ message: "Malformed daemon environment line ignored" }));
  });

  it("logs an invalid daemon environment at the service entry while returning a clean exit", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-invalid-env-entry-"));
    directories.push(home);
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.config, { mode: 0o700, recursive: true });
    await writeFile(paths.daemonEnvironment, "OPENTAG_SERVER_URL=https://example.test\n", { mode: 0o644 });
    const entries: Array<{ fields: ClientLogBindings; message: string }> = [];

    await expect(runDaemonServiceEntry({ home, logger: recordingLogger(entries) })).resolves.toBe(0);
    expect(entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ category: "configuration", instanceId: expect.any(String) }),
        message: "Daemon service configuration prevented startup; inspect daemon status",
      }),
    );
  });

  it("configures the service log before reporting an already-held daemon owner", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-owned-log-"));
    directories.push(home);
    process.env.OPENTAG_SERVICE_MODE = "1";
    const entries: Array<{ fields: ClientLogBindings; message: string }> = [];
    const owner = await acquireDaemonOwner(home, "existing-instance");

    try {
      await expect(runDaemonService({ home, logger: recordingLogger(entries) })).rejects.toThrow("already running");
    } finally {
      await owner.release();
    }

    expect(clientMocks.configureClientLoggerForService).toHaveBeenCalledWith(join(home, "logs"));
    expect(entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          category: "ownership",
          instanceId: expect.any(String),
        }),
        message: "Daemon is already running; inspect daemon status",
      }),
    );
  });

  it("uses a dual logger for an already-held daemon owner", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-owned-dual-"));
    directories.push(home);
    const owner = await acquireDaemonOwner(home, "existing-instance");

    try {
      await expect(runDaemonService({ home })).rejects.toThrow("already running");
    } finally {
      await owner.release();
    }

    expect(clientMocks.createLogger).toHaveBeenCalledWith("daemon", { destination: "dual" });
  });

  it("does not start after a signal arrives during startup", async () => {
    const signals = new EventEmitter();
    const run = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const stop = vi.fn<() => void>();
    let finishStartup: ((runtime: { run(): Promise<void>; stop(): void }) => void) | undefined;
    let startupSignal: AbortSignal | undefined;
    const startupPending = new Promise<{ run(): Promise<void>; stop(): void }>((resolve) => {
      finishStartup = resolve;
    });

    const daemon = runDaemonLifecycle((signal) => {
      startupSignal = signal;
      return startupPending;
    }, signals);
    signals.emit("SIGTERM");

    expect(startupSignal?.aborted).toBe(true);
    finishStartup?.({ run, stop });
    await daemon;

    expect(run).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops actual daemon startup when a signal arrives while machine credentials are loading", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-run-"));
    directories.push(home);
    const signals = new EventEmitter();
    let finishCredentials: ((credentials: ReturnType<typeof machineCredentials>) => void) | undefined;
    clientMocks.readMachineCredentials.mockReturnValue(
      new Promise((resolve) => {
        finishCredentials = resolve;
      }),
    );

    const daemon = runDaemonService({ home, signals: signals as unknown as NodeJS.Process });
    await vi.waitFor(() => expect(clientMocks.readMachineCredentials).toHaveBeenCalledOnce());
    signals.emit("SIGINT");
    finishCredentials?.(machineCredentials());
    await daemon;

    expect(clientMocks.createClientRuntime).not.toHaveBeenCalled();
    await expect(access(resolveDaemonPaths(home).daemonOwner)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("composes the Codex Client Runtime after authenticated daemon startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-run-"));
    directories.push(home);
    const signals = new EventEmitter();
    const run = vi.fn(async () => undefined);
    const stop = vi.fn();
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockResolvedValue(computerIdentity());
    clientMocks.createClientRuntime.mockResolvedValue({ run, stop });

    await runDaemonService({ home, logger: noopLogger(), signals: signals as unknown as NodeJS.Process });

    expect(clientMocks.createClientRuntime).toHaveBeenCalledOnce();
    expect(clientMocks.createClientRuntime.mock.calls[0]?.[1]).toMatchObject({ home, clientVersion: "0.0.2" });
    expect(clientMocks.createClientRuntime.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(run).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it("fails closed when the retired credential format cannot be read", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-retired-credentials-"));
    directories.push(home);
    const signals = new EventEmitter();
    clientMocks.readMachineCredentials.mockRejectedValue(new Error("unsupported format"));
    clientMocks.resolveComputerIdentity.mockResolvedValue(computerIdentity());

    await expect(
      runDaemonService({ home, logger: noopLogger(), signals: signals as unknown as NodeJS.Process }),
    ).rejects.toThrow("run computer connect again");
    expect(clientMocks.createClientRuntime).not.toHaveBeenCalled();
  });

  it("fails closed when the local Computer identity cannot be read", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-invalid-identity-"));
    directories.push(home);
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockRejectedValue(new Error("malformed identity"));

    await expect(runDaemonService({ home, logger: noopLogger() })).rejects.toThrow(
      "local Computer identity is invalid",
    );
  });

  it("rejects a machine credential that belongs to another Computer", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-identity-mismatch-"));
    directories.push(home);
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockResolvedValue({
      ...computerIdentity(),
      computerId: "00000000-0000-4000-8000-000000000099",
    });

    await expect(runDaemonService({ home, logger: noopLogger() })).rejects.toThrow("belongs to another Computer");
  });

  it("reports unsupported daemon platforms after loading credentials", async () => {
    const originalPlatform = process.platform;
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-unsupported-"));
    directories.push(home);
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockResolvedValue(computerIdentity());
    try {
      Object.defineProperty(process, "platform", { configurable: true, value: "freebsd" });
      await expect(runDaemonService({ home, logger: noopLogger() })).rejects.toThrow(
        "Unsupported daemon service platform",
      );
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("returns success from the service entry after a clean runtime", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-entry-success-"));
    directories.push(home);
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockResolvedValue(computerIdentity());
    clientMocks.createClientRuntime.mockResolvedValue({ run: vi.fn(async () => undefined), stop: vi.fn() });

    await expect(runDaemonServiceEntry({ home, logger: noopLogger() })).resolves.toBe(0);
  });

  it("logs ownership release failures safely and returns a failed service exit", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-release-"));
    directories.push(home);
    const signals = new EventEmitter();
    const entries: Array<{ fields: ClientLogBindings; message: string }> = [];
    const release = vi.fn(async () => {
      throw new Error("sensitive release failure");
    });
    ownershipMocks.acquireDaemonOwner.mockResolvedValueOnce({ release });
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockResolvedValue(computerIdentity());
    clientMocks.createClientRuntime.mockResolvedValue({
      run: vi.fn(async () => undefined),
      stop: vi.fn(),
    });

    await expect(
      runDaemonServiceEntry({
        home,
        logger: recordingLogger(entries),
        signals: signals as unknown as NodeJS.Process,
      }),
    ).resolves.toBe(1);

    expect(release).toHaveBeenCalledOnce();
    expect(entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          category: "ownership_release",
          installationId: "00000000-0000-4000-8000-000000000001",
          instanceId: expect.any(String),
        }),
        message: "Daemon ownership release failed",
      }),
    );
    expect(JSON.stringify(entries)).not.toContain("sensitive release failure");
  });

  it("preserves the runtime failure when ownership release also fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-double-failure-"));
    directories.push(home);
    const entries: Array<{ fields: ClientLogBindings; message: string }> = [];
    ownershipMocks.acquireDaemonOwner.mockResolvedValueOnce({
      release: vi.fn(async () => {
        throw new Error("sensitive release failure");
      }),
    });
    clientMocks.readMachineCredentials.mockResolvedValue(undefined);

    await expect(runDaemonService({ home, logger: recordingLogger(entries) })).rejects.toThrow("not connected");

    expect(entries).toContainEqual(
      expect.objectContaining({ fields: expect.objectContaining({ category: "configuration" }) }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ category: "ownership_release", instanceId: expect.any(String) }),
        message: "Daemon ownership release failed",
      }),
    );
    expect(JSON.stringify(entries)).not.toContain("sensitive release failure");
  });

  it("does not write daemon logs after ownership is released", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-release-order-"));
    directories.push(home);
    const signals = new EventEmitter();
    const entries: Array<{ fields: ClientLogBindings; message: string }> = [];
    let entriesAtRelease = -1;
    ownershipMocks.acquireDaemonOwner.mockResolvedValueOnce({
      release: vi.fn(async () => {
        entriesAtRelease = entries.length;
      }),
    });
    clientMocks.readMachineCredentials.mockResolvedValue(undefined);

    await expect(
      runDaemonService({
        home,
        logger: recordingLogger(entries),
        signals: signals as unknown as NodeJS.Process,
      }),
    ).rejects.toThrow("not connected");

    expect(entriesAtRelease).toBeGreaterThan(0);
    expect(entries).toHaveLength(entriesAtRelease);
    expect(entries.at(-1)?.message).toBe("Daemon runtime stopped");
  });

  it("suppresses delayed runtime child logs after ownership is released", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-delayed-log-"));
    directories.push(home);
    const signals = new EventEmitter();
    const entries: Array<{ fields: ClientLogBindings; message: string }> = [];
    let delayedLogger: ClientLogger | undefined;
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockResolvedValue(computerIdentity());
    clientMocks.createClientRuntime.mockImplementation(async (_connection, options) => {
      delayedLogger = options.logger.child({ module: "report-recovery" });
      return { run: vi.fn(async () => undefined), stop: vi.fn() };
    });

    await runDaemonService({
      home,
      logger: recordingLogger(entries),
      signals: signals as unknown as NodeJS.Process,
    });
    const entriesAfterRelease = entries.length;
    delayedLogger?.warn({ agentId: "agent-1", sessionId: "session-1" }, "Delayed recovery log");

    expect(entries).toHaveLength(entriesAfterRelease);
    expect(entries).not.toContainEqual(expect.objectContaining({ message: "Delayed recovery log" }));
  });

  it("keeps instance and Computer identity on a terminal runtime failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-terminal-"));
    directories.push(home);
    const signals = new EventEmitter();
    const entries: Array<{ fields: ClientLogBindings; message: string }> = [];
    clientMocks.readMachineCredentials.mockResolvedValue(machineCredentials());
    clientMocks.resolveComputerIdentity.mockResolvedValue(computerIdentity());
    clientMocks.createClientRuntime.mockResolvedValue({
      run: vi.fn(async () => {
        throw new Error("sensitive provider failure");
      }),
      stop: vi.fn(),
    });

    await expect(
      runDaemonService({
        home,
        logger: recordingLogger(entries),
        signals: signals as unknown as NodeJS.Process,
      }),
    ).rejects.toThrow("sensitive provider failure");

    expect(entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          category: "unexpected",
          installationId: "00000000-0000-4000-8000-000000000001",
          instanceId: expect.any(String),
        }),
        message: "Daemon stopped because of an unexpected internal failure",
      }),
    );
    expect(JSON.stringify(entries)).not.toContain("sensitive provider failure");
  });
});

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

function recordingLogger(
  entries: Array<{ fields: ClientLogBindings; message: string }>,
  bindings: ClientLogBindings = {},
): ClientLogger {
  const record = (fields: ClientLogBindings, message: string) =>
    entries.push({ fields: { ...bindings, ...fields }, message });
  return {
    child: (childBindings) => recordingLogger(entries, { ...bindings, ...childBindings }),
    debug: record,
    error: record,
    info: record,
    warn: record,
  };
}
