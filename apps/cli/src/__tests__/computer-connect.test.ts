import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as client from "@opentag/client";
import {
  AccessTokenProvider,
  OpenTagApi,
  readComputerIdentity,
  readCredentials,
  readMachineCredentials,
  resolveComputerIdentity,
  writeCredentialsAtomically,
} from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { resolveCommandContext } from "../core/command/context.js";
import * as computerCore from "../core/computer/connect.js";
import { runComputerConnect } from "../core/computer/connect.js";
import { formatComputerList } from "../core/computer/formatting.js";
import * as computerQueries from "../core/computer/queries.js";
import { listComputers } from "../core/computer/queries.js";
import type { DaemonServiceManager } from "../core/daemon/service/index.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});

describe("computer connect", () => {
  it("executes the Computer connect command and reports service state", async () => {
    const home = await temporaryHome();
    const runSpy = vi.spyOn(computerCore, "runComputerConnect").mockResolvedValue({
      credentialsPath: `${home}/config/computer-credentials.json`,
      message: "Connected this Computer",
      service: {
        currentHome: home,
        definitionPath: `${home}/service`,
        logHint: "logs",
        platform: "systemd",
        serviceId: "opentag-dev",
        state: "active",
      },
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createProgram().parseAsync(["node", "opentag", "computer", "connect", "code", "--home", home]);
      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({ code: "code", home, noStart: false, serverUrl: channelServerUrl() }),
      );
      expect(stdout).toHaveBeenCalledWith("Connected this Computer\n");
      expect(stdout).toHaveBeenCalledWith("Daemon service opentag-dev is active\n");
    } finally {
      stdout.mockRestore();
      runSpy.mockRestore();
    }
  });

  it("preserves credentials and returns a clean error when daemon reload fails", async () => {
    const home = await temporaryHome();
    const connectResult = { credentialsPath: `${home}/credentials.json`, message: "Connected this Computer" };
    const runSpy = vi
      .spyOn(computerCore, "runComputerConnect")
      .mockRejectedValue(new computerCore.ComputerConnectServiceInstallError(connectResult));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync(["node", "opentag", "computer", "connect", "code", "--home", home]);
      expect(stdout).toHaveBeenCalledWith("Connected this Computer\n");
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("machine credentials were preserved"));
      expect(process.exitCode).toBe(1);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = previousExitCode;
      runSpy.mockRestore();
    }
  });

  it("presents a successful Computer connect as JSON", async () => {
    const home = await temporaryHome();
    const runSpy = vi.spyOn(computerCore, "runComputerConnect").mockResolvedValue({
      credentialsPath: `${home}/config/computer-credentials.json`,
      message: "Connected this Computer",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync(["node", "opentag", "computer", "connect", "code", "--home", home, "--json"]);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"ok":true'));
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
      runSpy.mockRestore();
    }
  });

  it("presents a Computer connect transport failure as structured JSON", async () => {
    const home = await temporaryHome();
    const runSpy = vi.spyOn(computerCore, "runComputerConnect").mockRejectedValue(new Error("connection refused"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync(["node", "opentag", "computer", "connect", "code", "--home", home, "--json"]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"category":"unavailable"'));
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = previousExitCode;
      stderr.mockRestore();
      runSpy.mockRestore();
    }
  });

  it("formats empty and populated Computer lists", () => {
    expect(formatComputerList({ computers: [] })).toBe("No Computers registered");
    expect(
      formatComputerList({
        computers: [
          {
            computerId: "computer-1",
            connectionStatus: "online",
            displayName: "Workstation",
            connectedAt: "2026-08-19T00:00:00.000Z",
            lastSeenAt: "2026-08-19T00:00:00.000Z",
            observedAt: "2026-08-19T00:00:00.000Z",
            createdAt: "2026-08-19T00:00:00.000Z",
            agentIds: [],
            platform: "linux",
          },
        ],
      }),
    ).toBe("Workstation\tcomputer-1\tonline\tlinux\t2026-08-19T00:00:00.000Z");
  });

  it("routes Computer list through the shared presenter in text and JSON modes", async () => {
    const listSpy = vi.spyOn(computerQueries, "listComputers").mockResolvedValue({ computers: [] });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync(["node", "opentag", "computer", "list"]);
      await createProgram().parseAsync(["node", "opentag", "computer", "list", "--json"]);
      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(stdout).toHaveBeenCalledWith("No Computers registered\n");
      expect(stdout).toHaveBeenCalledWith('{"ok":true,"result":{"computers":[]}}\n');
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
      listSpy.mockRestore();
    }
  });

  it("presents an unauthenticated Computer list as a clean non-zero command result", async () => {
    const listSpy = vi
      .spyOn(computerQueries, "listComputers")
      .mockRejectedValue(new Error("OpenTag is not logged in; run login first"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync(["node", "opentag", "computer", "list"]);
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("OpenTag is not logged in; run login first"));
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("at listComputers"));
    } finally {
      process.exitCode = previousExitCode;
      stderr.mockRestore();
      listSpy.mockRestore();
    }
  });

  it("lists Computers through the authenticated Account client", async () => {
    const home = await temporaryHome();
    const response = {
      computers: [
        {
          computerId: "computer-1",
          connectionStatus: "online" as const,
          displayName: "Workstation",
          connectedAt: "2026-08-19T00:00:00.000Z",
          lastSeenAt: "2026-08-19T00:00:00.000Z",
          observedAt: "2026-08-19T00:00:00.000Z",
          createdAt: "2026-08-19T00:00:00.000Z",
          agentIds: [],
          platform: "linux" as const,
        },
      ],
    };
    const credentials = { serverUrl: "https://opentag.example" } as Awaited<ReturnType<typeof readCredentials>>;
    const readCredentialsSpy = vi.spyOn(client, "readCredentials").mockResolvedValue(credentials);
    const tokenSpy = vi.spyOn(AccessTokenProvider.prototype, "getAccessToken").mockResolvedValue("access-token");
    const listSpy = vi.spyOn(OpenTagApi.prototype, "listAccountComputers").mockResolvedValue(response);
    try {
      await expect(listComputers(home)).resolves.toEqual(response);
      expect(readCredentialsSpy).toHaveBeenCalledWith(home);
      expect(tokenSpy).toHaveBeenCalledOnce();
      expect(listSpy).toHaveBeenCalledWith("access-token");
    } finally {
      readCredentialsSpy.mockRestore();
      tokenSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it("requires Account login before listing Computers", async () => {
    const home = await temporaryHome();
    await expect(listComputers(home)).rejects.toThrow("OpenTag is not logged in; run login first");
  });

  it("explains how to finish Account login after Computer onboarding", async () => {
    const home = await temporaryHome();
    await resolveComputerIdentity(home, "https://opentag.example");

    await expect(resolveCommandContext({ home, requireAuth: true })).rejects.toThrow(
      "machine credentials (computer-credentials.json/computer.json) but no Account credentials (credentials.json)",
    );
    await expect(resolveCommandContext({ home, requireAuth: true })).rejects.toThrow(
      "opentag-dev login --server https://opentag.example -- <code>",
    );
    await expect(resolveCommandContext({ home, requireAuth: true })).rejects.toThrow("POST /api/v1/me/connect-codes");
  });

  it("stores machine authority separately from Account credentials and binds one Account Computer", async () => {
    const home = await temporaryHome();
    const accountCredentials = {
      accessToken: "account-access",
      accessTokenExpiresAt: "2030-01-01T00:15:00.000Z",
      refreshToken: "account-refresh",
      serverUrl: "https://opentag.example",
    };
    await writeCredentialsAtomically(accountCredentials, home);
    const firstComputerId = crypto.randomUUID();
    const secondComputerId = crypto.randomUUID();
    const exchangeComputerConnectCode = vi.fn(async (input: { code: string; installationId: string }) => ({
      computerId: input.code === "first-code" ? firstComputerId : secondComputerId,
      installationId: input.installationId,
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
    expect(result.message).not.toContain(firstComputerId);
    await runComputerConnect({
      api: { exchangeComputerConnectCode },
      code: "second-code",
      home,
      noStart: true,
      serverUrl: "https://opentag.example",
    });

    expect(await readCredentials(home)).toEqual(accountCredentials);
    const stored = await readMachineCredentials(home);
    expect(stored?.computer.computerId).toBe(secondComputerId);
    const exchangedComputerIds = exchangeComputerConnectCode.mock.calls.map(([input]) => input.installationId);
    expect(new Set(exchangedComputerIds).size).toBe(2);
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

  it("does not replace the current local binding when code exchange fails", async () => {
    const home = await temporaryHome();
    const firstExchange = vi.fn(async (input: { installationId: string }) => ({
      computerId: crypto.randomUUID(),
      installationId: input.installationId,
      machineToken: `otmc_${crypto.randomUUID()}.${"a".repeat(43)}`,
    }));
    await runComputerConnect({
      api: { exchangeComputerConnectCode: firstExchange },
      code: "valid-code",
      home,
      noStart: true,
      serverUrl: "https://opentag.example",
    });
    const identityBefore = await readComputerIdentity(home);
    const credentialsBefore = await readMachineCredentials(home);

    await expect(
      runComputerConnect({
        api: { exchangeComputerConnectCode: vi.fn().mockRejectedValue(new Error("invalid code")) },
        code: "invalid-code",
        home,
        noStart: true,
        serverUrl: "https://opentag.example",
      }),
    ).rejects.toThrow("invalid code");

    expect(await readComputerIdentity(home)).toEqual(identityBefore);
    expect(await readMachineCredentials(home)).toEqual(credentialsBefore);
  });

  it("restarts an active daemon after storing a machine credential without requiring Account login", async () => {
    const home = await temporaryHome();
    const manager = managerFixture();
    const exchangeComputerConnectCode = vi.fn(async (input: { installationId: string }) => ({
      computerId: crypto.randomUUID(),
      installationId: input.installationId,
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
    expect(await readMachineCredentials(home)).toMatchObject({ computer: expect.any(Object), version: 3 });
    expect(manager.status).toHaveBeenCalledOnce();
    expect(manager.restart).toHaveBeenCalledOnce();
    expect(manager.installAndStart).not.toHaveBeenCalled();
  });

  it("installs an inactive daemon after storing the first machine credential", async () => {
    const home = await temporaryHome();
    const manager = managerFixture();
    manager.status = vi.fn(async () => ({ ...(await managerFixture().status()), state: "inactive" as const }));
    const exchangeComputerConnectCode = vi.fn(async (input: { installationId: string }) => ({
      computerId: crypto.randomUUID(),
      installationId: input.installationId,
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

function channelServerUrl(): string {
  return "http://127.0.0.1:8000";
}

async function temporaryHome(): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const home = await realpath(await mkdtemp(join(tmpdir(), "opentag-computer-connect-")));
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
