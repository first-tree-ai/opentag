import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  getAccessTokenLease: vi.fn(),
  me: vi.fn(),
  readCredentials: vi.fn(),
  resolveComputerIdentity: vi.fn(),
}));

vi.mock("@opentag/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opentag/client")>();
  return {
    ...original,
    AccessTokenProvider: class {
      getAccessTokenLease = clientMocks.getAccessTokenLease;
    },
    OpenTagApi: class {
      me = clientMocks.me;
    },
    readCredentials: clientMocks.readCredentials,
    resolveComputerIdentity: clientMocks.resolveComputerIdentity,
  };
});

import { runDaemon, runDaemonLifecycle } from "../core/daemon/runtime.js";

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("daemon lifecycle", () => {
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

    const daemon = runDaemon({ home, signals: signals as unknown as NodeJS.Process });
    await vi.waitFor(() => expect(clientMocks.getAccessTokenLease).toHaveBeenCalledOnce());
    signals.emit("SIGINT");
    finishRefresh?.({ accessToken: "new-access", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await daemon;

    expect(clientMocks.me).not.toHaveBeenCalled();
    await expect(access(join(home, "daemon-owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
