import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { parseServerConfig } from "../../config.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import { createPlatformRuntime } from "../../platform-runtime.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let database: MigratedTestDatabase;
beforeAll(async () => {
  database = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => database.stop());
beforeEach(async () => database.reset());

it("composes persisted Cloud control auth, fences replacements, and closes the active revoked connection", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "platform-runtime-"));
  const client = createDatabaseClient(database.databaseUrl);
  const registry = new ConnectionRegistry();
  const localAuth = {
    verifyMachineToken: vi.fn(async () => ({
      credentialId: randomUUID(),
      computerId: randomUUID(),
      installationId: randomUUID(),
    })),
  };
  const config = parseServerConfig({
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters",
    OPENTAG_DATABASE_URL: database.databaseUrl,
    OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    OPENTAG_JWT_SECRET: "test-jwt-secret-at-least-32-characters",
    OPENTAG_PUBLIC_URL: "http://localhost:8000",
    OPENTAG_RUNTIME_CONTROL_DIRECTORY: root,
    OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
    OPENTAG_CLOUD_STORAGE_BASE: "gs://fixture-bucket/control",
    OPENTAG_CLOUD_RUNNER_VERSION: "1.0.0",
  });
  const runtime = await createPlatformRuntime({
    config,
    database: client.database,
    cipher: new ApplicationCipher(Buffer.alloc(32, 9)),
    registry,
    custody: new PostgresRuntimeCustodyStore(client.database),
    machineAuth: localAuth,
  });
  try {
    const account = await bootstrapInitialAdmin(client.database, {
      displayName: "Test",
      email: "platform@example.com",
    });
    const installationId = randomUUID();
    const [computer] = await client.database
      .insert(computers)
      .values({
        ownerAccountId: account.userId,
        currentInstallationId: installationId,
        kind: "cloud",
        displayName: "Cloud",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.2",
      })
      .returning();
    if (!computer) throw new Error("Missing fixture Computer");
    const first = await runtime.cloudControl.issue({ computerId: computer.id, installationId });
    const firstIdentity = await runtime.auth.verifyMachineToken(first.credential);
    await expect(runtime.assertCloudControlCredential(firstIdentity)).resolves.toBeUndefined();
    const second = await runtime.cloudControl.rotate(firstIdentity.credentialId);
    const secondIdentity = await runtime.auth.verifyMachineToken(second.credential);
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
    const instanceId = randomUUID();
    await registry.register(
      {
        computerId: computer.id,
        installationId,
        instanceId,
        connectionId: randomUUID(),
        control: { ...secondIdentity, kind: "cloud" },
        active: true,
        lastHeartbeatAt: Date.now(),
        socket,
      },
      async () => undefined,
    );
    registry.activate(computer.id, instanceId, socket);
    await runtime.cloudControl.revoke(firstIdentity.credentialId);
    expect(socket.close).not.toHaveBeenCalled();
    await expect(runtime.auth.verifyMachineToken(first.credential)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    await expect(runtime.auth.verifyMachineToken(second.credential)).resolves.toMatchObject(secondIdentity);
    await runtime.cloudControl.revoke(secondIdentity.credentialId);
    expect(socket.close).toHaveBeenCalled();
    await expect(runtime.assertCloudControlCredential(secondIdentity)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    await runtime.auth.verifyMachineToken("local-fixture");
    expect(localAuth.verifyMachineToken).toHaveBeenCalledWith("local-fixture");
  } finally {
    await runtime.close();
    await client.sql.end();
    await rm(root, { recursive: true, force: true });
  }
});
