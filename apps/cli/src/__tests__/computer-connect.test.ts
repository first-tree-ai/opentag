import { mkdtemp, realpath, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
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
      computerId: "computer-1",
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
      // A running service is implied; no extra status line.
      expect(stdout).toHaveBeenCalledTimes(1);
    } finally {
      stdout.mockRestore();
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
      .mockRejectedValue(new Error("openTag is not logged in; run login first"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync(["node", "opentag", "computer", "list"]);
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("openTag is not logged in; run login first"));
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
    await expect(listComputers(home)).rejects.toThrow("openTag is not logged in; run login first");
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
    expect(result.message).toBe(`Connected this computer (${hostname()}) to openTag.`);
    expect(result.computerId).toBe(firstComputerId);
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
    // A rerun on the same home keeps its installation identity and proves the current credential.
    const exchanged = exchangeComputerConnectCode.mock.calls.map(([input]) => input as Record<string, unknown>);
    expect(new Set(exchanged.map((input) => input.installationId)).size).toBe(1);
    expect(exchanged[0]?.machineToken).toBeUndefined();
    expect(exchanged[1]?.machineToken).toMatch(/^otmc_/);
    expect(exchanged.every((input) => input.reportOutcome === true)).toBe(true);
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

  it("retains exact Runtime evidence without persisting it and preserves credentials after daemon failure", async () => {
    const home = await temporaryHome();
    const manager = managerFixture();
    manager.restart = vi.fn().mockRejectedValue(new Error("service reload failed"));
    const exchangeComputerConnectCode = vi.fn(async (input: { installationId: string; clientVersion: string }) => ({
      computerId: crypto.randomUUID(),
      installationId: input.installationId,
      agentId: crypto.randomUUID(),
      runtimeProvider: "claude-code" as const,
      machineToken: `otmc_${crypto.randomUUID()}.${"a".repeat(43)}`,
    }));
    const result = await runComputerConnect({
      api: { exchangeComputerConnectCode },
      code: "one-time-code",
      home,
      manager,
      serverUrl: "https://opentag.example",
    });
    expect(exchangeComputerConnectCode).toHaveBeenCalledOnce();
    expect(exchangeComputerConnectCode.mock.calls[0]?.[0].clientVersion).toContain("+opentag-connect-runtime-v1");
    expect(result).toMatchObject({ runtimeProvider: "claude-code", serviceError: "service reload failed" });
    const stored = await readMachineCredentials(home);
    expect(stored?.computer.computerId).toBe(result.computerId);
    expect(JSON.stringify(stored)).not.toContain("runtimeProvider");
    expect(JSON.stringify(result)).not.toContain("otmc_");
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

  it("stops a repair command on a computer other than the one it restores, before using the code", async () => {
    const home = await temporaryHome();
    const computerId = crypto.randomUUID();
    await runComputerConnect({
      api: {
        exchangeComputerConnectCode: vi.fn(async (input: { installationId: string }) => ({
          computerId,
          installationId: input.installationId,
          machineToken: `otmc_${crypto.randomUUID()}.${"a".repeat(43)}`,
        })),
      },
      code: "valid-code",
      home,
      noStart: true,
      serverUrl: "https://opentag.example",
    });
    const exchange = vi.fn();

    await expect(
      runComputerConnect({
        api: { exchangeComputerConnectCode: exchange },
        code: "repair-code",
        home,
        noStart: true,
        serverUrl: "https://opentag.example",
        expectedComputerId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "COMPUTER_TARGET_MISMATCH" });
    expect(exchange).not.toHaveBeenCalled();

    // The named Computer, or a home whose identity is gone, proceeds.
    const same = vi.fn(async (input: { installationId: string }) => ({
      computerId,
      installationId: input.installationId,
      machineToken: `otmc_${crypto.randomUUID()}.${"b".repeat(43)}`,
    }));
    await runComputerConnect({
      api: { exchangeComputerConnectCode: same },
      code: "repair-code",
      home,
      noStart: true,
      serverUrl: "https://opentag.example",
      expectedComputerId: computerId,
    });
    expect(same).toHaveBeenCalledOnce();
    const fresh = await temporaryHome();
    const unknown = vi.fn(async (input: { installationId: string }) => ({
      computerId,
      installationId: input.installationId,
      machineToken: `otmc_${crypto.randomUUID()}.${"c".repeat(43)}`,
    }));
    await runComputerConnect({
      api: { exchangeComputerConnectCode: unknown },
      code: "repair-code",
      home: fresh,
      noStart: true,
      serverUrl: "https://opentag.example",
      expectedComputerId: computerId,
    });
    expect(unknown).toHaveBeenCalledOnce();
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

describe("idempotent computer connect", () => {
  function token() {
    return `otmc_${crypto.randomUUID()}.${"a".repeat(43)}`;
  }

  it("keeps local credentials and a healthy daemon untouched when the Server reports already connected", async () => {
    const home = await temporaryHome();
    const computerId = crypto.randomUUID();
    await runComputerConnect({
      api: {
        exchangeComputerConnectCode: vi.fn(async (input: { installationId: string }) => ({
          computerId,
          installationId: input.installationId,
          machineToken: token(),
          outcome: "created" as const,
        })),
      },
      code: "first-code",
      home,
      noStart: true,
      serverUrl: "https://opentag.example",
    });
    const credentialsBefore = await readMachineCredentials(home);
    const identityBefore = await readComputerIdentity(home);
    const manager = managerFixture();
    const exchangeComputerConnectCode = vi.fn(async (input: { installationId: string }) => ({
      computerId,
      installationId: input.installationId,
      outcome: "already_connected" as const,
    }));

    const result = await runComputerConnect({
      api: { exchangeComputerConnectCode },
      code: "second-code",
      home,
      manager,
      serverUrl: "https://opentag.example",
    });

    expect(result).toMatchObject({ outcome: "already_connected", computerId, service: { state: "active" } });
    // The same short success as any connect: whether anything changed is internal detail.
    expect(result.message).toBe(`Connected this computer (${hostname()}) to openTag.`);
    expect(exchangeComputerConnectCode.mock.calls[0]?.[0]).toMatchObject({
      installationId: identityBefore?.computerId,
      machineToken: credentialsBefore?.computer.machineToken,
    });
    expect(await readMachineCredentials(home)).toEqual(credentialsBefore);
    expect(manager.restart).not.toHaveBeenCalled();
    expect(manager.installAndStart).not.toHaveBeenCalled();
  });

  it("starts a stopped daemon when the Server reports already connected", async () => {
    const home = await temporaryHome();
    const manager = managerFixture();
    manager.status = vi.fn(async () => ({ ...(await managerFixture().status()), state: "inactive" as const }));
    await runComputerConnect({
      api: {
        exchangeComputerConnectCode: vi.fn(async (input: { installationId: string }) => ({
          computerId: crypto.randomUUID(),
          installationId: input.installationId,
          outcome: "already_connected" as const,
        })),
      },
      code: "code",
      home,
      manager,
      serverUrl: "https://opentag.example",
    });
    expect(manager.installAndStart).toHaveBeenCalledOnce();
    expect(await readMachineCredentials(home)).toBeUndefined();
  });

  it("describes repaired and created outcomes in plain language", async () => {
    for (const outcome of ["created", "repaired"] as const) {
      const home = await temporaryHome();
      const result = await runComputerConnect({
        api: {
          exchangeComputerConnectCode: vi.fn(async (input: { installationId: string }) => ({
            computerId: "11111111-1111-4111-8111-111111111111",
            installationId: input.installationId,
            machineToken: token(),
            outcome,
          })),
        },
        code: "code",
        home,
        noStart: true,
        serverUrl: "https://opentag.example",
      });
      expect(result.message).toBe(
        outcome === "created"
          ? `Connected this computer (${hostname()}) to openTag.`
          : `Connected this computer (${hostname()}) to openTag.`,
      );
      expect(result.message).not.toContain("11111111");
    }
  });

  it("prints one plain reason and a next step instead of an error code for connect failures", async () => {
    const cases = [
      [new client.OpenTagApiError("AUTH_CODE_EXPIRED", "credential", "expired", 401), /has expired/],
      [new client.OpenTagApiError("AUTH_CODE_CONSUMED", "credential", "used", 401), /already been used/],
      [
        new client.OpenTagApiError("COMPUTER_ACCOUNT_CONFLICT", "deterministic", "conflict", 409),
        /^This computer is linked to another openTag account\.$/,
      ],
      [
        new client.OpenTagApiError("SERVICE_UNAVAILABLE", "transient", "unavailable", undefined, undefined, {
          phase: "transport",
        }),
        /Could not reach the openTag server/,
      ],
      [Object.assign(new Error("EACCES: permission denied, mkdir '/x'"), { code: "EACCES" }), /permission denied/],
    ] as const;
    for (const [error, reason] of cases) {
      const home = await temporaryHome();
      const runSpy = vi.spyOn(computerCore, "runComputerConnect").mockRejectedValue(error);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await createProgram().parseAsync(["node", "opentag", "computer", "connect", "code", "--home", home]);
        const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        const [first, second] = output.split("\n");
        expect(first).toMatch(reason);
        expect(first).not.toMatch(/^[A-Z_]+:/);
        expect(second).toMatch(/^Next: /);
        expect(output).not.toMatch(/details|request|nothing was changed/i);
        expect(process.exitCode).not.toBe(0);
      } finally {
        stderr.mockRestore();
        runSpy.mockRestore();
        process.exitCode = undefined;
      }
    }
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
    refreshDefinition: vi.fn(async () => info),
    restart: vi.fn(async () => info),
    start: vi.fn(async () => info),
    status: vi.fn(async () => info),
    stop: vi.fn(async () => ({ ...info, state: "inactive" as const })),
    uninstall: vi.fn(async () => ({ ...info, state: "not-installed" as const })),
  };
}
