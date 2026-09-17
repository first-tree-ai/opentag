import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { parseServerConfig } from "../../config.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import { createPlatformRuntime } from "../../platform-runtime.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import type {
  TrustedCloudControlAuthority,
  TrustedCloudControlFacts,
  TrustedCloudControlIdentity,
} from "../../runtime-credentials/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let database: MigratedTestDatabase;
beforeAll(async () => {
  database = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => database.stop());
beforeEach(async () => database.reset());

/**
 * Test double for the trusted Cloud control port. It stands in for the future Computer/Cloud
 * orchestration: the runtime consumes verification and liveness only, and revocation is just the
 * identity leaving the active set — the runtime never persists or re-issues credentials itself.
 */
class FixtureCloudControlAuthority implements TrustedCloudControlAuthority {
  readonly #records = new Map<string, TrustedCloudControlFacts>();
  readonly #active = new Set<string>();

  issue(input: { computerId: string; installationId: string }): TrustedCloudControlFacts & { credential: string } {
    const facts = { credentialId: randomUUID(), computerId: input.computerId, installationId: input.installationId };
    const secret = randomUUID();
    this.#records.set(secret, facts);
    this.#active.add(facts.credentialId);
    return { ...facts, credential: `otcloud-control.${secret}` };
  }

  deactivate(credentialId: string): void {
    this.#active.delete(credentialId);
  }

  async verifyControlCredential(credential: string): Promise<TrustedCloudControlIdentity | undefined> {
    const facts = this.#records.get(credential);
    if (!facts || !this.#active.has(facts.credentialId)) return undefined;
    return facts;
  }

  async isActive(identity: TrustedCloudControlFacts): Promise<boolean> {
    for (const facts of this.#records.values()) {
      if (
        facts.credentialId === identity.credentialId &&
        facts.computerId === identity.computerId &&
        facts.installationId === identity.installationId
      )
        return this.#active.has(identity.credentialId);
    }
    return false;
  }
}

function localAuth() {
  return {
    verifyMachineToken: vi.fn(async () => ({
      credentialId: randomUUID(),
      computerId: randomUUID(),
      installationId: randomUUID(),
    })),
  };
}

function config(overrides: Record<string, string> = {}) {
  return parseServerConfig({
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters",
    OPENTAG_DATABASE_URL: database.databaseUrl,
    OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    OPENTAG_JWT_SECRET: "test-jwt-secret-at-least-32-characters",
    OPENTAG_PUBLIC_URL: "http://localhost:8000",
    OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
    OPENTAG_CLOUD_STORAGE_BASE: "gs://fixture-bucket/control",
    OPENTAG_CLOUD_RUNNER_VERSION: "1.0.0",
    ...overrides,
  });
}

async function cloudComputer(ownerAccountId: string, kind: "local" | "cloud" = "cloud") {
  const installationId = randomUUID();
  const client = createDatabaseClient(database.databaseUrl);
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId,
      currentInstallationId: installationId,
      kind,
      displayName: "Cloud",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    })
    .returning();
  await client.sql.end();
  if (!computer) throw new Error("Missing fixture Computer");
  return { computer, installationId };
}

async function admin() {
  return bootstrapInitialAdmin(createDatabaseClient(database.databaseUrl).database, {
    displayName: "Test",
    email: "platform@example.com",
  });
}

it("binds an explicitly injected trusted Cloud verifier to the existing logical Cloud Computer and honors live revocation", async () => {
  const client = createDatabaseClient(database.databaseUrl);
  const authority = new FixtureCloudControlAuthority();
  const runtime = await createPlatformRuntime({
    config: config(),
    database: client.database,
    cipher: new ApplicationCipher(Buffer.alloc(32, 9)),
    registry: new ConnectionRegistry(),
    custody: new PostgresRuntimeCustodyStore(client.database),
    machineAuth: localAuth(),
    cloudControl: authority,
  });
  try {
    const account = await admin();
    const { computer, installationId } = await cloudComputer(account.userId);
    const issued = authority.issue({ computerId: computer.id, installationId });
    const identity = await runtime.auth.verifyMachineToken(issued.credential);
    expect(identity).toEqual({
      credentialId: issued.credentialId,
      computerId: computer.id,
      installationId,
      kind: "cloud",
    });
    await expect(runtime.assertCloudControlCredential(identity)).resolves.toBeUndefined();

    // Live revocation: once the trusted authority deactivates the credential, both authentication
    // and the credential activity check fail closed. No copied credential survives revocation.
    authority.deactivate(issued.credentialId);
    await expect(runtime.auth.verifyMachineToken(issued.credential)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    await expect(runtime.assertCloudControlCredential(identity)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });

    await runtime.auth.verifyMachineToken("local-fixture");
  } finally {
    await runtime.close();
    await client.sql.end();
  }
});

it("rejects all Cloud control authentication and activity when no trusted verifier is injected", async () => {
  const client = createDatabaseClient(database.databaseUrl);
  const machineAuth = localAuth();
  const runtime = await createPlatformRuntime({
    config: config(),
    database: client.database,
    cipher: new ApplicationCipher(Buffer.alloc(32, 9)),
    registry: new ConnectionRegistry(),
    custody: new PostgresRuntimeCustodyStore(client.database),
    machineAuth,
  });
  try {
    await expect(runtime.auth.verifyMachineToken("otcloud-control.anything")).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    // A Cloud control credential never falls back to the Local machine-token path.
    expect(machineAuth.verifyMachineToken).not.toHaveBeenCalled();
    await expect(
      runtime.assertCloudControlCredential({
        credentialId: randomUUID(),
        computerId: randomUUID(),
        installationId: randomUUID(),
        kind: "cloud",
      }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });

    await runtime.auth.verifyMachineToken("local-fixture");
    expect(machineAuth.verifyMachineToken).toHaveBeenCalledWith("local-fixture");
  } finally {
    await runtime.close();
    await client.sql.end();
  }
});

it("rejects a Cloud credential whose Computer row is Local and a mismatched installation identity", async () => {
  const client = createDatabaseClient(database.databaseUrl);
  const authority = new FixtureCloudControlAuthority();
  const runtime = await createPlatformRuntime({
    config: config(),
    database: client.database,
    cipher: new ApplicationCipher(Buffer.alloc(32, 9)),
    registry: new ConnectionRegistry(),
    custody: new PostgresRuntimeCustodyStore(client.database),
    machineAuth: localAuth(),
    cloudControl: authority,
  });
  try {
    const account = await admin();
    const local = await cloudComputer(account.userId, "local");
    const forLocalRow = authority.issue({
      computerId: local.computer.id,
      installationId: local.installationId,
    });
    // The current DB identity wins: a Local-kind row never accepts a Cloud control credential.
    await expect(runtime.auth.verifyMachineToken(forLocalRow.credential)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });

    const cloud = await cloudComputer(account.userId);
    const stale = authority.issue({ computerId: cloud.computer.id, installationId: randomUUID() });
    await expect(runtime.auth.verifyMachineToken(stale.credential)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
  } finally {
    await runtime.close();
    await client.sql.end();
  }
});

it("composes with no persistent control directory and writes nothing to the filesystem while GitHub is disabled", async () => {
  const gitWorkspaceRoots = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("opentag-git-"));
  const before = await gitWorkspaceRoots();
  const client = createDatabaseClient(database.databaseUrl);
  // No OPENTAG_RUNTIME_CONTROL_DIRECTORY exists anywhere in configuration: PostgreSQL plus
  // bounded memory are the whole runtime state.
  expect("runtimeControlDirectory" in config()).toBe(false);
  const runtime = await createPlatformRuntime({
    config: config(),
    database: client.database,
    cipher: new ApplicationCipher(Buffer.alloc(32, 9)),
    registry: new ConnectionRegistry(),
    custody: new PostgresRuntimeCustodyStore(client.database),
    machineAuth: localAuth(),
  });
  await runtime.close();
  await client.sql.end();
  expect(await gitWorkspaceRoots()).toEqual(before);
});
