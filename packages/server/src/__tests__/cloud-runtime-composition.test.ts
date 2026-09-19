import { randomUUID } from "node:crypto";
import { CLOUD_MODEL_CHAT_COMPLETIONS_PATH, RUNNER_WORKSPACE_PATH } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  cloudAppOptions,
  collectKnownSecrets,
  createCloudDeliveryComposition,
  createCloudIngressAllocationPort,
  createSandboxRunnerRuntime,
} from "../cloud-runtime-composition.js";
import type { ServerConfig } from "../config.js";
import { imBindings, sandboxes, users } from "../db/schema/index.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { createRuntimeCredentialServices } from "../runtime-credentials/index.js";
import { AgentService } from "../services/agents/index.js";
import { formatStartupError } from "../services/auth/index.js";
import { ComputerService } from "../services/computers/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { CloudRuntimeFence } from "../services/sandboxes/cloud-runtime-fence.js";
import { SandboxService } from "../services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "../services/sandboxes/runner-bootstrap-token.js";
import { RunnerHub } from "../services/sandboxes/runner-hub.js";
import { SandboxRunnerService } from "../services/sandboxes/sandbox-runner-service.js";
import { SessionService } from "../services/sessions/index.js";
import { FAKE_REGION, FakeCloudRunAdmin } from "./support/fake-cloud-run-admin.js";
import { FakeWorkspaceObjectStore } from "./support/fake-workspace-store.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/**
 * Production entrypoint composition regression: index.ts's exported factories are the exact code
 * paths `startServer` uses, so a model route that is created but never registered with createApp
 * (the earlier confirmed 404) and the model master secret omission are caught here rather than in
 * a stand-alone route fixture.
 */

const RUNNER_VERSION = "0.0.5";
const cloudIdentities = { enabled: true as const, runnerVersion: RUNNER_VERSION, storageBase: "gs://unit-cloud/x" };
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};
const MASTER_KEY_SENTINEL = "fixture-cloud-model-master-key-sentinel";
const MODEL = "fixture-model";
const CLOUD_MODEL = {
  enabled: true as const,
  upstreamBaseUrl: "https://model.invalid/v1",
  masterKey: MASTER_KEY_SENTINEL,
  allowedModels: [MODEL],
  tokenTtlSeconds: 900,
  requestTimeoutMs: 600_000,
  maxRequestBytes: 2 * 1024 * 1024,
  maxResponseBytes: 16 * 1024 * 1024,
  maxStreamsPerToken: 4,
};

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

function credentialOwner() {
  return createRuntimeCredentialServices({
    cipher: new ApplicationCipher(new Uint8Array(32).fill(7)),
    custody: new PostgresRuntimeCustodyStore(unit.database),
    database: unit.database,
    registry: new ConnectionRegistry(),
  }).owner;
}

function runnerRuntime() {
  const cloudAdmin = new FakeCloudRunAdmin();
  const hub = new RunnerHub();
  const tokens = new RunnerBootstrapTokenService("unit-test-jwt-secret-at-least-32-characters", { ttlSeconds: 600 });
  const sandboxRunnerService = new SandboxRunnerService(unit.database, {
    cloudAdmin: cloudAdmin as never,
    tokens,
    hub,
    environment: "dev",
    backendUrl: "wss://server.example.test/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: RUNNER_VERSION,
    acceptanceTimeoutMs: 60_000,
    createConvergeTimeoutMs: 5_000,
  });
  return { cloudAdmin, sandboxRunnerService, runnerChannel: { tokens, hub } };
}

describe("production Cloud runtime composition", () => {
  it("wires workspace persistence through the exact production factory and app registration", async () => {
    const config: Pick<ServerConfig, "environment" | "jwtSecret" | "cloudRunner" | "cloudIdentities"> = {
      environment: "dev",
      jwtSecret: "unit-test-jwt-secret-at-least-32-characters",
      cloudIdentities,
      cloudRunner: {
        enabled: true,
        image: `registry.example.test/runner@sha256:${"a".repeat(64)}`,
        project: "unit-project",
        region: FAKE_REGION,
        serviceAccount: "runner@unit-project.iam.gserviceaccount.com",
        backendOrigin: "https://server.example.test",
        vpc: { network: "unit-network", subnetwork: "unit-subnet", executionTag: "unit-runner" },
        staticAccessToken: "fixture-google-access-token",
        apiTimeoutMs: 30_000,
        createConvergeTimeoutMs: 120_000,
        bootstrapTokenTtlSeconds: 600,
        acceptanceTimeoutMs: 60_000,
        idleTimeoutMs: 120_000,
      },
    };
    const store = new FakeWorkspaceObjectStore();
    let issuedToken: Promise<string> | undefined;
    const runtime = createSandboxRunnerRuntime(unit.database, config, {
      workspaceStoreFactory: ({ tokenProvider }) => {
        issuedToken = tokenProvider();
        return store;
      },
    });
    expect(await issuedToken).toBe("fixture-google-access-token");
    expect(runtime?.sandboxRunnerService.workspacePersistenceEnabled).toBe(true);
    const options = cloudAppOptions({ runnerRuntime: runtime, composition: {}, cloudModel: { enabled: false } });
    expect(options.runnerWorkspace).toBe(runtime?.runnerWorkspace);
    expect(options.runnerWorkspace).toBeDefined();
    const app = createApp(options);
    try {
      for (const [method, path] of [
        ["POST", "claim"],
        ["GET", "archive"],
        ["PUT", "archive"],
      ] as const) {
        const response = await app.inject({ method, url: `${RUNNER_WORKSPACE_PATH}/${path}` });
        expect(response.statusCode).toBe(401);
      }
    } finally {
      await app.close();
    }
    // The default GCS adapter is constructed without acquiring credentials or issuing I/O.
    const production = createSandboxRunnerRuntime(unit.database, config);
    expect(production?.sandboxRunnerService.workspacePersistenceEnabled).toBe(true);
    expect(production?.runnerWorkspace).toBeDefined();
    expect(createSandboxRunnerRuntime(unit.database, { ...config, cloudRunner: { enabled: false } })).toBeUndefined();
  });

  it("registers the same grant instance on the createApp model route and the delivery owner", async () => {
    const runtime = runnerRuntime();
    const composition = createCloudDeliveryComposition({
      cloudModel: CLOUD_MODEL,
      jwtSecret: "unit-test-jwt-secret-at-least-32-characters",
      publicUrl: "https://server.example.test",
      database: unit.database,
      custody: new PostgresRuntimeCustodyStore(unit.database),
      hub: runtime.runnerChannel.hub,
      cloudRuntimeFence: new CloudRuntimeFence(),
      credentialOwner: credentialOwner(),
      allocationStatus: async () => undefined,
    });
    expect(composition.cloudModelGrants).toBeDefined();
    expect(composition.cloudDeliveryOwner).toBeDefined();

    const appOptions = cloudAppOptions({
      runnerRuntime: runtime,
      composition,
      cloudModel: CLOUD_MODEL,
    });
    // The exact owner instance reaches the Runner channel and the exact grant instance reaches
    // the model route; neither is re-created at registration time.
    expect(appOptions.runnerChannel?.cloudDelivery).toBe(composition.cloudDeliveryOwner);
    expect(appOptions.cloudModel?.grants).toBe(composition.cloudModelGrants);
    expect(appOptions.cloudModel?.config.masterKey).toBe(MASTER_KEY_SENTINEL);

    const app = createApp(appOptions);
    try {
      // A malformed call must be denied by the registered route (401), not answered by the
      // not-found handler (404) that an unwired entrypoint produced.
      const denied = await app.inject({
        method: "POST",
        url: CLOUD_MODEL_CHAT_COMPLETIONS_PATH,
        headers: { authorization: "Bearer not-a-valid-execution-token" },
        payload: { model: MODEL, messages: [] },
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toMatchObject({ error: { code: "CLOUD_MODEL_TOKEN_INVALID" } });

      // The grant instance is live: a real issued token verifies through the same service.
      const issued = await composition.cloudModelGrants?.issue({
        executionId: randomUUID(),
        model: MODEL,
        sandboxId: randomUUID(),
        sessionId: randomUUID(),
      });
      expect(issued?.token).toBeTypeOf("string");
      expect(await composition.cloudModelGrants?.verify(issued?.token as string)).toMatchObject({ model: MODEL });
    } finally {
      await app.close();
    }
  });

  it("keeps the model master key in the startup redaction set with a fixture sentinel", () => {
    const secrets = collectKnownSecrets({
      OPENTAG_CLOUD_MODEL_MASTER_KEY: MASTER_KEY_SENTINEL,
    } as NodeJS.ProcessEnv);
    expect(secrets).toContain(MASTER_KEY_SENTINEL);
    const formatted = formatStartupError(new Error(`upstream rejected ${MASTER_KEY_SENTINEL}`), secrets);
    expect(formatted).not.toContain(MASTER_KEY_SENTINEL);
    expect(formatted).toContain("[REDACTED]");
  });

  it("keeps the Skill object-store secret in the startup redaction set", () => {
    const secrets = collectKnownSecrets({
      OPENTAG_SKILL_STORAGE_SECRET_ACCESS_KEY: MASTER_KEY_SENTINEL,
    } as NodeJS.ProcessEnv);
    expect(secrets).toContain(MASTER_KEY_SENTINEL);
    const formatted = formatStartupError(new Error(`storage rejected ${MASTER_KEY_SENTINEL}`), secrets);
    expect(formatted).not.toContain(MASTER_KEY_SENTINEL);
    expect(formatted).toContain("[REDACTED]");
  });

  it("ensures the Session Sandbox and converges the first generation through the real services", async () => {
    const accountId = randomUUID();
    await unit.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "E4" });
    const cloud = await new ComputerService(unit.database, unusedAccountResolver, {
      cloudIdentities,
    }).ensureCloudComputerForAccount(accountId);
    const agent = await new AgentService(unit.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
      name: `e4-pi-${randomUUID().slice(0, 8)}`,
      displayName: "E4 Pi",
      runtimeProvider: "pi",
      computerId: cloud.computerId,
    });
    const bindingId = randomUUID();
    await unit.database.insert(imBindings).values({
      id: bindingId,
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: `unit-app-${randomUUID().slice(0, 8)}`,
      externalBotId: "unit-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "unit-only-unused",
      activatedAt: new Date(),
    });
    const sandboxService = new SandboxService(unit.database, new SessionService(unit.database), { cloudIdentities });
    const runtime = runnerRuntime();
    const port = createCloudIngressAllocationPort({
      sandboxService,
      sandboxRunnerService: runtime.sandboxRunnerService,
    });

    const ensured = await port.ensureSandbox({
      accountId,
      imBindingId: bindingId,
      channelId: "unit-channel",
      conversationKind: "channel",
      kind: "channel",
    });
    expect(ensured.sandboxId).toBeTypeOf("string");
    const [created] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, ensured.sandboxId));
    expect(created?.lifecycle).toBe("unallocated");
    expect(created?.environmentGeneration).toBe(0);

    // First generation allocation is requested through the existing service and the injected
    // Cloud API; no Runner is connected yet, so the outcome is pending, never a hard failure.
    const first = await port.ensureEnvironmentAllocated({ accountId, sandboxId: ensured.sandboxId });
    expect(first).toBe("pending");
    expect(runtime.cloudAdmin.createCalls).toHaveLength(1);
    const [allocating] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, ensured.sandboxId));
    expect(allocating?.environmentGeneration).toBe(1);
    expect(allocating?.currentResourceName).toContain(`/locations/${FAKE_REGION}/instances/`);
    expect(allocating?.currentResourceUid).not.toBeNull();

    // A previously used (released) generation must NOT be replaced by a blank environment before
    // E5 restore: the ingress guard reports restore_required and never calls create again.
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "unallocated", currentResourceName: null, currentResourceUid: null })
      .where(eq(sandboxes.id, ensured.sandboxId));
    const restored = await port.ensureEnvironmentAllocated({ accountId, sandboxId: ensured.sandboxId });
    expect(restored).toBe("restore_required");
    expect(runtime.cloudAdmin.createCalls).toHaveLength(1);
  });
});
