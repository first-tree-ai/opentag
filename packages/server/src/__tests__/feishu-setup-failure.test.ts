import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import { computers, imBindings } from "../db/schema/index.js";
import { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import {
  encodeFeishuSetupCandidate,
  encodeFeishuSetupQr,
  FeishuCandidateExpiredError,
  FeishuOperationError,
  feishuPublicFailure,
  feishuSetupFailureCode,
  safeFeishuActivationErrorCode,
  safeFeishuConnectionErrorCode,
  safeFeishuSetupErrorCode,
} from "../services/im-bindings/feishu/index.js";
import type { FeishuRegistration, FeishuRegistrationGateway } from "../services/im-bindings/feishu/registration.js";
import {
  type FeishuBindingActivation,
  FeishuSetupService,
  type FeishuSetupTiming,
} from "../services/im-bindings/feishu/setup-service.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

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
  const [computer] = await setupDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "setup-computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(setupDatabase.database).createForAccount(bootstrap.userId, {
    name: "setup-agent",
    displayName: "Setup Agent",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindings = new ImBindingService(setupDatabase.database, cipher, { now: () => setupNow });
  return { bootstrap, agent, computerId: computer.id, cipher, imBindings };
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

type SetupFixture = Awaited<ReturnType<typeof setupFixture>>;

const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/** The row's setup context in the shape the named write path produces. */
function setupContextFor(
  value: SetupFixture,
  bindingId: string,
  attemptId: string,
  input: { context?: "candidate" | "qr" | "malformed" | "none"; nextCheckAt?: Date },
  now: Date,
): string | null {
  if (input.context === "none") return null;
  if (input.context === "qr") {
    return encodeFeishuSetupQr(value.cipher, "https://feishu.example/legacy-qr", bindingId, attemptId);
  }
  if (input.context === "malformed") return value.cipher.encrypt("not-json-at-all");
  return candidateEnvelope(value, bindingId, attemptId, now, input.nextCheckAt);
}

/** The durable envelope exactly as the save-first step writes it, bound to its own row identity. */
function candidateEnvelope(
  value: SetupFixture,
  bindingId: string,
  attemptId: string,
  savedAt: Date,
  nextCheckAt?: Date,
): string {
  return encodeFeishuSetupCandidate(
    value.cipher,
    {
      version: 1,
      kind: "feishu_candidate",
      bindingId,
      attemptId,
      appId: "cli_candidate",
      appSecret: "candidate-secret",
      teamBrand: "feishu",
      savedAt: savedAt.toISOString(),
      nextCheckAt: (nextCheckAt ?? savedAt).toISOString(),
      observation: null,
    },
    bindingId,
    attemptId,
  );
}

/**
 * The Agent's single current Feishu binding for one setup attempt, written in the shape the named
 * production write path produces. An Agent holds exactly one current binding, so this updates that
 * row in place: the binding identity is stable and only the attempt it currently carries changes.
 * The reader takes the candidate's identity out of the ciphertext itself, so the attempt id is bound
 * into the envelope rather than invented later by an assertion.
 */
async function insertAttempt(
  value: SetupFixture,
  input: {
    state?: "awaiting_user" | "pending_activation" | "validating" | "failed";
    agentId?: string;
    context?: "candidate" | "qr" | "malformed" | "none";
    expiresAt?: Date | null;
    owner?: string | null;
    heartbeatAt?: Date | null;
    intent?: "create" | "reauthorize" | "replace";
    savedAt?: Date;
    nextCheckAt?: Date;
  } = {},
): Promise<{ attemptId: string; bindingId: string; agentId: string }> {
  const state = input.state ?? "pending_activation";
  const agentId = input.agentId ?? value.agent.id;
  const attemptId = crypto.randomUUID();
  const now = input.savedAt ?? new Date();
  const owner = input.owner !== undefined ? input.owner : state === "pending_activation" ? null : crypto.randomUUID();
  const heartbeatAt = input.heartbeatAt !== undefined ? input.heartbeatAt : owner ? now : null;
  const setupExpiresAt = input.expiresAt !== undefined ? input.expiresAt : new Date(now.getTime() + CANDIDATE_TTL_MS);
  const [existing] = await setupDatabase.database
    .select({ id: imBindings.id })
    .from(imBindings)
    .where(eq(imBindings.agentId, agentId))
    .limit(1);
  const bindingId = existing?.id ?? crypto.randomUUID();
  const shared = {
    setupAttemptId: attemptId,
    setupIntent: input.intent ?? "create",
    setupState: state,
    setupOwnerInstanceId: owner,
    setupOwnerHeartbeatAt: heartbeatAt,
    encryptedSetupContext: setupContextFor(value, bindingId, attemptId, input, now),
    setupExpiresAt,
    updatedAt: now,
  };
  if (existing) {
    await setupDatabase.database.update(imBindings).set(shared).where(eq(imBindings.id, existing.id));
    return { attemptId, bindingId, agentId };
  }
  await setupDatabase.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "provisioning",
    ...shared,
    createdAt: now,
  });
  return { attemptId, bindingId, agentId };
}

async function rowForAttempt(attemptId: string) {
  const [row] = await setupDatabase.database.select().from(imBindings).where(eq(imBindings.setupAttemptId, attemptId));
  return row;
}

async function createAgent(value: SetupFixture, label: string) {
  return new AgentService(setupDatabase.database).createForAccount(value.bootstrap.userId, {
    name: `${label}-${crypto.randomUUID().slice(0, 8)}`,
    displayName: label,
    runtimeProvider: "codex",
    computerId: value.computerId,
  });
}

function setupService(
  value: SetupFixture,
  options: {
    instanceId?: string;
    gateway?: FeishuRegistrationGateway;
    activation?: FeishuBindingActivation;
    timing?: FeishuSetupTiming;
    onDiagnostic?: (code: string) => void;
    now?: () => Date;
  } = {},
): FeishuSetupService {
  return new FeishuSetupService({
    database: setupDatabase.database,
    cipher: value.cipher,
    instanceId: options.instanceId ?? crypto.randomUUID(),
    imBindings: value.imBindings,
    registrations: options.gateway ?? { start: vi.fn() },
    activation: options.activation ?? { activateAtomicAttempt: vi.fn() },
    timing: { checkIntervalMs: 0, checkJitterMs: 0, ownerHeartbeatMs: 10, ...options.timing },
    now: options.now ?? (() => new Date()),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  });
}

/** A gateway whose registration never finishes, which is the normal case while a person scans. */
function pendingGateway() {
  const result = new Promise<never>(() => undefined);
  const abort = vi.fn();
  const gateway: FeishuRegistrationGateway = { start: vi.fn(() => ({ ...registration(result, new Date()), abort })) };
  return { gateway, abort };
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

  it("supervises a detached setup heartbeat failure with one event and counter", async () => {
    vi.useFakeTimers();
    try {
      const value = await setupFixture();
      const pendingResult = new Promise<never>(() => undefined);
      const gateway: FeishuRegistrationGateway = {
        start: vi.fn(() => ({ ...registration(pendingResult, new Date()), abort: vi.fn() })),
      };
      const events: unknown[] = [];
      const counters: unknown[] = [];
      const supervisor = new BackgroundFailureSupervisor({
        onEvent: (event) => events.push(event),
        onCounter: (name, labels) => counters.push({ name, labels }),
      });
      const service = new FeishuSetupService({
        database: setupDatabase.database,
        cipher: value.cipher,
        instanceId: crypto.randomUUID(),
        imBindings: value.imBindings,
        registrations: gateway,
        activation: { activateAtomicAttempt: vi.fn() },
        supervisor,
      });
      await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      const update = vi.spyOn(setupDatabase.database, "update").mockImplementation(() => {
        throw new Error("heartbeat failed");
      });
      service.start();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(counters).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "diagnostic.error",
        error: {
          code: "FEISHU_SETUP_HEARTBEAT_FAILED",
          category: "internal",
          retryability: "backoff",
          phase: "scheduler",
        },
      });
      update.mockRestore();
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
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
    await expect(service.createOrReuse(value.bootstrap.userId, value.agent.id, "create")).rejects.toMatchObject({
      code: "IM_BINDING_CONFIGURATION_CONFLICT",
      statusCode: 409,
    });

    const noBindingAgent = await new AgentService(setupDatabase.database).createForAccount(value.bootstrap.userId, {
      name: "unbound-agent",
      displayName: "Unbound Agent",
      runtimeProvider: "codex",
      computerId: value.computerId,
    });
    await expect(service.createOrReuse(value.bootstrap.userId, noBindingAgent.id, "reauthorize")).rejects.toMatchObject(
      {
        code: "IM_BINDING_CONFIGURATION_CONFLICT",
        statusCode: 409,
      },
    );
    await expect(service.createOrReuse(value.bootstrap.userId, noBindingAgent.id, "replace")).rejects.toMatchObject({
      code: "IM_BINDING_CONFIGURATION_CONFLICT",
      statusCode: 409,
    });

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

  it("aborts registrations even when persisting the shutdown outcome fails", async () => {
    const value = await setupFixture();
    const pending = registration(new Promise(() => {}));
    const service = new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: { start: () => pending },
      activation: { activateAtomicAttempt: vi.fn() },
    });
    await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    const update = vi.spyOn(setupDatabase.database, "update").mockImplementationOnce(() => {
      throw new Error("database unavailable during shutdown");
    });
    try {
      await expect(service.stop()).rejects.toThrow("database unavailable during shutdown");
      expect(pending.abort).toHaveBeenCalledTimes(1);
    } finally {
      update.mockRestore();
      await service.stop();
    }
  });

  it("takes over a stale QR owner by ending the lapsed attempt before writing a new one", async () => {
    const value = await setupFixture();
    const stale = await insertAttempt(value, {
      state: "awaiting_user",
      context: "qr",
      owner: crypto.randomUUID(),
      heartbeatAt: new Date(Date.now() - 3_600_000),
    });
    const { gateway } = pendingGateway();
    const service = setupService(value, { gateway });
    const attempt = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(attempt.id).not.toBe(stale.attemptId);
    expect(attempt.state).toBe("awaiting_user");
    const [row] = await setupDatabase.database.select().from(imBindings).where(eq(imBindings.agentId, value.agent.id));
    expect(row?.setupAttemptId).toBe(attempt.id);
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

/**
 * The durable-candidate lifecycle: the paths a saved candidate takes through `createOrReuse`,
 * `check`, `cancel`, the sweep and the projections. An Agent holds exactly one current Feishu
 * binding for its whole setup, so every case writes that row in the shape the production write path
 * under test produces and then asserts on it by its own identity.
 */
describe("FeishuSetupService durable candidate lifecycle", () => {
  it("reuses a live candidate under the lock and clears lapsed, malformed and ownerless ones", async () => {
    const value = await setupFixture();
    const service = setupService(value, { gateway: pendingGateway().gateway });

    // A live candidate wins the slot: the new registration is aborted and never written.
    const live = await insertAttempt(value);
    await expect(service.createOrReuse(value.bootstrap.userId, value.agent.id, "create")).resolves.toMatchObject({
      id: live.attemptId,
      state: "pending_activation",
    });
    expect((await rowForAttempt(live.attemptId))?.setupState).toBe("pending_activation");

    // A lapsed candidate is expired under the lock so the new QR attempt can take the slot.
    const lapsed = await insertAttempt(value, { expiresAt: new Date(Date.now() - 1_000) });
    const afterLapsed = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(afterLapsed.state).toBe("awaiting_user");
    expect(afterLapsed.id).not.toBe(lapsed.attemptId);

    // An authenticated but malformed context can never activate, so the locked reuse fails it.
    const malformed = await insertAttempt(value, { context: "malformed" });
    const afterMalformed = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(afterMalformed.id).not.toBe(malformed.attemptId);
    expect(await rowForAttempt(malformed.attemptId)).toBeUndefined();

    // A live QR attempt whose owning process vanished is a restart, not an expiry.
    const orphan = await insertAttempt(value, {
      state: "awaiting_user",
      context: "qr",
      owner: crypto.randomUUID(),
      heartbeatAt: new Date(Date.now() - 3_600_000),
    });
    const afterOrphan = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(afterOrphan.id).not.toBe(orphan.attemptId);
    expect(await rowForAttempt(orphan.attemptId)).toBeUndefined();
    await service.stop();
  });

  it("reuses a validating candidate and retires the lapsed, malformed and ownerless ones", async () => {
    const value = await setupFixture();
    const service = setupService(value, { gateway: pendingGateway().gateway });

    // A validating candidate this instance is not claiming is still the attempt to wait on.
    const validating = await insertAttempt(value, {
      state: "validating",
      owner: crypto.randomUUID(),
      heartbeatAt: new Date(Date.now() - 3_600_000),
    });
    // A claim this instance does not hold reads as a bounded wait for its owner.
    await expect(service.createOrReuse(value.bootstrap.userId, value.agent.id, "create")).resolves.toMatchObject({
      id: validating.attemptId,
      state: "pending_activation",
    });
    expect((await rowForAttempt(validating.attemptId))?.setupState).toBe("validating");

    const lapsed = await insertAttempt(value, { state: "validating", expiresAt: new Date(Date.now() - 1_000) });
    const afterLapsed = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(afterLapsed.id).not.toBe(lapsed.attemptId);

    // A malformed validating context whose owner is gone is terminally invalid, not a live claim.
    const malformed = await insertAttempt(value, {
      state: "validating",
      context: "malformed",
      owner: crypto.randomUUID(),
      heartbeatAt: new Date(Date.now() - 3_600_000),
    });
    const afterMalformed = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(afterMalformed.id).not.toBe(malformed.attemptId);

    // A legacy QR validating row whose owner is gone can never complete: it is a restart.
    const orphanQr = await insertAttempt(value, {
      state: "validating",
      context: "qr",
      owner: crypto.randomUUID(),
      heartbeatAt: new Date(Date.now() - 3_600_000),
    });
    const afterOrphanQr = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(afterOrphanQr.id).not.toBe(orphanQr.attemptId);

    // A live legacy QR validating row is reused as-is.
    const liveQr = await insertAttempt(value, { state: "validating", context: "qr" });
    await expect(service.createOrReuse(value.bootstrap.userId, value.agent.id, "create")).resolves.toMatchObject({
      id: liveQr.attemptId,
      state: "validating",
    });
    await service.stop();
  });

  it("returns the live QR attempt before starting a second registration", async () => {
    const value = await setupFixture();
    const { gateway } = pendingGateway();
    const service = setupService(value, { gateway });
    const first = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    const reused = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(reused.id).toBe(first.id);
    expect(gateway.start).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("expires a lapsed candidate and fails a malformed one on the explicit check", async () => {
    const value = await setupFixture();
    const service = setupService(value);

    const lapsed = await insertAttempt(value, { expiresAt: new Date(Date.now() - 1_000) });
    await expect(service.check(value.bootstrap.userId, lapsed.attemptId)).resolves.toMatchObject({
      state: "expired",
      errorCode: "FEISHU_SETUP_CANDIDATE_EXPIRED",
    });

    const malformed = await insertAttempt(value, { context: "malformed" });
    await expect(service.check(value.bootstrap.userId, malformed.attemptId)).resolves.toMatchObject({
      state: "failed",
      errorCode: "FEISHU_SETUP_CONTEXT_INVALID",
    });
    expect(await rowForAttempt(malformed.attemptId)).toMatchObject({
      setupState: "failed",
      lastErrorCode: "FEISHU_SETUP_CONTEXT_INVALID",
    });
  });

  it("reports a vanished candidate rather than inventing an attempt", async () => {
    const value = await setupFixture();
    const service = setupService(value);
    await expect(service.check(value.bootstrap.userId, crypto.randomUUID())).rejects.toThrow("FEISHU_SETUP_NOT_FOUND");
    await expect(service.cancel(value.bootstrap.userId, crypto.randomUUID())).rejects.toThrow("FEISHU_SETUP_NOT_FOUND");
    await expect(service.get(value.bootstrap.userId, crypto.randomUUID())).rejects.toThrow("FEISHU_SETUP_NOT_FOUND");
  });

  it("clears an unreadable candidate whose fixed deadline passed before refusing to read it", async () => {
    const value = await setupFixture();
    const service = setupService(value);
    const other = await createAgent(value, "check-other-agent");
    const foreignRing = new ApplicationCipher(Buffer.alloc(32, 9));
    const attempt = await insertAttempt(value, { agentId: other.id });
    await setupDatabase.database
      .update(imBindings)
      .set({
        encryptedSetupContext: foreignRing.encrypt("opaque-to-this-ring"),
        setupExpiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(imBindings.setupAttemptId, attempt.attemptId));
    await expect(service.check(value.bootstrap.userId, attempt.attemptId)).resolves.toMatchObject({
      state: "expired",
      errorCode: "FEISHU_SETUP_CANDIDATE_EXPIRED",
    });
  });

  it("aborts the registration a cancellation could not reach once the row is gone", async () => {
    const value = await setupFixture();
    const { gateway, abort } = pendingGateway();
    const service = setupService(value, { gateway });
    const attempt = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    // Activation can commit while cancellation waits for the Agent lock, so the cancel write matches
    // no row and the caller is answered from a fresh read.
    const transaction = vi.spyOn(setupDatabase.database, "transaction").mockResolvedValueOnce(undefined as never);
    try {
      await expect(service.cancel(value.bootstrap.userId, attempt.id)).resolves.toMatchObject({
        state: "awaiting_user",
      });
      expect(abort).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
    await expect(service.cancel(value.bootstrap.userId, attempt.id)).resolves.toMatchObject({ state: "canceled" });
    expect(abort).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("returns the open attempt Settings observes and hides a terminal one", async () => {
    const value = await setupFixture();
    const service = setupService(value, { gateway: pendingGateway().gateway });
    const first = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    await expect(service.getForAgent(value.bootstrap.userId, value.agent.id)).resolves.toMatchObject({
      id: first.id,
      state: "awaiting_user",
    });
    await expect(service.observeForAgent(value.agent.id)).resolves.toMatchObject({ id: first.id });
    await service.cancel(value.bootstrap.userId, first.id);
    await expect(service.getForAgent(value.bootstrap.userId, value.agent.id)).resolves.toBeUndefined();
    await expect(service.observeForAgent(value.agent.id)).resolves.toMatchObject({ state: "canceled" });
    await expect(service.observeForAgent(crypto.randomUUID())).resolves.toBeUndefined();
    await service.stop();
  });
});

/**
 * The claimed check and the sweep that drives it. A claim is the only path that runs upstream work,
 * so these pin what a claim settles as, what it does when it cannot write, and which rows the sweep
 * leaves alone.
 */
describe("FeishuSetupService claimed checks and sweep", () => {
  /** A service whose wall clock is the module's fixed instant, so deadlines are exact. */
  function createService(
    value: SetupFixture,
    options: {
      activation?: FeishuBindingActivation;
      timing?: FeishuSetupTiming;
      onDiagnostic?: (code: string) => void;
      clock?: Date;
    } = {},
  ): FeishuSetupService {
    const now = () => options.clock ?? setupNow;
    return new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: { start: vi.fn() },
      activation: options.activation ?? { activateAtomicAttempt: vi.fn() },
      timing: {
        checkIntervalMs: 0,
        checkJitterMs: 0,
        ownerHeartbeatMs: 10,
        ownerStaleMs: 60,
        sweepPageSize: 50,
        checkDeadlineMs: 5_000,
        ...options.timing,
      },
      now,
      random: () => 0,
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
  }

  it("settles a claimed check as a bounded wait and keeps the candidate", async () => {
    const value = await setupFixture();
    const activation: FeishuBindingActivation = {
      // A permission shortfall is a wait: the candidate must survive with its observation recorded.
      checkCandidate: vi.fn(async () => ({
        status: "waiting" as const,
        reason: "permissions_pending" as const,
        missingScopes: [FEISHU_REQUIRED_TENANT_SCOPES[0] as string],
      })),
      activateAtomicAttempt: vi.fn(),
    };
    const service = createService(value, { activation });
    const attempt = await insertAttempt(value, { nextCheckAt: setupNow });

    await expect(service.check(value.bootstrap.userId, attempt.attemptId)).resolves.toMatchObject({
      state: "pending_activation",
      activation: { reason: "permissions_pending", missingScopes: [FEISHU_REQUIRED_TENANT_SCOPES[0]] },
    });
    const row = await rowForAttempt(attempt.attemptId);
    expect(row).toMatchObject({ setupState: "pending_activation", setupOwnerInstanceId: null, lastErrorCode: null });
    expect(row?.encryptedSetupContext).toBeTruthy();
    expect(activation.activateAtomicAttempt).not.toHaveBeenCalled();
  });

  it("settles a claimed check as terminal and clears the candidate", async () => {
    const value = await setupFixture();
    const activation: FeishuBindingActivation = {
      checkCandidate: vi.fn(async () => ({ status: "terminal" as const, errorCode: "FEISHU_CREDENTIAL_INVALID" })),
      activateAtomicAttempt: vi.fn(),
    };
    const service = createService(value, { activation });
    const attempt = await insertAttempt(value, { nextCheckAt: setupNow });

    await expect(service.check(value.bootstrap.userId, attempt.attemptId)).resolves.toMatchObject({
      state: "failed",
      errorCode: "FEISHU_CREDENTIAL_INVALID",
    });
    expect(await rowForAttempt(attempt.attemptId)).toMatchObject({
      setupState: "failed",
      lastErrorCode: "FEISHU_CREDENTIAL_INVALID",
      encryptedSetupContext: null,
      setupExpiresAt: null,
    });
  });

  it("settles a claim the check itself reports as expired", async () => {
    const value = await setupFixture();
    const activation: FeishuBindingActivation = {
      // An activation-time expiry reaches the settle path as an outcome, not as a thrown error.
      checkCandidate: vi.fn(async () => {
        throw new FeishuCandidateExpiredError();
      }),
      activateAtomicAttempt: vi.fn(),
    };
    const service = createService(value, { activation });
    const attempt = await insertAttempt(value, { nextCheckAt: setupNow });

    await expect(service.check(value.bootstrap.userId, attempt.attemptId)).resolves.toMatchObject({
      state: "expired",
      errorCode: "FEISHU_SETUP_CANDIDATE_EXPIRED",
    });
    expect(await rowForAttempt(attempt.attemptId)).toMatchObject({
      setupState: "expired",
      encryptedSetupContext: null,
    });
  });

  it("names the failed outcome write before the check failure reaches the supervisor", async () => {
    const value = await setupFixture();
    const diagnostic = vi.fn();
    const activation: FeishuBindingActivation = {
      checkCandidate: vi.fn(async () => ({
        status: "waiting" as const,
        reason: "temporary_failure" as const,
        missingScopes: [],
      })),
      activateAtomicAttempt: vi.fn(),
    };
    // The claim succeeds, then only the settle write fails: the check completed but its outcome
    // could not be persisted, which is the narrower failure the diagnostic names.
    const service = createService(value, { activation, onDiagnostic: diagnostic });
    const attempt = await insertAttempt(value, { nextCheckAt: setupNow });
    const original = setupDatabase.database.update.bind(setupDatabase.database);
    // The claim update runs for real; the settle update is the one that fails.
    const update = vi
      .spyOn(setupDatabase.database, "update")
      .mockImplementationOnce((...args: Parameters<typeof original>) => original(...args))
      .mockImplementationOnce(() => {
        throw new Error("outcome write failed");
      });
    try {
      // The check completes and cannot report a result; the caller still receives the live attempt.
      await expect(service.check(value.bootstrap.userId, attempt.attemptId)).rejects.toThrow("outcome write failed");
    } finally {
      update.mockRestore();
    }
    expect(diagnostic).toHaveBeenCalledWith("FEISHU_SETUP_FAILURE_STATE_WRITE_FAILED");
  });

  it("leaves an undecryptable candidate the sweep cannot read", async () => {
    const value = await setupFixture();
    const foreignRing = new ApplicationCipher(Buffer.alloc(32, 11));
    const attempt = await insertAttempt(value);
    await setupDatabase.database
      .update(imBindings)
      .set({ encryptedSetupContext: foreignRing.encrypt("opaque") })
      .where(eq(imBindings.setupAttemptId, attempt.attemptId));
    const diagnostic = vi.fn();
    const sweeper = createService(value, { onDiagnostic: diagnostic });
    sweeper.start();
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith("FEISHU_SETUP_CONTEXT_UNREADABLE"));
    await sweeper.stop();
    expect(await rowForAttempt(attempt.attemptId)).toMatchObject({
      setupState: "pending_activation",
      setupOwnerInstanceId: null,
    });
  });

  it("fails a malformed and clears a lapsed candidate from the sweep", async () => {
    const value = await setupFixture();
    const malformed = await insertAttempt(value, { context: "malformed" });
    const sweeper = createService(value);
    sweeper.start();
    await vi.waitFor(async () => {
      expect((await rowForAttempt(malformed.attemptId))?.setupState).toBe("failed");
    });
    expect(await rowForAttempt(malformed.attemptId)).toMatchObject({
      lastErrorCode: "FEISHU_SETUP_CONTEXT_INVALID",
      encryptedSetupContext: null,
    });
    await sweeper.stop();

    const lapsed = await insertAttempt(value, { expiresAt: new Date(setupNow.getTime() - 1_000) });
    const second = createService(value);
    second.start();
    await vi.waitFor(async () => {
      expect((await rowForAttempt(lapsed.attemptId))?.setupState).toBe("expired");
    });
    expect(await rowForAttempt(lapsed.attemptId)).toMatchObject({
      lastErrorCode: "FEISHU_SETUP_CANDIDATE_EXPIRED",
      encryptedSetupContext: null,
    });
    await second.stop();
  });
});

describe("FeishuSetupService sweep of validating rows", () => {
  function sweeper(value: SetupFixture, options: { onDiagnostic?: (code: string) => void } = {}) {
    return new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: { start: vi.fn() },
      activation: {
        checkCandidate: vi.fn(async () => ({
          status: "waiting" as const,
          reason: "temporary_failure" as const,
          missingScopes: [],
        })),
        activateAtomicAttempt: vi.fn(),
      },
      timing: { checkIntervalMs: 0, checkJitterMs: 0, ownerHeartbeatMs: 10, ownerStaleMs: 60, sweepPageSize: 50 },
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
  }

  it("releases a stale claim and expires an undecryptable validating candidate", async () => {
    const value = await setupFixture();
    // A heartbeat old enough to be stale, so the sweep releases the claim back to a bounded wait.
    const stale = await insertAttempt(value, {
      state: "validating",
      owner: crypto.randomUUID(),
      heartbeatAt: new Date(Date.now() - 3_600_000),
    });
    const service = sweeper(value);
    service.start();
    await vi.waitFor(async () => {
      const row = await rowForAttempt(stale.attemptId);
      expect(row?.setupState).toBe("pending_activation");
      expect(row?.setupOwnerInstanceId).toBeNull();
    });
    await service.stop();

    // An undecryptable validating candidate past its deadline is expired, never released.
    const foreignRing = new ApplicationCipher(Buffer.alloc(32, 13));
    const unreadable = await insertAttempt(value, {
      state: "validating",
      owner: crypto.randomUUID(),
      heartbeatAt: new Date(Date.now() - 3_600_000),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await setupDatabase.database
      .update(imBindings)
      .set({ encryptedSetupContext: foreignRing.encrypt("opaque") })
      .where(eq(imBindings.setupAttemptId, unreadable.attemptId));
    const second = sweeper(value);
    second.start();
    await vi.waitFor(async () => {
      expect((await rowForAttempt(unreadable.attemptId))?.setupState).toBe("expired");
    });
    await second.stop();
  });

  it("fails a malformed validating row whose owner is gone", async () => {
    const value = await setupFixture();
    const attempt = await insertAttempt(value, {
      state: "validating",
      context: "malformed",
      owner: crypto.randomUUID(),
      heartbeatAt: new Date(Date.now() - 3_600_000),
    });
    const service = sweeper(value);
    service.start();
    await vi.waitFor(async () => {
      expect((await rowForAttempt(attempt.attemptId))?.setupState).toBe("failed");
    });
    expect(await rowForAttempt(attempt.attemptId)).toMatchObject({
      lastErrorCode: "FEISHU_SETUP_CONTEXT_INVALID",
      encryptedSetupContext: null,
    });
    await service.stop();
  });

  it("ends a live legacy QR validating row whose owner vanished", async () => {
    const value = await setupFixture();
    const attempt = await insertAttempt(value, {
      state: "validating",
      context: "qr",
      owner: crypto.randomUUID(),
      heartbeatAt: new Date(Date.now() - 3_600_000),
    });
    const service = sweeper(value);
    service.start();
    await vi.waitFor(async () => {
      expect((await rowForAttempt(attempt.attemptId))?.setupState).toBe("failed");
    });
    expect(await rowForAttempt(attempt.attemptId)).toMatchObject({
      lastErrorCode: "FEISHU_SETUP_OWNER_RESTARTED",
      encryptedSetupContext: null,
    });
    await service.stop();
  });

  it("expires an unreadable pending candidate from the sweep", async () => {
    const value = await setupFixture();
    const foreignRing = new ApplicationCipher(Buffer.alloc(32, 17));
    const attempt = await insertAttempt(value, { expiresAt: new Date(Date.now() - 1_000) });
    await setupDatabase.database
      .update(imBindings)
      .set({ encryptedSetupContext: foreignRing.encrypt("opaque") })
      .where(eq(imBindings.setupAttemptId, attempt.attemptId));
    const service = sweeper(value);
    service.start();
    await vi.waitFor(async () => {
      expect((await rowForAttempt(attempt.attemptId))?.setupState).toBe("expired");
    });
    await service.stop();
  });

  it("fails a malformed pending row from the sweep", async () => {
    const value = await setupFixture();
    const attempt = await insertAttempt(value, { context: "malformed" });
    const service = sweeper(value);
    service.start();
    await vi.waitFor(async () => {
      expect((await rowForAttempt(attempt.attemptId))?.setupState).toBe("failed");
    });
    expect(await rowForAttempt(attempt.attemptId)).toMatchObject({
      lastErrorCode: "FEISHU_SETUP_CONTEXT_INVALID",
      encryptedSetupContext: null,
    });
    await service.stop();
  });

  it("expires a lapsed pending candidate whose context this key ring cannot read", async () => {
    const value = await setupFixture();
    const attempt = await insertAttempt(value, { expiresAt: new Date(Date.now() - 1_000) });
    // An unauthenticatable context is never evidence about the candidate, but the fixed deadline
    // still governs it: the sweep expires the row without ever claiming it.
    await setupDatabase.database
      .update(imBindings)
      .set({ encryptedSetupContext: new ApplicationCipher(Buffer.alloc(32, 19)).encrypt("opaque") })
      .where(eq(imBindings.setupAttemptId, attempt.attemptId));
    const service = sweeper(value);
    service.start();
    await vi.waitFor(async () => {
      expect((await rowForAttempt(attempt.attemptId))?.setupState).toBe("expired");
    });
    await service.stop();
  });
});

/**
 * The read-only projection of a stored attempt. These four shapes are the ones a row can be in
 * without any write path producing them — a legacy QR context left behind on a state that requires a
 * candidate, a candidate past its deadline, and a validating row whose owner is gone — so they are
 * pinned here to show the reader still names a terminal outcome rather than reporting the raw state.
 */
describe("FeishuSetupService terminal projection", () => {
  it("names the terminal outcome of a stored attempt the reader cannot treat as live", async () => {
    const value = await setupFixture();
    const service = setupService(value);

    // A pending row carrying a legacy QR context can never become a candidate.
    const pendingQr = await insertAttempt(value, { state: "pending_activation", context: "qr" });
    await expect(service.get(value.bootstrap.userId, pendingQr.attemptId)).resolves.toMatchObject({
      state: "failed",
      errorCode: "FEISHU_SETUP_CONTEXT_INVALID",
      qrUrl: null,
    });

    // A validating candidate past its retention deadline reads as expired.
    const validatingLapsed = await insertAttempt(value, {
      state: "validating",
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(service.get(value.bootstrap.userId, validatingLapsed.attemptId)).resolves.toMatchObject({
      state: "expired",
      errorCode: "FEISHU_SETUP_CANDIDATE_EXPIRED",
    });

    // A validating context that authenticates but is not a candidate is terminally invalid.
    const validatingMalformed = await insertAttempt(value, { state: "validating", context: "malformed" });
    await expect(service.get(value.bootstrap.userId, validatingMalformed.attemptId)).resolves.toMatchObject({
      state: "failed",
      errorCode: "FEISHU_SETUP_CONTEXT_INVALID",
    });

    // A legacy QR validating row whose owner heartbeat is stale is a restart to every reader.
    const validatingQr = await insertAttempt(value, {
      state: "validating",
      context: "qr",
      owner: crypto.randomUUID(),
      heartbeatAt: new Date(Date.now() - 3_600_000),
    });
    await expect(service.get(value.bootstrap.userId, validatingQr.attemptId)).resolves.toMatchObject({
      state: "failed",
      errorCode: "FEISHU_SETUP_OWNER_RESTARTED",
    });
  });
});

describe("FeishuSetupService claim admission", () => {
  function service(
    value: SetupFixture,
    activation: FeishuBindingActivation,
    options: { onDiagnostic?: (code: string) => void } = {},
  ) {
    return new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: { start: vi.fn() },
      activation,
      timing: { checkIntervalMs: 0, checkJitterMs: 0, ownerHeartbeatMs: 10, ownerStaleMs: 60 },
      now: () => setupNow,
      random: () => 0,
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
  }

  it("releases the reservation when the claim CAS matches no row", async () => {
    const value = await setupFixture();
    const checkCandidate = vi.fn(async () => ({ status: "ready" }) as const);
    const activation: FeishuBindingActivation = { checkCandidate, activateAtomicAttempt: vi.fn() };
    const attempt = await insertAttempt(value, { nextCheckAt: setupNow });
    const instance = service(value, activation);
    // Another instance wins the claim between this one's read and its CAS: the update matches no row,
    // so no upstream work may start and the attempt keeps its bounded wait.
    const update = vi.spyOn(setupDatabase.database, "update").mockImplementationOnce(
      () =>
        ({
          set: () => ({ where: () => ({ returning: async () => [] }) }),
        }) as never,
    );
    try {
      await expect(instance.check(value.bootstrap.userId, attempt.attemptId)).resolves.toMatchObject({
        state: "pending_activation",
      });
    } finally {
      update.mockRestore();
    }
    expect(checkCandidate).not.toHaveBeenCalled();
    expect(await rowForAttempt(attempt.attemptId)).toMatchObject({ setupState: "pending_activation" });
  });

  it("releases a claim the service stopped holding while the claim update was in flight", async () => {
    const value = await setupFixture();
    const checkCandidate = vi.fn(async () => ({ status: "ready" }) as const);
    const activation: FeishuBindingActivation = { checkCandidate, activateAtomicAttempt: vi.fn() };
    const attempt = await insertAttempt(value, { nextCheckAt: setupNow });
    const instance = service(value, activation);
    // `check` returns once the claim update has been issued but before it resolves, so stopping here
    // lands exactly in the window between taking the claim and admitting the work it admits. A claim
    // that commits after shutdown must be handed back, never activated against a dying process.
    const pending = instance.check(value.bootstrap.userId, attempt.attemptId);
    await instance.stop();
    await pending;
    expect(activation.activateAtomicAttempt).not.toHaveBeenCalled();
    expect(checkCandidate).not.toHaveBeenCalled();
    expect(await rowForAttempt(attempt.attemptId)).toMatchObject({
      setupState: "pending_activation",
      setupOwnerInstanceId: null,
      setupOwnerHeartbeatAt: null,
      encryptedSetupContext: expect.any(String),
    });
  });
});

/**
 * A registration that fails while the setup attempt is still `awaiting_user` must be recorded as a
 * terminal attempt. If that write itself fails, the attempt must not be lost silently: the detach
 * path names the failed state write so the supervisor can count it.
 */
describe("FeishuSetupService registration failure", () => {
  it("names a failed terminal-state write after the registration itself failed", async () => {
    const value = await setupFixture();
    const diagnostic = vi.fn();
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<never>((_resolve, reject) => {
      rejectResult = reject;
    });
    const service = new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: {
        start: vi.fn(() => ({
          qrReady: Promise.resolve({ url: "https://feishu.example/qr", expiresAt: new Date(Date.now() + 60_000) }),
          result,
          abort: vi.fn(),
        })),
      },
      activation: { activateAtomicAttempt: vi.fn() },
      onDiagnostic: diagnostic,
    });
    const attempt = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    // The registration fails and the terminal write for it fails too: the attempt survives and the
    // failure is reported rather than swallowed.
    const update = vi.spyOn(setupDatabase.database, "update").mockImplementation(() => {
      throw new Error("state write failed");
    });
    try {
      rejectResult(Object.assign(new Error("denied"), { code: "access_denied" }));
      await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith("FEISHU_SETUP_FAILURE_STATE_WRITE_FAILED"));
    } finally {
      update.mockRestore();
    }
    expect(await rowForAttempt(attempt.id)).toMatchObject({ setupState: "awaiting_user" });
    await service.stop();
  });
});

describe("FeishuSetupService claim admission", () => {
  it("surfaces a claim that fails in the database and releases the reservation", async () => {
    const value = await setupFixture();
    const checkCandidate = vi.fn(async () => ({ status: "ready" }) as const);
    const service = new FeishuSetupService({
      database: setupDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      registrations: { start: vi.fn() },
      activation: { checkCandidate, activateAtomicAttempt: vi.fn() },
      timing: { checkIntervalMs: 0, checkJitterMs: 0, ownerHeartbeatMs: 10, ownerStaleMs: 60 },
      now: () => setupNow,
      random: () => 0,
    });
    const attempt = await insertAttempt(value, { nextCheckAt: setupNow });
    // The claim write fails, so no upstream work may run and the caller must see the failure.
    const update = vi.spyOn(setupDatabase.database, "update").mockImplementationOnce(() => {
      throw new Error("claim write failed");
    });
    try {
      await expect(service.check(value.bootstrap.userId, attempt.attemptId)).rejects.toThrow("claim write failed");
    } finally {
      update.mockRestore();
    }
    expect(checkCandidate).not.toHaveBeenCalled();
    expect(await rowForAttempt(attempt.attemptId)).toMatchObject({ setupState: "pending_activation" });
    await service.stop();
  });
});
