import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentials, readMachineCredentials, writeCredentialsAtomically } from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runComputerConnect } from "../core/computer/connect.js";
import type { DaemonServiceManager } from "../core/daemon/service/index.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});

describe("computer connect", () => {
  it("stores machine authority separately from Account credentials and keeps one physical identity", async () => {
    const home = await temporaryHome();
    const accountCredentials = {
      accessToken: "account-access",
      accessTokenExpiresAt: "2030-01-01T00:15:00.000Z",
      refreshToken: "account-refresh",
      serverUrl: "https://opentag.example",
    };
    await writeCredentialsAtomically(accountCredentials, home);
    const firstWorkspaceId = crypto.randomUUID();
    const secondWorkspaceId = crypto.randomUUID();
    const exchangeComputerConnectCode = vi.fn(async (input: { code: string; computerId: string }) => ({
      workspaceComputerId: crypto.randomUUID(),
      workspaceId: input.code === "first-code" ? firstWorkspaceId : secondWorkspaceId,
      computerId: input.computerId,
      machineToken: `otmc_${crypto.randomUUID()}.${"a".repeat(43)}`,
    }));

    const result = await runComputerConnect({
      api: { exchangeComputerConnectCode },
      code: "first-code",
      home,
      noStart: true,
      serverUrl: "https://opentag.example",
    });
    expect(result.message).toBe("Connected this Computer");
    expect(result.message).not.toContain(firstWorkspaceId);
    await runComputerConnect({
      api: { exchangeComputerConnectCode },
      code: "second-code",
      home,
      noStart: true,
      serverUrl: "https://opentag.example",
    });

    expect(await readCredentials(home)).toEqual(accountCredentials);
    const stored = await readMachineCredentials(home);
    expect(stored?.enrollments).toHaveLength(2);
    expect(stored?.enrollments.map(({ workspaceId }) => workspaceId).sort()).toEqual(
      [firstWorkspaceId, secondWorkspaceId].sort(),
    );
    const exchangedComputerIds = exchangeComputerConnectCode.mock.calls.map(([input]) => input.computerId);
    expect(new Set(exchangedComputerIds).size).toBe(1);
    expect(JSON.stringify(stored)).not.toContain("account-access");
    expect(JSON.stringify(stored)).not.toContain("account-refresh");
  });

  it("preflights daemon installation before consuming a Computer connect code", async () => {
    const home = await temporaryHome();
    const exchangeComputerConnectCode = vi.fn();
    const manager = managerFixture();
    manager.preflight = vi.fn().mockRejectedValue(new Error("unsupported service manager"));

    await expect(
      runComputerConnect({
        api: { exchangeComputerConnectCode },
        code: "one-time-code",
        home,
        manager,
        serverUrl: "https://opentag.example",
      }),
    ).rejects.toThrow("unsupported service manager");
    expect(exchangeComputerConnectCode).not.toHaveBeenCalled();
    expect(await readMachineCredentials(home)).toBeUndefined();
  });

  it("restarts an active daemon after storing a machine credential without requiring Account login", async () => {
    const home = await temporaryHome();
    const manager = managerFixture();
    const exchangeComputerConnectCode = vi.fn(async (input: { computerId: string }) => ({
      workspaceComputerId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      computerId: input.computerId,
      machineToken: `otmc_${crypto.randomUUID()}.${"a".repeat(43)}`,
    }));

    await expect(
      runComputerConnect({
        api: { exchangeComputerConnectCode },
        code: "rotation-code",
        home,
        manager,
        serverUrl: "https://opentag.example",
      }),
    ).resolves.toMatchObject({ service: { state: "active" } });

    expect(await readCredentials(home)).toBeUndefined();
    expect(await readMachineCredentials(home)).toMatchObject({ enrollments: [expect.any(Object)] });
    expect(manager.status).toHaveBeenCalledOnce();
    expect(manager.restart).toHaveBeenCalledOnce();
    expect(manager.installAndStart).not.toHaveBeenCalled();
  });

  it("installs an inactive daemon after storing the first machine credential", async () => {
    const home = await temporaryHome();
    const manager = managerFixture();
    manager.status = vi.fn(async () => ({ ...(await managerFixture().status()), state: "inactive" as const }));
    const exchangeComputerConnectCode = vi.fn(async (input: { computerId: string }) => ({
      workspaceComputerId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      computerId: input.computerId,
      machineToken: `otmc_${crypto.randomUUID()}.${"a".repeat(43)}`,
    }));

    await runComputerConnect({
      api: { exchangeComputerConnectCode },
      code: "first-code",
      home,
      manager,
      serverUrl: "https://opentag.example",
    });

    expect(manager.installAndStart).toHaveBeenCalledOnce();
    expect(manager.restart).not.toHaveBeenCalled();
  });
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-computer-connect-"));
  homes.push(home);
  return home;
}

function managerFixture(): DaemonServiceManager {
  const info = {
    currentHome: "/tmp/opentag",
    definitionPath: "/tmp/opentag.service",
    drifted: false,
    logHint: "logs",
    platform: "systemd" as const,
    serviceId: "opentag",
    state: "active" as const,
  };
  return {
    preflight: vi.fn(),
    installAndStart: vi.fn(async () => info),
    restart: vi.fn(async () => info),
    start: vi.fn(async () => info),
    status: vi.fn(async () => info),
    stop: vi.fn(async () => ({ ...info, state: "inactive" as const })),
    uninstall: vi.fn(async () => ({ ...info, state: "not-installed" as const })),
  };
}
