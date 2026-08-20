import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientLogBindings, ClientLogger } from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  configureClientLoggerForService: vi.fn(),
  createClientRuntime: vi.fn(),
  getAccessTokenLease: vi.fn(),
  me: vi.fn(),
  readCredentials: vi.fn(),
  resolveComputerIdentity: vi.fn(),
}));
const ownershipMocks = vi.hoisted(() => ({
  acquireDaemonOwner: vi.fn(),
}));

vi.mock("@opentag/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opentag/client")>();
  return {
    ...original,
    AccessTokenProvider: class {
      getAccessTokenLease = clientMocks.getAccessTokenLease;
    },
    configureClientLoggerForService: clientMocks.configureClientLoggerForService,
    OpenTagApi: class {
      me = clientMocks.me;
    },
    createClientRuntime: clientMocks.createClientRuntime,
    readCredentials: clientMocks.readCredentials,
    resolveComputerIdentity: clientMocks.resolveComputerIdentity,
  };
});

vi.mock("../core/daemon/ownership.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../core/daemon/ownership.js")>();
  ownershipMocks.acquireDaemonOwner.mockImplementation(original.acquireDaemonOwner);
  return { ...original, acquireDaemonOwner: ownershipMocks.acquireDaemonOwner };
});

import { acquireDaemonOwner } from "../core/daemon/ownership.js";
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
    clientMocks.readCredentials.mockResolvedValue(undefined);

    await expect(runDaemonService({ home, logger: noopLogger() })).rejects.toThrow("not logged in");

    expect(clientMocks.configureClientLoggerForService).toHaveBeenCalledOnce();
    expect(clientMocks.configureClientLoggerForService).toHaveBeenCalledWith(join(home, "logs"));
  });

  it("does not configure or touch the service log when daemon ownership is already held", async () => {
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

    expect(clientMocks.configureClientLoggerForService).not.toHaveBeenCalled();
    await expect(access(join(home, "logs", "client.log"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("stops actual daemon startup when a signal arrives during token refresh", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-run-"));
    directories.push(home);
    const signals = new EventEmitter();
    let finishRefresh: ((lease: { accessToken: string; expiresAt: string }) => void) | undefined;
    clientMocks.readCredentials.mockResolvedValue({
      accessToken: "old-access",
      accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshToken: "refresh",
      serverUrl: "http://127.0.0.1:3000",
    });
    clientMocks.getAccessTokenLease.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );

    const daemon = runDaemonService({ home, signals: signals as unknown as NodeJS.Process });
    await vi.waitFor(() => expect(clientMocks.getAccessTokenLease).toHaveBeenCalledOnce());
    signals.emit("SIGINT");
    finishRefresh?.({ accessToken: "new-access", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await daemon;

    expect(clientMocks.me).not.toHaveBeenCalled();
    await expect(access(join(home, "daemon-owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("composes the Codex Client Runtime after authenticated daemon startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-run-"));
    directories.push(home);
    const signals = new EventEmitter();
    const run = vi.fn(async () => undefined);
    const stop = vi.fn();
    clientMocks.readCredentials.mockResolvedValue({
      accessToken: "access",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: "refresh",
      serverUrl: "http://127.0.0.1:3000",
    });
    clientMocks.getAccessTokenLease.mockResolvedValue({
      accessToken: "access",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    clientMocks.me.mockResolvedValue({ user: { id: "user-1" }, memberships: [] });
    clientMocks.resolveComputerIdentity.mockResolvedValue({
      version: 1,
      computerId: "00000000-0000-4000-8000-000000000001",
      serverUrl: "http://127.0.0.1:3000",
      userId: "user-1",
    });
    clientMocks.createClientRuntime.mockResolvedValue({ run, stop });

    await runDaemonService({ home, logger: noopLogger(), signals: signals as unknown as NodeJS.Process });

    expect(clientMocks.createClientRuntime).toHaveBeenCalledOnce();
    expect(clientMocks.createClientRuntime.mock.calls[0]?.[1]).toMatchObject({ home, clientVersion: "0.0.1" });
    expect(clientMocks.createClientRuntime.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(run).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
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
    clientMocks.readCredentials.mockResolvedValue({
      accessToken: "access",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: "refresh",
      serverUrl: "http://127.0.0.1:3000",
    });
    clientMocks.getAccessTokenLease.mockResolvedValue({
      accessToken: "access",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    clientMocks.me.mockResolvedValue({ user: { id: "user-1" }, memberships: [] });
    clientMocks.resolveComputerIdentity.mockResolvedValue({
      version: 1,
      computerId: "00000000-0000-4000-8000-000000000001",
      serverUrl: "http://127.0.0.1:3000",
      userId: "user-1",
    });
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
          computerId: "00000000-0000-4000-8000-000000000001",
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
    clientMocks.readCredentials.mockResolvedValue(undefined);

    await expect(runDaemonService({ home, logger: recordingLogger(entries) })).rejects.toThrow("not logged in");

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
    clientMocks.readCredentials.mockResolvedValue(undefined);

    await expect(
      runDaemonService({
        home,
        logger: recordingLogger(entries),
        signals: signals as unknown as NodeJS.Process,
      }),
    ).rejects.toThrow("not logged in");

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
    clientMocks.readCredentials.mockResolvedValue({
      accessToken: "access",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: "refresh",
      serverUrl: "http://127.0.0.1:3000",
    });
    clientMocks.getAccessTokenLease.mockResolvedValue({
      accessToken: "access",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    clientMocks.me.mockResolvedValue({ user: { id: "user-1" }, memberships: [] });
    clientMocks.resolveComputerIdentity.mockResolvedValue({
      version: 1,
      computerId: "00000000-0000-4000-8000-000000000001",
      serverUrl: "http://127.0.0.1:3000",
      userId: "user-1",
    });
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
    clientMocks.readCredentials.mockResolvedValue({
      accessToken: "access",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: "refresh",
      serverUrl: "http://127.0.0.1:3000",
    });
    clientMocks.getAccessTokenLease.mockResolvedValue({
      accessToken: "access",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    clientMocks.me.mockResolvedValue({ user: { id: "user-1" }, memberships: [] });
    clientMocks.resolveComputerIdentity.mockResolvedValue({
      version: 1,
      computerId: "00000000-0000-4000-8000-000000000001",
      serverUrl: "http://127.0.0.1:3000",
      userId: "user-1",
    });
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
          computerId: "00000000-0000-4000-8000-000000000001",
          instanceId: expect.any(String),
        }),
        message: "Daemon stopped because of an unexpected internal failure",
      }),
    );
    expect(JSON.stringify(entries)).not.toContain("sensitive provider failure");
  });
});

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
