import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MachineEnrollmentCredential,
  machineCredentialsPath,
  readMachineCredentials,
  resolveBoundAccountComputer,
  storeMachineEnrollmentCredential,
  writeMachineCredentialsAtomically,
} from "../auth/machine-credentials.js";

const WORKSPACE_ID = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const OTHER_WORKSPACE_ID = "b1c2d3e4-5f60-4a71-8b92-0c1d2e3f4a5b";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const ENROLLMENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const OTHER_ENROLLMENT_ID = "2b74b32f-07d8-4585-a2fb-5ebc1677b35d";
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

function credential(overrides: Partial<MachineEnrollmentCredential> = {}): MachineEnrollmentCredential {
  return {
    workspaceComputerId: ENROLLMENT_ID,
    computerId: COMPUTER_ID,
    machineToken: `otmc_${ENROLLMENT_ID}.secret`,
    serverUrl: SERVER_URL,
    ...overrides,
  };
}

/** Seeds the credentials file directly so entry shapes the current writer cannot produce are covered. */
async function seed(home: string, enrollments: readonly unknown[]): Promise<void> {
  await storeMachineEnrollmentCredential(credential(), home);
  await writeFile(machineCredentialsPath(home), JSON.stringify({ version: 1, enrollments }), "utf8");
}

describe("machine credentials", () => {
  it("round-trips an enrollment written with and without the legacy scope", async () => {
    const home = await newHome();

    await storeMachineEnrollmentCredential(credential({ workspaceId: WORKSPACE_ID }), home);
    expect((await readMachineCredentials(home))?.enrollments).toEqual([credential({ workspaceId: WORKSPACE_ID })]);

    await storeMachineEnrollmentCredential(credential(), home);
    const stored = await readMachineCredentials(home);
    expect(stored?.enrollments).toEqual([credential()]);
    expect(stored?.enrollments[0]).not.toHaveProperty("workspaceId");
  });

  it("reads a file holding both pre-cutover and post-cutover entries", async () => {
    const home = await newHome();
    await seed(home, [
      { ...credential({ workspaceId: WORKSPACE_ID }) },
      { ...credential({ workspaceComputerId: OTHER_ENROLLMENT_ID }) },
    ]);

    const stored = await readMachineCredentials(home);
    expect(stored?.enrollments.map((entry) => entry.workspaceComputerId)).toEqual([ENROLLMENT_ID, OTHER_ENROLLMENT_ID]);
    expect(stored?.enrollments[0]?.workspaceId).toBe(WORKSPACE_ID);
    expect(stored?.enrollments[1]?.workspaceId).toBeUndefined();
  });

  it("drops an unusable entry instead of stranding every other enrollment", async () => {
    const home = await newHome();
    await seed(home, [
      { workspaceComputerId: "not-a-uuid", computerId: COMPUTER_ID, machineToken: "otmc_x.y", serverUrl: SERVER_URL },
      { ...credential(), machineToken: "bearer-not-a-machine-token" },
      { ...credential({ workspaceId: "also-not-a-uuid" }) },
      { ...credential({ workspaceComputerId: OTHER_ENROLLMENT_ID }) },
    ]);

    const stored = await readMachineCredentials(home);
    expect(stored?.enrollments.map((entry) => entry.workspaceComputerId)).toEqual([OTHER_ENROLLMENT_ID]);
  });

  it("still rejects a file whose envelope is not credentials at all", async () => {
    const home = await newHome();
    await storeMachineEnrollmentCredential(credential(), home);
    await writeFile(machineCredentialsPath(home), JSON.stringify({ version: 9, enrollments: [] }), "utf8");

    await expect(readMachineCredentials(home)).rejects.toThrow("credentials file is invalid");
  });

  it("replaces the credential it supersedes rather than accumulating", async () => {
    const home = await newHome();
    await storeMachineEnrollmentCredential(credential({ workspaceId: WORKSPACE_ID }), home);

    // Same enrollment, rotated token.
    await storeMachineEnrollmentCredential(
      credential({ workspaceId: WORKSPACE_ID, machineToken: `otmc_${ENROLLMENT_ID}.rotated` }),
      home,
    );
    expect((await readMachineCredentials(home))?.enrollments).toEqual([
      credential({ workspaceId: WORKSPACE_ID, machineToken: `otmc_${ENROLLMENT_ID}.rotated` }),
    ]);

    // Re-enrolment into the same legacy scope under a new enrollment id.
    await storeMachineEnrollmentCredential(
      credential({ workspaceComputerId: OTHER_ENROLLMENT_ID, workspaceId: WORKSPACE_ID }),
      home,
    );
    expect((await readMachineCredentials(home))?.enrollments).toEqual([
      credential({ workspaceComputerId: OTHER_ENROLLMENT_ID, workspaceId: WORKSPACE_ID }),
    ]);
  });

  /**
   * The reader drops entries it cannot use, so a writer that skipped validation could resolve happily
   * while leaving bytes the very next read discards. These pin the write side to the stricter policy.
   */
  it("refuses to write an entry its own reader would discard", async () => {
    const home = await newHome();
    await storeMachineEnrollmentCredential(credential(), home);

    await expect(
      writeMachineCredentialsAtomically(
        { version: 1, enrollments: [{ workspaceComputerId: "not-a-uuid" } as never] },
        home,
      ),
    ).rejects.toThrow("Refusing to write an unusable OpenTag Computer credential (entry 0)");

    // The rejected write must not have touched the credential already on disk.
    expect((await readMachineCredentials(home))?.enrollments).toEqual([credential()]);
  });

  it("refuses to write a duplicate enrollment the reader would collapse", async () => {
    const home = await newHome();

    await expect(
      writeMachineCredentialsAtomically({ version: 1, enrollments: [credential(), credential()] }, home),
    ).rejects.toThrow("Refusing to write a duplicate OpenTag Computer enrollment (entry 1)");
    expect(await readMachineCredentials(home)).toBeUndefined();
  });

  it("persists exactly what the reader returns", async () => {
    const home = await newHome();
    await writeMachineCredentialsAtomically(
      {
        version: 1,
        enrollments: [{ ...credential({ workspaceId: WORKSPACE_ID }), stale: "dropped" } as never],
      },
      home,
    );

    const onDisk = JSON.parse(await readFile(machineCredentialsPath(home), "utf8"));
    expect(onDisk).toEqual(await readMachineCredentials(home));
    expect(onDisk.enrollments[0]).not.toHaveProperty("stale");
  });

  it("binds the home to the latest Account Computer instead of accumulating enrollments", async () => {
    const home = await newHome();
    await storeMachineEnrollmentCredential(credential({ workspaceId: WORKSPACE_ID }), home);
    await storeMachineEnrollmentCredential(
      credential({ workspaceComputerId: OTHER_ENROLLMENT_ID, workspaceId: OTHER_WORKSPACE_ID }),
      home,
    );

    const stored = await readMachineCredentials(home);
    expect(stored?.enrollments).toEqual([
      credential({ workspaceComputerId: OTHER_ENROLLMENT_ID, workspaceId: OTHER_WORKSPACE_ID }),
    ]);
    expect(resolveBoundAccountComputer(stored)).toEqual({
      status: "bound",
      credential: credential({ workspaceComputerId: OTHER_ENROLLMENT_ID, workspaceId: OTHER_WORKSPACE_ID }),
    });
  });

  it("upgrades exactly one legacy enrollment and fails closed when multiple remain", async () => {
    expect(resolveBoundAccountComputer(undefined)).toEqual({ status: "disconnected" });
    expect(resolveBoundAccountComputer({ version: 1, enrollments: [] })).toEqual({ status: "disconnected" });
    expect(resolveBoundAccountComputer({ version: 1, enrollments: [credential()] })).toEqual({
      status: "bound",
      credential: credential(),
    });
    expect(
      resolveBoundAccountComputer({
        version: 1,
        enrollments: [credential(), credential({ workspaceComputerId: OTHER_ENROLLMENT_ID })],
      }),
    ).toEqual({ status: "ambiguous" });
  });
});
