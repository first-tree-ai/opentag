import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MachineComputerCredential,
  machineCredentialsPath,
  readMachineCredentials,
  resolveBoundAccountComputer,
  storeBoundAccountComputer,
  writeMachineCredentialsAtomically,
} from "../auth/machine-credentials.js";

const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const ENROLLMENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const SERVER_URL = "https://opentag.example";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-machine-credentials-"));
  homes.push(home);
  return home;
}

function credential(overrides: Partial<MachineComputerCredential> = {}): MachineComputerCredential {
  return {
    workspaceComputerId: ENROLLMENT_ID,
    computerId: COMPUTER_ID,
    machineToken: `otmc_${ENROLLMENT_ID}.secret`,
    serverUrl: SERVER_URL,
    ...overrides,
  };
}

async function seedLegacy(home: string, entries: readonly unknown[]): Promise<void> {
  await storeBoundAccountComputer(credential(), home);
  await writeFile(machineCredentialsPath(home), JSON.stringify({ version: 1, enrollments: entries }), "utf8");
}

describe("machine credentials", () => {
  it("writes a single Computer credential without an enrollment array or Workspace alias", async () => {
    const home = await newHome();
    await storeBoundAccountComputer(credential(), home);
    const stored = await readMachineCredentials(home);
    expect(stored).toEqual({ version: 2, computer: credential() });
    expect(stored).not.toHaveProperty("enrollments");
    expect(JSON.parse(await readFile(machineCredentialsPath(home), "utf8"))).not.toHaveProperty("workspaceId");
  });

  it("rejects the retired enrollment-array format", async () => {
    const home = await newHome();
    await seedLegacy(home, [credential()]);
    await expect(readMachineCredentials(home)).rejects.toThrow("unsupported format");
    expect(resolveBoundAccountComputer(undefined)).toEqual({ status: "disconnected" });
    expect(resolveBoundAccountComputer({ version: 2, computer: credential() })).toEqual({
      status: "bound",
      credential: credential(),
    });
  });

  it("rewrites a retired file only after an explicit fresh Computer binding", async () => {
    const home = await newHome();
    await seedLegacy(home, [{ ...credential(), workspaceId: "d3fda800-7ce2-4338-aae8-3d2120401ed6" }]);
    await expect(readMachineCredentials(home)).rejects.toThrow("unsupported format");
    await storeBoundAccountComputer(credential(), home);
    expect(await readMachineCredentials(home)).toEqual({ version: 2, computer: credential() });
  });

  it("refuses to write a credential the reader would reject", async () => {
    const home = await newHome();
    await expect(
      writeMachineCredentialsAtomically(
        { version: 2, computer: { ...credential(), workspaceComputerId: "not-a-uuid" } },
        home,
      ),
    ).rejects.toThrow("unusable OpenTag Computer credential");
  });
});
