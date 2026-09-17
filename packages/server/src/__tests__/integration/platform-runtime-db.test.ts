import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RUNTIME_CAPABILITY } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { parseServerConfig } from "../../config.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { createPlatformRuntime } from "../../platform-runtime.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import type {
  TrustedCloudControlAuthority,
  TrustedCloudControlFacts,
  TrustedCloudControlIdentity,
} from "../../runtime-credentials/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { CloudRuntimeFence, cloudInstanceIdFor } from "../../services/sandboxes/cloud-runtime-fence.js";
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

/**
 * Native Runner Cloud credential authority fixture: a Cloud Session with a ready allocation and an
 * accepted (unfinished) delivery, plus the exact bootstrap scope the Runner would attach with.
 */
async function nativeRunnerFixture() {
  const account = await admin();
  const { computer, installationId } = await cloudComputer(account.userId);
  const client = createDatabaseClient(database.databaseUrl);
  try {
    const agentId = randomUUID();
    const bindingId = randomUUID();
    const sessionId = randomUUID();
    const sandboxId = randomUUID();
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    const turnId = randomUUID();
    const resourceName = `projects/fixture/locations/us-west1/instances/ots-s-${sandboxId.slice(0, 8)}-1`;
    const resourceUid = `uid-${sandboxId.slice(0, 8)}`;
    await client.database.insert(agents).values({
      id: agentId,
      createdByUserId: account.userId,
      computerId: computer.id,
      name: `e4-${agentId.slice(0, 8)}`,
      displayName: "E4",
      runtimeProvider: "pi",
    });
    await client.database.insert(imBindings).values({
      id: bindingId,
      agentId,
      provider: "feishu",
      status: "active",
      externalAppId: `app-${bindingId.slice(0, 8)}`,
      externalBotId: "bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "unit-only-unused",
      activatedAt: new Date(),
    });
    await client.database.insert(sessions).values({
      id: sessionId,
      imBindingId: bindingId,
      channelId: "unit-channel",
      conversationKind: "channel",
      kind: "channel",
    });
    await client.database.insert(sessionPlacements).values({ sessionId, computerId: computer.id, generation: 1 });
    await client.database.insert(sandboxes).values({
      id: sandboxId,
      sessionId,
      storageUri: "gs://fixture-bucket/sandboxes",
      lifecycle: "ready",
      environmentGeneration: 1,
      currentResourceName: resourceName,
      currentResourceUid: resourceUid,
    });
    await client.database.insert(imMessages).values({
      id: messageId,
      imBindingId: bindingId,
      channelId: "unit-channel",
      externalMessageId: `ext-${messageId.slice(0, 8)}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "unit-user",
      content: { version: 1, fallbackText: "hello", blocks: [], truncated: false },
      providerContext: { provider: "feishu" },
      occurredAt: new Date(),
    });
    const scope = { sandboxId, sessionId, environmentGeneration: 1, resourceName };
    const instanceId = cloudInstanceIdFor(scope);
    await client.database.insert(imMessageDeliveries).values({
      id: deliveryId,
      messageId,
      sessionId,
      attention: "direct",
      state: "accepted",
      inputHash: "input-hash",
      turnId,
      reportOwnerInstanceId: instanceId,
      placementGeneration: 1,
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return {
      agentId,
      bindingId,
      computerId: computer.id,
      deliveryId,
      installationId,
      resourceUid,
      scope,
      sessionId,
      turnId,
    };
  } finally {
    await client.sql.end();
  }
}

type NativeRunnerFixture = Awaited<ReturnType<typeof nativeRunnerFixture>>;

function runnerOpenFrame(fixture: NativeRunnerFixture) {
  return {
    type: "runtime:execution:open" as const,
    requestId: randomUUID(),
    sessionId: fixture.sessionId,
    agentId: fixture.agentId,
    placementGeneration: 1,
    runId: randomUUID(),
    source: { kind: "delivery" as const, deliveryId: fixture.deliveryId, turnId: fixture.turnId },
    sandbox: {
      sandboxId: fixture.scope.sandboxId,
      resourceUid: fixture.resourceUid,
      environmentGeneration: 1,
    },
  };
}

function runnerContext(fixture: NativeRunnerFixture, connection: { connectionId: string; instanceId: string }) {
  return {
    computerId: fixture.computerId,
    installationId: fixture.installationId,
    instanceId: connection.instanceId,
    connectionId: connection.connectionId,
    negotiatedCapabilities: {
      [RUNTIME_CAPABILITY.runtimeCredential]: 1,
      [RUNTIME_CAPABILITY.providerProxy]: 1,
    },
    signal: new AbortController().signal,
  };
}

function runnerAcquireFrame(fixture: NativeRunnerFixture, executionId: string) {
  return {
    type: "runtime:credential:acquire" as const,
    requestId: randomUUID(),
    executionId,
    provider: "feishu" as const,
    bindingId: fixture.bindingId,
  };
}

it("admits native Runner Cloud credential authority through createPlatformRuntime and fails closed without it", async () => {
  const fixture = await nativeRunnerFixture();
  const client = createDatabaseClient(database.databaseUrl);
  const fence = new CloudRuntimeFence();
  const runtime = await createPlatformRuntime({
    config: config(),
    database: client.database,
    cipher: new ApplicationCipher(Buffer.alloc(32, 9)),
    registry: new ConnectionRegistry(),
    custody: new PostgresRuntimeCustodyStore(client.database),
    machineAuth: localAuth(),
    cloudRuntimeFence: fence,
  });
  try {
    const connection = fence.attach({
      computerId: fixture.computerId,
      installationId: fixture.installationId,
      scope: fixture.scope,
    });
    const context = runnerContext(fixture, connection);
    const opened = await runtime.credentials.owner.handle(runnerOpenFrame(fixture), context);
    expect(opened).toMatchObject({ status: "succeeded" });
    const executionId = (opened as { executionId: string }).executionId;

    // The composed sweep keeps the live native Cloud execution...
    runtime.credentials.owner.sweepNow();
    expect(runtime.credentials.executions.get(executionId)).toBeDefined();
    // ...and the broker admits a credential operation through the fence authority alone.
    const acquired = await runtime.credentials.owner.handle(runnerAcquireFrame(fixture, executionId), context);
    expect(acquired).toMatchObject({ status: "succeeded", provider: "feishu" });

    // Losing the native connection revokes execution authority at the next sweep, fail closed.
    fence.detach(connection.connectionId);
    runtime.credentials.owner.sweepNow();
    expect(runtime.credentials.executions.get(executionId)).toBeUndefined();
    const denied = await runtime.credentials.owner.handle(runnerAcquireFrame(fixture, executionId), context);
    expect(denied).toMatchObject({ status: "rejected", code: "execution_unknown" });

    // A composition without the native fence never admits the Cloud execution.
    const noFence = await createPlatformRuntime({
      config: config(),
      database: client.database,
      cipher: new ApplicationCipher(Buffer.alloc(32, 9)),
      registry: new ConnectionRegistry(),
      custody: new PostgresRuntimeCustodyStore(client.database),
      machineAuth: localAuth(),
    });
    try {
      const rejected = await noFence.credentials.owner.handle(runnerOpenFrame(fixture), context);
      expect(rejected).toMatchObject({ status: "rejected" });
    } finally {
      await noFence.close();
    }
  } finally {
    await runtime.close();
    await client.sql.end();
  }

  // Native Runner authority obeys config.cloudIdentities.enabled: disabled means fail closed even
  // with the fence attached and a live connection record.
  const disabledClient = createDatabaseClient(database.databaseUrl);
  const disabledFence = new CloudRuntimeFence();
  const disabledRuntime = await createPlatformRuntime({
    config: config({ OPENTAG_CLOUD_IDENTITIES_ENABLED: "false" }),
    database: disabledClient.database,
    cipher: new ApplicationCipher(Buffer.alloc(32, 9)),
    registry: new ConnectionRegistry(),
    custody: new PostgresRuntimeCustodyStore(disabledClient.database),
    machineAuth: localAuth(),
    cloudRuntimeFence: disabledFence,
  });
  try {
    const connection = disabledFence.attach({
      computerId: fixture.computerId,
      installationId: fixture.installationId,
      scope: fixture.scope,
    });
    const rejected = await disabledRuntime.credentials.owner.handle(
      runnerOpenFrame(fixture),
      runnerContext(fixture, connection),
    );
    expect(rejected).toMatchObject({ status: "rejected", code: "execution_authority_denied" });
  } finally {
    await disabledRuntime.close();
    await disabledClient.sql.end();
  }
});
