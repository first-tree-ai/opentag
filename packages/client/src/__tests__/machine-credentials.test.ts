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
import { computerIdentityPath, writeComputerIdentityAtomically } from "../runtime/computer-identity.js";
import { inspectLocalComputerConfiguration } from "../runtime/local-computer-configuration.js";

const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const INSTALLATION_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
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
    computerId: COMPUTER_ID,
    installationId: INSTALLATION_ID,
    machineToken: `otmc_${COMPUTER_ID}.secret`,
    serverUrl: SERVER_URL,
    ...overrides,
  };
}

async function seedUnsupported(home: string): Promise<void> {
  await storeBoundAccountComputer(credential(), home);
  await writeFile(machineCredentialsPath(home), JSON.stringify({ version: 99, computer: credential() }), "utf8");
}

describe("machine credentials", () => {
  it("writes a single Computer credential with its installation identity", async () => {
    const home = await newHome();
    await storeBoundAccountComputer(credential(), home);
    const stored = await readMachineCredentials(home);
    expect(stored).toEqual({ version: 3, computer: credential() });
    expect(JSON.parse(await readFile(machineCredentialsPath(home), "utf8"))).toEqual({
      version: 3,
      computer: credential(),
    });
  });

  it("rejects an unsupported credential version", async () => {
    const home = await newHome();
    await seedUnsupported(home);
    await expect(readMachineCredentials(home)).rejects.toThrow("unsupported format");
    expect(resolveBoundAccountComputer(undefined)).toEqual({ status: "disconnected" });
    expect(resolveBoundAccountComputer({ version: 3, computer: credential() })).toEqual({
      status: "bound",
      credential: credential(),
    });
  });

  it("rewrites an unsupported file only after an explicit fresh Computer binding", async () => {
    const home = await newHome();
    await seedUnsupported(home);
    await expect(readMachineCredentials(home)).rejects.toThrow("unsupported format");
    await storeBoundAccountComputer(credential(), home);
    expect(await readMachineCredentials(home)).toEqual({ version: 3, computer: credential() });
  });

  it("refuses to write a credential the reader would reject", async () => {
    const home = await newHome();
    await expect(
      writeMachineCredentialsAtomically(
        { version: 3, computer: { ...credential(), installationId: "not-a-uuid" } },
        home,
      ),
    ).rejects.toThrow("unusable OpenTag Computer credential");
  });

  it("reports a completely unconfigured Home without touching the filesystem", async () => {
    const home = join(await newHome(), "not-created");
    await expect(inspectLocalComputerConfiguration(home)).resolves.toEqual({
      identity: { status: "missing", detail: "Computer identity is not configured" },
      credentials: { status: "missing", detail: "No Computer credentials are configured" },
      binding: {
        status: "invalid",
        credentialCount: 0,
        detail: "A valid identity and Computer credential are required before their binding can be verified",
      },
    });
  });

  it("recognizes a canonical identity and matching credential binding", async () => {
    const home = await newHome();
    await writeComputerIdentityAtomically(home, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: SERVER_URL,
    });
    await storeBoundAccountComputer(credential(), home);

    await expect(inspectLocalComputerConfiguration(home)).resolves.toEqual({
      identity: {
        status: "valid",
        value: { version: 2, computerId: INSTALLATION_ID, serverUrl: SERVER_URL },
      },
      credentials: { status: "valid", value: { version: 3, computer: credential() } },
      binding: { status: "valid", credentialCount: 1, serverUrl: SERVER_URL },
    });
  });

  it("distinguishes missing, malformed, and non-canonical identity data", async () => {
    const missingIdentityHome = await newHome();
    await storeBoundAccountComputer(credential(), missingIdentityHome);
    await expect(inspectLocalComputerConfiguration(missingIdentityHome)).resolves.toMatchObject({
      identity: { status: "missing" },
      credentials: { status: "valid" },
      binding: { status: "invalid", credentialCount: 1 },
    });

    const malformedHome = await newHome();
    await writeComputerIdentityAtomically(malformedHome, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: SERVER_URL,
    });
    await storeBoundAccountComputer(credential(), malformedHome);
    await writeFile(computerIdentityPath(malformedHome), "{not-json", "utf8");
    await expect(inspectLocalComputerConfiguration(malformedHome)).resolves.toMatchObject({
      identity: { status: "invalid", detail: expect.stringContaining("Expected property name") },
      credentials: { status: "valid" },
      binding: { status: "invalid", credentialCount: 1 },
    });

    const nonCanonicalHome = await newHome();
    await writeComputerIdentityAtomically(nonCanonicalHome, {
      version: 2,
      computerId: COMPUTER_ID,
      serverUrl: "https://opentag.example/",
    });
    await storeBoundAccountComputer(credential(), nonCanonicalHome);
    await expect(inspectLocalComputerConfiguration(nonCanonicalHome)).resolves.toMatchObject({
      identity: { status: "invalid", detail: "Computer identity contains a non-canonical Server origin" },
      credentials: { status: "valid" },
      binding: { status: "invalid", credentialCount: 1 },
    });

    const invalidIdentityUrlHome = await newHome();
    await writeComputerIdentityAtomically(invalidIdentityUrlHome, {
      version: 2,
      computerId: COMPUTER_ID,
      serverUrl: "not-a-url",
    });
    await storeBoundAccountComputer(credential(), invalidIdentityUrlHome);
    await expect(inspectLocalComputerConfiguration(invalidIdentityUrlHome)).resolves.toMatchObject({
      identity: { status: "invalid", detail: "Computer identity contains an invalid Server origin" },
      credentials: { status: "valid" },
      binding: { status: "invalid", credentialCount: 1 },
    });
  });

  it("reports invalid origins, mismatched IDs, and mismatched Server origins", async () => {
    const invalidCredentialHome = await newHome();
    await writeComputerIdentityAtomically(invalidCredentialHome, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: SERVER_URL,
    });
    await writeFile(
      machineCredentialsPath(invalidCredentialHome),
      JSON.stringify({ version: 3, computer: credential({ serverUrl: "https://opentag.example/" }) }),
      "utf8",
    );
    await expect(inspectLocalComputerConfiguration(invalidCredentialHome)).resolves.toMatchObject({
      identity: { status: "valid" },
      credentials: { status: "invalid", detail: "A stored Computer credential contains a non-canonical Server origin" },
      binding: { status: "invalid", credentialCount: 0 },
    });

    const invalidCredentialUrlHome = await newHome();
    await writeComputerIdentityAtomically(invalidCredentialUrlHome, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: SERVER_URL,
    });
    await writeFile(
      machineCredentialsPath(invalidCredentialUrlHome),
      JSON.stringify({ version: 3, computer: credential({ serverUrl: "not-a-url" }) }),
      "utf8",
    );
    await expect(inspectLocalComputerConfiguration(invalidCredentialUrlHome)).resolves.toMatchObject({
      identity: { status: "valid" },
      credentials: { status: "invalid", detail: "A stored Computer credential contains an invalid Server origin" },
      binding: { status: "invalid", credentialCount: 0 },
    });

    const mismatchedIdHome = await newHome();
    await writeComputerIdentityAtomically(mismatchedIdHome, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: SERVER_URL,
    });
    await storeBoundAccountComputer(
      credential({ installationId: "85fe9af3-d1c6-472b-b78c-8a7ccf512751" }),
      mismatchedIdHome,
    );
    await expect(inspectLocalComputerConfiguration(mismatchedIdHome)).resolves.toMatchObject({
      identity: { status: "valid" },
      credentials: { status: "valid" },
      binding: {
        status: "invalid",
        credentialCount: 1,
        detail: "Stored Computer credentials do not belong to the local Computer identity",
      },
    });

    const mismatchedOriginHome = await newHome();
    await writeComputerIdentityAtomically(mismatchedOriginHome, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: SERVER_URL,
    });
    await storeBoundAccountComputer(credential({ serverUrl: "https://other.example" }), mismatchedOriginHome);
    await expect(inspectLocalComputerConfiguration(mismatchedOriginHome)).resolves.toMatchObject({
      identity: { status: "valid" },
      credentials: { status: "valid" },
      binding: {
        status: "invalid",
        credentialCount: 1,
        detail: "The Computer identity and stored credential refer to different Server origins",
      },
    });
  });

  it("fails closed when either strict reader rejects a corrupted credentials file", async () => {
    const home = await newHome();
    await writeComputerIdentityAtomically(home, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: SERVER_URL,
    });
    await writeFile(machineCredentialsPath(home), "{not-json", "utf8");
    await expect(inspectLocalComputerConfiguration(home)).resolves.toMatchObject({
      identity: { status: "valid" },
      credentials: { status: "invalid", detail: expect.stringContaining("Expected property name") },
      binding: { status: "invalid", credentialCount: 0 },
    });
  });
});
