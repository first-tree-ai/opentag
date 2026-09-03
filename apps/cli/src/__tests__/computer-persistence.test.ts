import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as client from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { runComputerConnect } from "../core/computer/connect.js";
import { repairLocalComputerConnection } from "../core/computer/repair-local.js";
import type { DaemonServiceManager } from "../core/daemon/service/index.js";

const homes: string[] = [];
const previousExitCode = process.exitCode;
const serverUrl = "https://opentag.example";
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function temporaryHome() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "opentag-persistence-")));
  homes.push(home);
  return home;
}

function credentialFixture(): client.MachineComputerCredential {
  return {
    computerId: crypto.randomUUID(),
    installationId: crypto.randomUUID(),
    machineToken: `otmc_${crypto.randomUUID()}.${"a".repeat(43)}`,
    serverUrl,
  };
}

function identityFor(credential: client.MachineComputerCredential) {
  return { version: 2 as const, computerId: credential.installationId, serverUrl: credential.serverUrl };
}

function managerFixture(): DaemonServiceManager {
  const service = {
    currentHome: "/tmp/opentag",
    definitionPath: "/tmp/opentag.service",
    logHint: "logs",
    platform: "systemd" as const,
    serviceId: "opentag",
    state: "inactive" as const,
  };
  return {
    preflight: vi.fn(),
    status: vi.fn(async () => service),
    start: vi.fn(async () => service),
    stop: vi.fn(async () => service),
    restart: vi.fn(async () => service),
    refreshDefinition: vi.fn(async () => service),
    installAndStart: vi.fn(async () => service),
    uninstall: vi.fn(async () => service),
  };
}

describe.each([false, true])("post-exchange persistence (existing binding: %s)", (existing) => {
  it.each([
    ["credentials", false],
    ["credentials", true],
    ["identity", false],
    ["identity", true],
  ] as const)(
    "recovers %s failure (write committed before error: %s) without exchanging again",
    async (stage, committed) => {
      const home = await temporaryHome();
      const oldCredential = credentialFixture();
      if (existing) {
        await client.storeBoundAccountComputer(oldCredential, home);
        await client.writeComputerIdentityAtomically(home, identityFor(oldCredential));
      }
      const beforeIdentity = await client.readComputerIdentity(home);
      const beforeCredential = await client.readMachineCredentials(home);
      const nextCredential = credentialFixture();
      const exchange = vi.fn(async (input: { installationId: string }) => {
        nextCredential.installationId = input.installationId;
        return { ...nextCredential, agentId: crypto.randomUUID(), runtimeProvider: "claude-code" as const };
      });
      const manager = managerFixture();
      const writeCredential = client.storeBoundAccountComputer;
      const writeIdentity = client.writeComputerIdentityAtomically;
      const failure = new Error(`write failed with machineToken=${nextCredential.machineToken}`);
      // A durable file write may throw after rename (chmod or directory fsync). Pin both sides
      // of that boundary without relying on a specific host filesystem's failure behavior.
      const fault =
        stage === "credentials"
          ? vi.spyOn(client, "storeBoundAccountComputer").mockImplementation(async (...args) => {
              if (committed) await writeCredential(...args);
              throw failure;
            })
          : vi.spyOn(client, "writeComputerIdentityAtomically").mockImplementation(async (...args) => {
              if (committed) await writeIdentity(...args);
              throw failure;
            });
      const result = await runComputerConnect({
        api: { exchangeComputerConnectCode: exchange },
        code: "one-time-code",
        home,
        manager,
        serverUrl,
      });
      fault.mockRestore();
      expect(result).toMatchObject({
        computerId: nextCredential.computerId,
        runtimeProvider: "claude-code",
        persistenceError: { stage, installationId: nextCredential.installationId },
      });
      expect(result.message).toContain("on the Server; local persistence is incomplete");
      expect(JSON.stringify(result)).not.toContain(nextCredential.machineToken);
      expect(JSON.stringify(result)).not.toContain(oldCredential.machineToken);
      expect(exchange).toHaveBeenCalledOnce();
      expect(manager.installAndStart).not.toHaveBeenCalled();
      expect(manager.restart).not.toHaveBeenCalled();
      const persisted = await client.readMachineCredentials(home);
      if (stage === "credentials" && !committed) {
        expect(persisted).toEqual(beforeCredential);
        expect(await client.readComputerIdentity(home)).toEqual(beforeIdentity);
        await expect(
          repairLocalComputerConnection({ home, installationId: nextCredential.installationId }),
        ).rejects.toMatchObject({ code: "COMPUTER_CREDENTIAL_UNAVAILABLE", retryability: "never" });
        expect(await client.readMachineCredentials(home)).toEqual(beforeCredential);
        expect(await client.readComputerIdentity(home)).toEqual(beforeIdentity);
      } else {
        expect(persisted?.computer).toEqual(nextCredential);
        expect(await client.readComputerIdentity(home)).toEqual(
          stage === "identity" && committed ? identityFor(nextCredential) : beforeIdentity,
        );
        // Recovery is idempotent, does not require the consumed code, and does not start a daemon.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(
            repairLocalComputerConnection({ home, installationId: nextCredential.installationId }),
          ).resolves.toMatchObject({ localPersistenceReady: true, installationId: nextCredential.installationId });
          expect(await client.readComputerIdentity(home)).toEqual(identityFor(nextCredential));
          expect((await client.readMachineCredentials(home))?.computer).toEqual(nextCredential);
        }
        expect(exchange).toHaveBeenCalledOnce();
        expect(manager.installAndStart).not.toHaveBeenCalled();
      }
    },
  );
});

describe("computer repair-local command", () => {
  it.each(["credentials", "identity"] as const)(
    "does not expose secrets when the %s repair write fails",
    async (stage) => {
      const home = await temporaryHome();
      const credential = credentialFixture();
      await client.storeBoundAccountComputer(credential, home);
      const failure = new Error(`write failed ${credential.machineToken}`);
      if (stage === "credentials") vi.spyOn(client, "storeBoundAccountComputer").mockRejectedValue(failure);
      else vi.spyOn(client, "writeComputerIdentityAtomically").mockRejectedValue(failure);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await createProgram().parseAsync([
        "node",
        "opentag",
        "computer",
        "repair-local",
        "--installation-id",
        credential.installationId,
        "--home",
        home,
        "--json",
      ]);
      const text = String(stderr.mock.calls[0]?.[0]);
      expect(JSON.parse(text)).toMatchObject({
        ok: false,
        error: { code: "COMPUTER_LOCAL_PERSISTENCE_FAILED", retryability: "never" },
      });
      expect(text).not.toContain(credential.machineToken);
      expect(text).toContain("retry repair-local");
      expect(text).toContain("Do not reuse");
    },
  );
  it("repairs saved credentials in human/JSON without an exchange or readiness claim", async () => {
    const home = await temporaryHome();
    const credential = credentialFixture();
    await client.storeBoundAccountComputer(credential, home);
    const exchange = vi.spyOn(client.OpenTagApi.prototype, "exchangeComputerConnectCode");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const args = [
      "node",
      "opentag",
      "computer",
      "repair-local",
      "--installation-id",
      credential.installationId,
      "--home",
      home,
    ];
    await createProgram().parseAsync([...args, "--json"]);
    const json = String(stdout.mock.calls[0]?.[0]);
    expect(JSON.parse(json)).toMatchObject({
      ok: true,
      result: { localPersistenceReady: true, computerId: credential.computerId },
    });
    expect(json).not.toContain(credential.machineToken);
    expect(json).not.toContain('"localReady"');
    expect(await client.readComputerIdentity(home)).toEqual(identityFor(credential));
    await createProgram().parseAsync(args);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("No daemon was started"));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("daemon status"));
    expect(stderr).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("fails closed on unreadable credentials and invalid installation input", async () => {
    const home = await temporaryHome();
    const credential = credentialFixture();
    const reader = vi.spyOn(client, "readMachineCredentialsStrict").mockRejectedValue(new Error("unreadable"));
    const writer = vi.spyOn(client, "storeBoundAccountComputer");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const args = ["node", "opentag", "computer", "repair-local", "--home", home, "--json", "--installation-id"];
    await createProgram().parseAsync([...args, credential.installationId]);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: "COMPUTER_CREDENTIAL_UNAVAILABLE", message: expect.stringContaining("NEW connect/repair code") },
    });
    await createProgram().parseAsync([...args, "not-an-installation"]);
    expect(process.exitCode).toBe(2);
    expect(reader).toHaveBeenCalledOnce();
    expect(writer).not.toHaveBeenCalled();
  });
});
