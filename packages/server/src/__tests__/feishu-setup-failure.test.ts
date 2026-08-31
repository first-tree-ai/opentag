import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { accountComputers, computers, imBindings, workspaceComputers } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import {
  FeishuOperationError,
  feishuPublicFailure,
  feishuSetupFailureCode,
  safeFeishuActivationErrorCode,
  safeFeishuConnectionErrorCode,
  safeFeishuSetupErrorCode,
} from "../services/im-bindings/feishu/index.js";
import type { FeishuRegistration, FeishuRegistrationGateway } from "../services/im-bindings/feishu/registration.js";
import { type FeishuBindingActivation, FeishuSetupService } from "../services/im-bindings/feishu/setup-service.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";
import { bootstrapTestAccount } from "./test-account.js";

function fetchFailed(cause: unknown): Error {
  const error = new TypeError("fetch failed");
  return Object.assign(error, { cause });
}

let setupDatabase: UnitDatabase;
const setupNow = new Date("2026-08-19T00:00:00.000Z");

beforeAll(async () => {
  setupDatabase = await createUnitDatabase();
}, 60_000);
afterAll(async () => setupDatabase?.close());
beforeEach(async () => setupDatabase?.reset());

async function setupFixture() {
  const bootstrap = await bootstrapTestAccount(setupDatabase.database, {
    displayName: "Admin",
    email: `setup-${crypto.randomUUID()}@example.com`,
  });
  const [computer] = await setupDatabase.database.insert(computers).values({ id: crypto.randomUUID() }).returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const [workspaceComputer] = await setupDatabase.database
    .insert(workspaceComputers)
    .values({
      workspaceId: bootstrap.workspaceId,
      computerId: computer.id,
      displayName: "setup-computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
      enrolledByUserId: bootstrap.userId,
    })
    .returning();
  if (!workspaceComputer) throw new Error("Workspace Computer fixture was not created");
  await setupDatabase.database.insert(accountComputers).values({
    id: workspaceComputer.id,
    ownerAccountId: bootstrap.userId,
    currentInstallationId: computer.id,
    displayName: "setup-computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.1",
  });
  const agent = await new AgentService(setupDatabase.database).createForAccount(bootstrap.userId, {
    name: "setup-agent",
    displayName: "Setup Agent",
    runtimeProvider: "codex",
    computerId: workspaceComputer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindings = new ImBindingService(setupDatabase.database, cipher, { now: () => setupNow });
  return { bootstrap, agent, computerId: workspaceComputer.id, cipher, imBindings };
}

function registration(
  result: Promise<{ appId: string; appSecret: string; teamBrand?: "feishu" | "lark" }>,
  qr = setupNow,
): FeishuRegistration {
  return {
    qrReady: Promise.resolve({ url: "https://feishu.example/qr", expiresAt: new Date(qr.getTime() + 60_000) }),
    result,
    abort: vi.fn(),
  };
}

describe("Feishu setup failure classification", () => {
  it("preserves typed connection errors and classifies unknown ones", () => {
    expect(safeFeishuConnectionErrorCode(new FeishuOperationError("FEISHU_CONNECTION_LEASE_STALE"))).toBe(
      "FEISHU_CONNECTION_LEASE_STALE",
    );
    expect(safeFeishuConnectionErrorCode(new Error("socket closed"))).toBe("FEISHU_CONNECTION_ERROR");
  });
  it.each([
    ["a transport failure with no cause", fetchFailed(undefined)],
    ["a name resolution failure", fetchFailed(Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }))],
    ["a refused connection", Object.assign(new Error("connect"), { code: "ECONNREFUSED" })],
    ["a connect timeout", fetchFailed(Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }))],
    ["an abort on timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    [
      "an answer without an authorization URL",
      Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input: "undefined" }),
    ],
  ])("reports %s as an unavailable Feishu platform", (_label, error) => {
    expect(feishuSetupFailureCode(error)).toBe("FEISHU_UPSTREAM_UNAVAILABLE");
  });

  it.each([
    ["a rejected authorization", Object.assign(new Error("denied"), { code: "access_denied" })],
    ["an unlabeled failure", new Error("boom")],
    ["a non-error rejection", "boom"],
  ])("keeps %s an unexpected setup failure", (_label, error) => {
    expect(feishuSetupFailureCode(error)).toBe("FEISHU_SETUP_FAILED");
  });

  it("does not loop on a self-referencing cause chain", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(feishuSetupFailureCode(error)).toBe("FEISHU_SETUP_FAILED");
  });

  it("records the classified code on the attempt outcome", () => {
    expect(safeFeishuSetupErrorCode(fetchFailed(undefined))).toBe("FEISHU_UPSTREAM_UNAVAILABLE");
    expect(safeFeishuSetupErrorCode(Object.assign(new Error("denied"), { code: "access_denied" }))).toBe(
      "FEISHU_SETUP_DENIED",
    );
    expect(safeFeishuSetupErrorCode(new Error("boom"))).toBe("FEISHU_SETUP_FAILED");
  });

  it.each([
    ["a database timeout", Object.assign(new Error("statement timeout"), { code: "ETIMEDOUT" })],
    ["a dropped database connection", Object.assign(new Error("connection terminated"), { code: "ECONNRESET" })],
  ])("keeps %s after authorization an internal failure", (_label, error) => {
    expect(safeFeishuActivationErrorCode(error)).toBe("FEISHU_SETUP_FAILED");
    // The same shape while awaiting Feishu is the platform's, so the phases must not share a classifier.
    expect(safeFeishuSetupErrorCode(error)).toBe("FEISHU_UPSTREAM_UNAVAILABLE");
  });

  it("keeps an unlabeled activation failure an internal failure", () => {
    expect(safeFeishuActivationErrorCode(new Error("activation failed"))).toBe("FEISHU_SETUP_FAILED");
  });

  it("still names the outcome a caller reported after authorization", () => {
    expect(safeFeishuActivationErrorCode(Object.assign(new Error("denied"), { code: "access_denied" }))).toBe(
      "FEISHU_SETUP_DENIED",
    );
    expect(safeFeishuActivationErrorCode(new FeishuOperationError("FEISHU_BINDING_NOT_ACTIVE"))).toBe(
      "FEISHU_BINDING_NOT_ACTIVE",
    );
  });

  it("publishes only the failure the caller can act on", () => {
    expect(feishuPublicFailure(new FeishuOperationError("FEISHU_UPSTREAM_UNAVAILABLE"))).toMatchObject({
      code: "FEISHU_UPSTREAM_UNAVAILABLE",
      statusCode: 502,
      category: "transient",
    });
    expect(feishuPublicFailure(new FeishuOperationError("FEISHU_SETUP_FENCE_STALE"))).toBeUndefined();
    expect(feishuPublicFailure(new Error("boom"))).toBeUndefined();
  });
});

describe("FeishuSetupService persistence", () => {
  it("creates and reuses an owned QR attempt, then completes activation", async () => {
    const value = await setupFixture();
    let resolveResult!: (result: { appId: string; appSecret: string; teamBrand: "feishu" }) => void;
    const result = new Promise<{ appId: string; appSecret: string; teamBrand: "feishu" }>((resolve) => {
      resolveResult = resolve;
    });
    const gateway: FeishuRegistrationGateway = {
      start: vi.fn(() => registration(result, new Date())),
    };
    const activation: FeishuBindingActivation = {
      activateAtomicAttempt: vi.fn(async (input) => {
        // The real connection manager commits the validating slot to succeeded; this fake models that seam.
        await setupDatabase.database
          .update(imBindings)
          .set({
            setupState: "succeeded",
            setupOwnerInstanceId: null,
            setupOwnerHeartbeatAt: null,
            encryptedSetupContext: null,
            setupExpiresAt: null,
          })
          .where(eq(imBindings.setupAttemptId, input.attemptId));
        return {
          agentId: input.agentId,
          appId: input.appId,
          appSecret: input.appSecret,
          teamId: "tenant_setup",
          botOpenId: "ou_setup",
          teamBrand: input.teamBrand,
          grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
        };
      }),
    };
    const service = new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: gateway,
      activation,
    });
    const first = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(first).toMatchObject({
      agentId: value.agent.id,
      state: "awaiting_user",
      qrUrl: "https://feishu.example/qr",
    });
    const reused = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(reused.id).toBe(first.id);
    resolveResult({ appId: "cli_setup", appSecret: "secret", teamBrand: "feishu" });
    await vi.waitFor(async () => {
      expect(activation.activateAtomicAttempt).toHaveBeenCalledTimes(1);
      const [row] = await setupDatabase.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.setupAttemptId, first.id));
      expect(row?.setupState).toBe("succeeded");
    });
    await expect(service.get(value.bootstrap.userId, first.id)).resolves.toMatchObject({
      state: "succeeded",
      qrUrl: null,
    });
    expect(gateway.start).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "create", receiveMode: "all_message" }),
    );
  });

  it("supports cancellation, failed registration, invalid attempts, and clean shutdown", async () => {
    const value = await setupFixture();
    let rejectResult!: (error: unknown) => void;
    const pendingResult = new Promise<never>((_resolve, reject) => {
      rejectResult = reject;
    });
    const abort = vi.fn();
    const gateway: FeishuRegistrationGateway = {
      start: vi.fn(() => ({ ...registration(pendingResult, new Date()), abort })),
    };
    const diagnostic = vi.fn();
    const service = new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: gateway,
      activation: { activateAtomicAttempt: vi.fn() },
      onDiagnostic: diagnostic,
    });
    const attempt = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    await expect(service.cancel(value.bootstrap.userId, attempt.id)).resolves.toMatchObject({
      state: "canceled",
      errorCode: "FEISHU_SETUP_CANCELED",
    });
    expect(abort).toHaveBeenCalled();
    await expect(service.cancel(value.bootstrap.userId, attempt.id)).resolves.toMatchObject({ state: "canceled" });
    rejectResult(Object.assign(new Error("access denied"), { code: "access_denied" }));
    await vi.waitFor(async () => {
      const row = await setupDatabase.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.setupAttemptId, attempt.id));
      expect(row[0]?.setupState).toBe("canceled");
    });
    await service.stop();
    await expect(service.get(value.bootstrap.userId, crypto.randomUUID())).rejects.toThrow("FEISHU_SETUP_NOT_FOUND");
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("classifies setup ownership as expired or restarted without mutating GET", async () => {
    const value = await setupFixture();
    const attemptId = crypto.randomUUID();
    await setupDatabase.database.insert(imBindings).values({
      agentId: value.agent.id,
      provider: "feishu",
      status: "provisioning",
      setupAttemptId: attemptId,
      setupIntent: "create",
      setupState: "awaiting_user",
      setupOwnerInstanceId: crypto.randomUUID(),
      setupOwnerHeartbeatAt: new Date(Date.now() - 60_000),
      encryptedSetupContext: value.cipher.encrypt(JSON.stringify({ qrUrl: "https://old" })),
      setupExpiresAt: new Date(Date.now() - 1_000),
    });
    const service = new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: { start: vi.fn() },
      activation: { activateAtomicAttempt: vi.fn() },
    });
    await expect(service.get(value.bootstrap.userId, attemptId)).resolves.toMatchObject({
      state: "expired",
      errorCode: "FEISHU_SETUP_EXPIRED",
      qrUrl: null,
    });
    await setupDatabase.database
      .update(imBindings)
      .set({ setupExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(imBindings.setupAttemptId, attemptId));
    await expect(service.get(value.bootstrap.userId, attemptId)).resolves.toMatchObject({
      state: "failed",
      errorCode: "FEISHU_SETUP_OWNER_RESTARTED",
    });
  });

  it("rejects invalid setup intents and classifies registration failures", async () => {
    const value = await setupFixture();
    await value.imBindings.activateFeishu({
      agentId: value.agent.id,
      appId: "cli_existing",
      teamId: "tenant_existing",
      botOpenId: "ou_existing",
      appSecret: "existing-secret",
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    });
    const service = new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: { start: vi.fn() },
      activation: { activateAtomicAttempt: vi.fn() },
    });
    await expect(service.createOrReuse(value.bootstrap.userId, value.agent.id, "create")).rejects.toThrow(
      "FEISHU_IM_BINDING_ALREADY_EXISTS",
    );

    const noBindingAgent = await new AgentService(setupDatabase.database).createForAccount(value.bootstrap.userId, {
      name: "unbound-agent",
      displayName: "Unbound Agent",
      runtimeProvider: "codex",
      computerId: value.computerId,
    });
    await expect(service.createOrReuse(value.bootstrap.userId, noBindingAgent.id, "reauthorize")).rejects.toThrow(
      "FEISHU_REAUTHORIZATION_REQUIRES_BINDING",
    );
    await expect(service.createOrReuse(value.bootstrap.userId, noBindingAgent.id, "replace")).rejects.toThrow(
      "FEISHU_REPLACEMENT_REQUIRES_BINDING",
    );

    const startFailure = new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: {
        start: vi.fn(() => {
          throw new Error("gateway unavailable");
        }),
      },
      activation: { activateAtomicAttempt: vi.fn() },
    });
    await expect(startFailure.createOrReuse(value.bootstrap.userId, noBindingAgent.id, "create")).rejects.toMatchObject(
      {
        code: "FEISHU_SETUP_FAILED",
      },
    );

    const qrReadyError = Object.assign(new Error("qr unavailable"), { code: "access_denied" });
    const qrGateway = {
      start: vi.fn(() => ({
        qrReady: Promise.reject(qrReadyError),
        result: Promise.reject(new Error("result unavailable")),
        abort: vi.fn(),
      })),
    } satisfies FeishuRegistrationGateway;
    const qrService = new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: qrGateway,
      activation: { activateAtomicAttempt: vi.fn() },
    });
    await expect(qrService.createOrReuse(value.bootstrap.userId, noBindingAgent.id, "create")).rejects.toMatchObject({
      code: "FEISHU_SETUP_FAILED",
    });
  });

  it("takes over stale setup ownership and updates active heartbeats", async () => {
    const value = await setupFixture();
    const staleAttemptId = crypto.randomUUID();
    const staleOwner = crypto.randomUUID();
    await setupDatabase.database.insert(imBindings).values({
      agentId: value.agent.id,
      provider: "feishu",
      status: "provisioning",
      setupAttemptId: staleAttemptId,
      setupIntent: "create",
      setupState: "awaiting_user",
      setupOwnerInstanceId: staleOwner,
      setupOwnerHeartbeatAt: new Date(Date.now() - 60_000),
      encryptedSetupContext: value.cipher.encrypt(JSON.stringify({ qrUrl: "https://stale" })),
      setupExpiresAt: new Date(Date.now() + 60_000),
    });
    let resolveResult!: (result: { appId: string; appSecret: string }) => void;
    const result = new Promise<{ appId: string; appSecret: string }>((resolve) => {
      resolveResult = resolve;
    });
    const service = new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: { start: vi.fn(() => registration(result)) },
      activation: { activateAtomicAttempt: vi.fn() },
    });
    const attempt = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(attempt.id).not.toBe(staleAttemptId);
    resolveResult({ appId: "cli_new", appSecret: "new-secret" });
    await service.stop();
  });

  it("starts the setup heartbeat and stops active registrations", async () => {
    vi.useFakeTimers();
    try {
      const value = await setupFixture();
      let resolveResult!: (result: { appId: string; appSecret: string }) => void;
      const result = new Promise<{ appId: string; appSecret: string }>((resolve) => {
        resolveResult = resolve;
      });
      const abort = vi.fn();
      const service = new FeishuSetupService({
        database: setupDatabase.database,
        cipher: value.cipher,
        instanceId: crypto.randomUUID(),
        imBindings: value.imBindings,
        registrations: { start: vi.fn(() => ({ ...registration(result), abort })) },
        activation: { activateAtomicAttempt: vi.fn() },
      });
      service.start();
      service.start();
      const attempt = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      await vi.advanceTimersByTimeAsync(5_000);
      const [heartbeat] = await setupDatabase.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.setupAttemptId, attempt.id));
      expect(heartbeat?.setupOwnerHeartbeatAt).toBeInstanceOf(Date);
      await service.stop();
      expect(abort).toHaveBeenCalledTimes(1);
      const [stopped] = await setupDatabase.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.setupAttemptId, attempt.id));
      expect(stopped?.setupState).toBe("failed");
      expect(stopped?.lastErrorCode).toBe("FEISHU_SETUP_OWNER_RESTARTED");
      resolveResult({ appId: "cli_unused", appSecret: "unused" });
    } finally {
      vi.useRealTimers();
    }
  });
});
