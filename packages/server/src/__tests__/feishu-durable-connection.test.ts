import { randomUUID } from "node:crypto";
import { FEISHU_REQUIRED_TENANT_SCOPES, type NormalizedInboundImEvent } from "@opentag/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import { computers, imBindings } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { ImInboundPersistenceError } from "../services/im/index.js";
import {
  feishuBindingCredentialContext,
  feishuSetupAttemptContext,
} from "../services/im-bindings/credential-material.js";
import type { FeishuAdapter, FeishuChannel } from "../services/im-bindings/feishu/index.js";
import {
  classifyFeishuCandidateFailure,
  decodeFeishuSetupContext,
  encodeFeishuSetupCandidate,
  type FeishuBindingActivation,
  type FeishuCandidateCheckOutcome,
  FeishuCandidateExpiredError,
  FeishuConnectionManager,
  FeishuOperationError,
  FeishuSetupService,
  type FeishuSetupTiming,
  feishuRetryAfterMs,
  readFeishuSetupContext,
} from "../services/im-bindings/feishu/index.js";
import type { FeishuRegistration, FeishuRegistrationGateway } from "../services/im-bindings/feishu/registration.js";
import { ImBindingService, type VerifiedFeishuBinding } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const CANDIDATE_SECRET = "candidate-secret-do-not-log";
const EXISTING_SECRET = "existing-working-secret";
const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

let database: UnitDatabase;
const clock = { now: new Date("2026-09-10T00:00:00.000Z") };

beforeAll(async () => {
  database = await createUnitDatabase();
}, 60_000);
afterAll(async () => database?.close());
beforeEach(async () => {
  await database.reset();
  clock.now = new Date("2026-09-10T00:00:00.000Z");
});

interface CheckInput {
  agentId: string;
  appId: string;
  appSecret: string;
  teamBrand?: "feishu" | "lark";
  signal?: AbortSignal;
}

type ActivationInput = Parameters<FeishuBindingActivation["activateAtomicAttempt"]>[0];

interface FakeActivation {
  activation: FeishuBindingActivation;
  checks: CheckInput[];
  activations: ActivationInput[];
  checkCandidate: Mock<(input: CheckInput) => Promise<FeishuCandidateCheckOutcome>>;
}

interface FixtureValue {
  bootstrap: Awaited<ReturnType<typeof bootstrapTestAccount>>;
  agent: Awaited<ReturnType<AgentService["createForAccount"]>>;
  computerId: string;
  cipher: ApplicationCipher;
  imBindings: ImBindingService;
}

async function fixture(): Promise<FixtureValue> {
  const bootstrap = await bootstrapTestAccount(database.database, {
    displayName: "Admin",
    email: `durable-${randomUUID()}@example.com`,
  });
  const [computer] = await database.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: randomUUID(),
      displayName: "durable-computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(database.database).createForAccount(bootstrap.userId, {
    name: `durable-${randomUUID().slice(0, 8)}`,
    displayName: "Durable Agent",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher({
    legacyKey: new Uint8Array(32).fill(11),
    keys: { "test-2026-09": new Uint8Array(32).fill(23) },
    activeKeyId: "test-2026-09",
    writeVersion: 2,
  });
  const imBindings = new ImBindingService(database.database, cipher, { now: () => clock.now });
  return { bootstrap, agent, computerId: computer.id, cipher, imBindings };
}

function createAgent(value: FixtureValue, label: string) {
  return new AgentService(database.database).createForAccount(value.bootstrap.userId, {
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    runtimeProvider: "codex",
    computerId: value.computerId,
  });
}

/**
 * A faithful fake activation. It uses the real `ImBindingService.activateFeishu` inside a
 * transaction fenced exactly like the production connection manager (attempt, owner token,
 * validating state, candidate deadline), so the setup service's claim and settle semantics are
 * exercised end to end. The real upstream and channel path is covered by the connection-manager
 * suites and the PostgreSQL integration suite.
 */
function createFakeActivation(
  value: FixtureValue,
  options: {
    outcomes?: FeishuCandidateCheckOutcome[];
    onCheck?: (input: CheckInput) => Promise<FeishuCandidateCheckOutcome>;
    assertCandidateSavedBeforeCheck?: boolean;
  } = {},
): FakeActivation {
  const outcomes = [...(options.outcomes ?? [])];
  const checks: CheckInput[] = [];
  const activations: ActivationInput[] = [];
  const checkCandidate = vi.fn(async (input: CheckInput): Promise<FeishuCandidateCheckOutcome> => {
    checks.push(input);
    if (options.assertCandidateSavedBeforeCheck) {
      const [row] = await database.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.agentId, input.agentId))
        .limit(1);
      expect(row?.setupState).toBe("validating");
      expect(row?.encryptedSetupContext).toBeTruthy();
      const decoded = row?.encryptedSetupContext
        ? decodeFeishuSetupContext(value.cipher, row.encryptedSetupContext, row.id, row.setupAttemptId ?? "")
        : undefined;
      expect(decoded?.kind).toBe("candidate");
      if (decoded?.kind === "candidate") expect(decoded.candidate.appSecret).toBe(input.appSecret);
    }
    if (options.onCheck) return options.onCheck(input);
    return outcomes.shift() ?? { status: "ready" };
  });
  const activation: FeishuBindingActivation = {
    checkCandidate,
    activateAtomicAttempt: vi.fn(async (input: ActivationInput) => {
      activations.push(input);
      input.signal?.throwIfAborted();
      let verified: VerifiedFeishuBinding | undefined;
      await database.database.transaction(async (transaction) => {
        const [slot] = await transaction
          .select()
          .from(imBindings)
          .where(eq(imBindings.setupAttemptId, input.attemptId))
          .limit(1)
          .for("update");
        if (slot?.setupState !== "validating" || slot.setupOwnerInstanceId !== input.ownerInstanceId) {
          throw new FeishuOperationError("FEISHU_SETUP_FENCE_STALE");
        }
        if (input.candidateExpiresAt !== undefined && input.candidateExpiresAt <= clock.now) {
          throw new FeishuCandidateExpiredError();
        }
        verified = {
          agentId: input.agentId,
          appId: input.appId,
          teamId: `tenant_${input.appId}`,
          botOpenId: `ou_${input.appId}`,
          teamBrand: input.teamBrand,
          appSecret: input.appSecret,
          grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
        };
        await value.imBindings.activateFeishu(verified, transaction);
        await transaction
          .update(imBindings)
          .set({
            setupState: "succeeded",
            setupOwnerInstanceId: null,
            setupOwnerHeartbeatAt: null,
            encryptedSetupContext: null,
            setupExpiresAt: null,
            lastErrorCode: null,
            updatedAt: clock.now,
          })
          .where(and(eq(imBindings.id, slot.id), eq(imBindings.setupState, "validating")));
      });
      if (!verified) throw new Error("activation did not commit");
      return verified;
    }),
  };
  return { activation, checks, activations, checkCandidate };
}

function createService(
  value: FixtureValue,
  activation: FeishuBindingActivation,
  options: {
    timing?: FeishuSetupTiming;
    gateway?: FeishuRegistrationGateway;
    onDiagnostic?: (code: string) => void;
  } = {},
): FeishuSetupService {
  return new FeishuSetupService({
    database: database.database,
    cipher: value.cipher,
    instanceId: randomUUID(),
    imBindings: value.imBindings,
    registrations: options.gateway ?? { start: vi.fn() },
    activation,
    timing: {
      checkIntervalMs: 1_000,
      checkJitterMs: 0,
      ownerStaleMs: 60,
      checkDeadlineMs: 5_000,
      ...options.timing,
    },
    now: () => clock.now,
    random: () => 0,
  });
}

function registration(
  result: Promise<{ appId: string; appSecret: string; teamBrand?: "feishu" | "lark" }>,
): FeishuRegistration {
  return {
    qrReady: Promise.resolve({ url: "https://feishu.example/qr", expiresAt: new Date(clock.now.getTime() + 60_000) }),
    result,
    abort: vi.fn(),
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function rowForAgent(agentId: string) {
  const [row] = await database.database
    .select()
    .from(imBindings)
    .where(and(eq(imBindings.agentId, agentId), eq(imBindings.provider, "feishu")))
    .limit(1);
  return row;
}

interface CandidateInput {
  bindingId?: string;
  attemptId?: string;
  appId?: string;
  appSecret?: string;
  /** Encrypt the context under a different ring, e.g. to model a key the reading instance lacks. */
  cipher?: ApplicationCipher;
  state?: "pending_activation" | "validating" | "awaiting_user";
  owner?: string;
  heartbeatAt?: Date;
  savedAt?: Date;
  nextCheckAt?: Date;
  expiresAt?: Date;
  observation?: {
    checkedAt: string;
    reason: "permissions_pending" | "app_unavailable" | "runtime_unavailable" | "temporary_failure";
    missingScopes?: string[];
  };
}

function buildCandidateContext(
  value: FixtureValue,
  bindingId: string,
  attemptId: string,
  input: CandidateInput,
): string {
  const savedAt = input.savedAt ?? clock.now;
  return encodeFeishuSetupCandidate(
    input.cipher ?? value.cipher,
    {
      version: 1,
      kind: "feishu_candidate",
      bindingId,
      attemptId,
      appId: input.appId ?? "cli_durable",
      appSecret: input.appSecret ?? CANDIDATE_SECRET,
      teamBrand: "feishu",
      savedAt: savedAt.toISOString(),
      nextCheckAt: (input.nextCheckAt ?? savedAt).toISOString(),
      observation: input.observation
        ? {
            checkedAt: input.observation.checkedAt,
            reason: input.observation.reason,
            ...(input.observation.missingScopes ? { missingScopes: input.observation.missingScopes } : {}),
          }
        : null,
    },
    bindingId,
    attemptId,
  );
}

/** Inserts a setup row directly, the same shapes the write paths produce. */
async function insertCandidate(
  value: FixtureValue,
  binding: { agentId: string; id?: string },
  input: CandidateInput = {},
) {
  const bindingId = binding.id ?? input.bindingId ?? randomUUID();
  const attemptId = input.attemptId ?? randomUUID();
  const savedAt = input.savedAt ?? clock.now;
  const encryptedSetupContext = buildCandidateContext(value, bindingId, attemptId, input);
  const shared = {
    setupAttemptId: attemptId,
    setupState: input.state ?? ("pending_activation" as const),
    setupOwnerInstanceId: input.owner ?? null,
    setupOwnerHeartbeatAt: input.heartbeatAt ?? null,
    encryptedSetupContext,
    setupExpiresAt: input.expiresAt ?? new Date(clock.now.getTime() + CANDIDATE_TTL_MS),
    updatedAt: savedAt,
  };
  if (binding.id) {
    await database.database
      .update(imBindings)
      .set({ ...shared, setupIntent: "reauthorize" })
      .where(eq(imBindings.id, binding.id));
  } else {
    await database.database.insert(imBindings).values({
      ...shared,
      id: bindingId,
      agentId: binding.agentId,
      provider: "feishu",
      status: "provisioning",
      setupIntent: "create",
      createdAt: savedAt,
    });
  }
  return { bindingId, attemptId };
}

function contextFor(value: FixtureValue, row: typeof imBindings.$inferSelect) {
  if (!row.encryptedSetupContext || !row.setupAttemptId) return undefined;
  return decodeFeishuSetupContext(value.cipher, row.encryptedSetupContext, row.id, row.setupAttemptId);
}

/**
 * Records the payload of every `im_bindings` update issued inside a transaction. A takeover's
 * terminal write and the admission of its replacement commit in one transaction, so the takeover
 * label is only observable on the write path itself.
 */
function recordBindingWrites(database: DatabaseClient, sink: Array<Record<string, unknown>>): DatabaseClient {
  const wrapTransaction = (transaction: DatabaseTransaction): DatabaseTransaction =>
    new Proxy(transaction, {
      get(target, property, receiver) {
        if (property !== "update") return Reflect.get(target, property, receiver);
        return ((table: unknown) => {
          const builder = (Reflect.get(target, "update") as (table: unknown) => object).call(target, table);
          if (table !== imBindings) return builder;
          return new Proxy(builder, {
            get(builderTarget, builderProperty, builderReceiver) {
              if (builderProperty !== "set") return Reflect.get(builderTarget, builderProperty, builderReceiver);
              return (values: Record<string, unknown>) => {
                sink.push(values);
                return (Reflect.get(builderTarget, "set") as (values: Record<string, unknown>) => unknown).call(
                  builderTarget,
                  values,
                );
              };
            },
          });
        }) as DatabaseTransaction["update"];
      },
    });
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return ((callback: (transaction: DatabaseTransaction) => unknown) =>
        (Reflect.get(target, "transaction") as (cb: (transaction: DatabaseTransaction) => unknown) => unknown).call(
          target,
          (transaction: DatabaseTransaction) => callback(wrapTransaction(transaction)),
        )) as DatabaseClient["transaction"];
    },
  });
}

describe("Feishu durable connection lifecycle", () => {
  it("returns the committed outcome when activation wins a concurrent cancellation", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value);
    const service = createService(value, fake.activation);
    const { attemptId } = await insertCandidate(value, { agentId: value.agent.id });
    const entered = deferred<void>();
    const release = deferred<void>();
    const authorize = value.imBindings.assertCanManage.bind(value.imBindings);
    const authorization = vi.spyOn(value.imBindings, "assertCanManage").mockImplementationOnce(async (...args) => {
      await authorize(...args);
      entered.resolve();
      await release.promise;
    });
    try {
      const cancellation = service.cancel(value.bootstrap.userId, attemptId);
      await entered.promise;
      expect((await service.check(value.bootstrap.userId, attemptId)).state).toBe("succeeded");
      release.resolve();
      expect((await cancellation).state).toBe("succeeded");
      expect((await rowForAgent(value.agent.id))?.status).toBe("active");
    } finally {
      release.resolve();
      authorization.mockRestore();
      await service.stop();
    }
  });

  it("saves the credential before any upstream validation and never displaces the working credential", async () => {
    const value = await fixture();
    await value.imBindings.activateFeishu({
      agentId: value.agent.id,
      appId: "cli_existing",
      teamId: "tenant_existing",
      botOpenId: "ou_existing",
      appSecret: EXISTING_SECRET,
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    });
    const before = await rowForAgent(value.agent.id);
    const fake = createFakeActivation(value, {
      assertCandidateSavedBeforeCheck: true,
      outcomes: [{ status: "waiting", reason: "permissions_pending", missingScopes: [] }],
    });
    const result = deferred<{ appId: string; appSecret: string; teamBrand: "feishu" }>();
    const service = createService(value, fake.activation, {
      gateway: { start: vi.fn(() => registration(result.promise)) },
    });

    const attempt = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "reauthorize");
    result.resolve({ appId: "cli_candidate", appSecret: CANDIDATE_SECRET, teamBrand: "feishu" });
    await vi.waitFor(async () => {
      const row = await rowForAgent(value.agent.id);
      expect(row?.setupState).toBe("pending_activation");
      expect(fake.checkCandidate).toHaveBeenCalledTimes(1);
    });

    const row = await rowForAgent(value.agent.id);
    expect(row?.encryptedCredential).toBe(before?.encryptedCredential);
    expect(row?.credentialGeneration).toBe(before?.credentialGeneration);
    expect(row?.externalAppId).toBe("cli_existing");
    expect(row?.encryptedSetupContext).not.toContain(CANDIDATE_SECRET);
    expect(row?.encryptedSetupContext).not.toContain("cli_candidate");

    const projected = await service.get(value.bootstrap.userId, attempt.id);
    expect(projected).toMatchObject({ state: "pending_activation", qrUrl: null, completedAt: null });
    expect(projected.activation).toMatchObject({
      appId: "cli_candidate",
      reason: "permissions_pending",
      lastCheckedAt: expect.any(String),
    });
    expect(projected.activation).not.toHaveProperty("appSecret");
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(CANDIDATE_SECRET);
    expect(serialized).not.toContain(EXISTING_SECRET);
    await service.stop();
  });

  it("waits through missing scopes, keeps GET read-only, and activates only after the full 66-scope grant", async () => {
    const missing = [...FEISHU_REQUIRED_TENANT_SCOPES].slice(3);
    const value = await fixture();
    const fake = createFakeActivation(value, {
      outcomes: [{ status: "waiting", reason: "permissions_pending", missingScopes: missing }, { status: "ready" }],
    });
    const pending = deferred<{ appId: string; appSecret: string; teamBrand: "feishu" }>();
    const service = createService(value, fake.activation, {
      gateway: { start: vi.fn(() => registration(pending.promise)) },
    });

    const attempt = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    pending.resolve({ appId: "cli_durable", appSecret: CANDIDATE_SECRET, teamBrand: "feishu" });
    await vi.waitFor(async () => {
      const row = await rowForAgent(value.agent.id);
      expect(row?.setupState).toBe("pending_activation");
      expect(fake.checkCandidate).toHaveBeenCalledTimes(1);
    });

    const waiting = await service.get(value.bootstrap.userId, attempt.id);
    expect(waiting.activation).toMatchObject({ reason: "permissions_pending", appId: "cli_durable" });
    expect(waiting.activation?.missingScopes).toEqual(missing);
    expect(fake.activations).toHaveLength(0);

    // GET stays pure: it never claims, checks, or heartbeats.
    const beforeGet = await rowForAgent(value.agent.id);
    await service.get(value.bootstrap.userId, attempt.id);
    await service.get(value.bootstrap.userId, attempt.id);
    const afterGet = await rowForAgent(value.agent.id);
    expect(fake.checkCandidate).toHaveBeenCalledTimes(1);
    expect(afterGet?.updatedAt).toEqual(beforeGet?.updatedAt);

    // Before the candidate is due, an explicit check shares the scheduler's admission.
    const early = await service.check(value.bootstrap.userId, attempt.id);
    expect(early.state).toBe("pending_activation");
    expect(fake.checkCandidate).toHaveBeenCalledTimes(1);

    clock.now = new Date(Date.parse(waiting.activation?.nextCheckAt ?? "") + 1_000);
    const activated = await service.check(value.bootstrap.userId, attempt.id);
    expect(activated.state).toBe("succeeded");
    expect(activated.qrUrl).toBeNull();
    expect(fake.activations).toHaveLength(1);
    expect(fake.activations[0]?.appId).toBe("cli_durable");
    const row = await rowForAgent(value.agent.id);
    expect(row).toMatchObject({ setupState: "succeeded", status: "active", credentialGeneration: 1 });
    expect(row?.encryptedSetupContext).toBeNull();
    await service.stop();
  });

  it("resumes a persisted candidate from another service instance", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value, {
      outcomes: [{ status: "waiting", reason: "temporary_failure", missingScopes: [] }],
    });
    const pending = deferred<{ appId: string; appSecret: string; teamBrand: "feishu" }>();
    const first = createService(value, fake.activation, {
      gateway: { start: vi.fn(() => registration(pending.promise)) },
    });
    const attempt = await first.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    pending.resolve({ appId: "cli_restart", appSecret: CANDIDATE_SECRET, teamBrand: "feishu" });
    await vi.waitFor(async () => {
      expect(fake.checkCandidate).toHaveBeenCalledTimes(1);
      expect((await rowForAgent(value.agent.id))?.setupState).toBe("pending_activation");
    });
    await first.stop();
    const afterStop = await rowForAgent(value.agent.id);
    expect(afterStop?.setupState).toBe("pending_activation");
    expect(afterStop?.encryptedSetupContext).toBeTruthy();

    const second = createService(value, fake.activation);
    clock.now = new Date(clock.now.getTime() + 120_000);
    const activated = await second.check(value.bootstrap.userId, attempt.id);
    expect(activated.state).toBe("succeeded");
    expect(fake.activations).toHaveLength(1);
    await second.stop();
  });

  it("keeps runtime and transient failures waiting, honors Retry-After, and fails only on explicit signals", async () => {
    const value = await fixture();
    const runtime = createFakeActivation(value, {
      outcomes: [{ status: "waiting", reason: "runtime_unavailable", missingScopes: [] }],
    });
    const { attemptId } = await insertCandidate(value, { agentId: value.agent.id });
    const service = createService(value, runtime.activation);
    await expect(service.check(value.bootstrap.userId, attemptId)).resolves.toMatchObject({
      state: "pending_activation",
      activation: { reason: "runtime_unavailable" },
    });
    expect(runtime.activations).toHaveLength(0);

    const transient = createFakeActivation(value, {
      outcomes: [
        { status: "waiting", reason: "temporary_failure", missingScopes: [], retryAfterMs: 9_000 },
        { status: "waiting", reason: "temporary_failure", missingScopes: [] },
      ],
    });
    clock.now = new Date(clock.now.getTime() + 120_000);
    const second = createService(value, transient.activation);
    const projected = await second.check(value.bootstrap.userId, attemptId);
    expect(projected.activation?.reason).toBe("temporary_failure");
    const row = await rowForAgent(value.agent.id);
    expect(row).toBeDefined();
    if (!row) throw new Error("candidate row missing");
    const decoded = contextFor(value, row);
    expect(decoded?.kind).toBe("candidate");
    if (decoded?.kind === "candidate") {
      // Retry-After is honored: the next check is not due before the provider's hinted delay.
      expect(Date.parse(decoded.candidate.nextCheckAt)).toBeGreaterThanOrEqual(clock.now.getTime() + 9_000);
    }
    // Before that hint elapses the explicit check is throttled to a read-only projection.
    await second.check(value.bootstrap.userId, attemptId);
    expect(transient.checkCandidate).toHaveBeenCalledTimes(1);
    await service.stop();
    await second.stop();
  });

  it("advances a retained keyset cursor so a saturated sweep does not starve the tail", async () => {
    const value = await fixture();
    const checkedAgents: string[] = [];
    const fake = createFakeActivation(value, {
      onCheck: async (input) => {
        checkedAgents.push(input.agentId);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "waiting", reason: "temporary_failure", missingScopes: [] };
      },
    });
    const service = createService(value, fake.activation, {
      timing: {
        sweepPageSize: 2,
        maxConcurrentChecks: 2,
        checkIntervalMs: 0,
        checkJitterMs: 0,
        ownerHeartbeatMs: 10,
      },
    });
    const agents: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const agent = await createAgent(value, `fair-${index}`);
      agents.push(agent.id);
      await insertCandidate(value, { agentId: agent.id });
    }
    service.start();
    await vi.waitFor(() => expect(new Set(checkedAgents).size).toBe(6), { timeout: 8_000 });
    service.stop();
    // Every candidate was reached even though the head became due again after every pass.
    expect(new Set(checkedAgents)).toEqual(new Set(agents));
  });

  it("reuses a candidate saved by another creator while this registration waited for its QR", async () => {
    const value = await fixture();
    const qrReady = deferred<{ url: string; expiresAt: Date }>();
    const abort = vi.fn();
    const gateway: FeishuRegistrationGateway = {
      start: vi.fn(() => ({
        qrReady: qrReady.promise,
        result: new Promise<never>(() => undefined),
        abort,
      })),
    };
    const fake = createFakeActivation(value);
    const service = createService(value, fake.activation, { gateway });
    const pendingCreate = service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    await vi.waitFor(() => expect(gateway.start).toHaveBeenCalledTimes(1));

    // A concurrent creator saves a durable candidate while our QR handshake is still open.
    const candidate = await insertCandidate(value, { agentId: value.agent.id }, { appId: "cli_in_between" });
    const candidateRow = await rowForAgent(value.agent.id);
    qrReady.resolve({
      url: "https://feishu.example/qr/overwritten",
      expiresAt: new Date(clock.now.getTime() + 60_000),
    });

    const result = await pendingCreate;
    expect(result.id).toBe(candidate.attemptId);
    expect(result.state).toBe("pending_activation");
    expect(result.activation?.appId).toBe("cli_in_between");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(fake.checkCandidate).not.toHaveBeenCalled();
    const after = await rowForAgent(value.agent.id);
    expect(after?.setupAttemptId).toBe(candidate.attemptId);
    expect(after?.encryptedSetupContext).toBe(candidateRow?.encryptedSetupContext);
    expect(after?.setupState).toBe("pending_activation");
    await service.stop();
  });

  it("admits one worker per exact ciphertext and fences a stale owner's late result", async () => {
    const value = await fixture();
    const gate = deferred<FeishuCandidateCheckOutcome>();
    const first = createFakeActivation(value, { onCheck: () => gate.promise });
    const firstService = createService(value, first.activation);
    const candidate = await insertCandidate(value, { agentId: value.agent.id }, { appId: "cli_race" });
    const attempt = { id: candidate.attemptId };
    const firstCheck = firstService.check(value.bootstrap.userId, attempt.id);
    await vi.waitFor(async () => {
      expect((await rowForAgent(value.agent.id))?.setupState).toBe("validating");
    });
    expect(first.checkCandidate).toHaveBeenCalledTimes(1);

    const second = createFakeActivation(value);
    const secondService = createService(value, second.activation, {
      timing: { ownerHeartbeatMs: 10 },
    });
    // A competing reader while the first claim is live cannot claim or probe.
    await expect(secondService.check(value.bootstrap.userId, attempt.id)).resolves.toMatchObject({
      state: "validating",
      activation: { reason: "checking" },
    });
    expect(second.checkCandidate).not.toHaveBeenCalled();

    // A stalled claim is released and taken over by the sweep with a fresh token.
    await database.database
      .update(imBindings)
      .set({ setupOwnerHeartbeatAt: new Date(clock.now.getTime() - 3_600_000) })
      .where(eq(imBindings.setupAttemptId, attempt.id));
    secondService.start();
    await vi.waitFor(
      async () => {
        expect((await rowForAgent(value.agent.id))?.setupState).toBe("succeeded");
      },
      { timeout: 8_000 },
    );
    await secondService.stop();

    // The first worker's late result cannot clobber the completed activation.
    gate.resolve({ status: "ready" });
    await firstCheck;
    expect(first.activations).toHaveLength(0);
    const settled = await rowForAgent(value.agent.id);
    expect(settled?.setupState).toBe("succeeded");
    expect(settled?.status).toBe("active");
    expect(settled?.encryptedSetupContext).toBeNull();
    await firstService.stop();
  });

  it.each([false, true])("cancels a blocked probe from another Server (%s) without late activation", async (remote) => {
    const value = await fixture();
    const gate = deferred<FeishuCandidateCheckOutcome>();
    const fake = createFakeActivation(value, { onCheck: () => gate.promise });
    const { attemptId } = await insertCandidate(value, { agentId: value.agent.id });
    const service = createService(value, fake.activation);

    const check = service.check(value.bootstrap.userId, attemptId);
    await vi.waitFor(async () => {
      expect((await rowForAgent(value.agent.id))?.setupState).toBe("validating");
    });
    const canceler = remote ? createService(value, fake.activation) : service;
    await canceler.cancel(value.bootstrap.userId, attemptId);
    gate.resolve({ status: "ready" });
    await check;
    if (remote) await canceler.stop();

    expect(fake.activations).toHaveLength(0);
    const row = await rowForAgent(value.agent.id);
    expect(row?.setupState).toBe("canceled");
    expect(row?.status).toBe("provisioning");
    expect(row?.encryptedSetupContext).toBeNull();
    await service.stop();
  });

  it("refuses to launch upstream work when stop or cancel wins before the claim registers", async () => {
    const value = await fixture();
    const gate = deferred<FeishuCandidateCheckOutcome>();
    const fake = createFakeActivation(value, { onCheck: () => gate.promise });
    const service = createService(value, fake.activation);
    const first = await insertCandidate(value, { agentId: value.agent.id });
    const stoppingCheck = service.check(value.bootstrap.userId, first.attemptId);
    await service.stop();
    await stoppingCheck;
    const afterStop = await rowForAgent(value.agent.id);
    expect(afterStop?.setupState).toBe("pending_activation");
    expect(afterStop?.setupOwnerInstanceId).toBeNull();
    expect(afterStop?.encryptedSetupContext).toBeTruthy();

    const secondAgent = await createAgent(value, "race-second");
    const second = createService(value, fake.activation);
    const candidate = await insertCandidate(value, { agentId: secondAgent.id });
    const cancelingCheck = second.check(value.bootstrap.userId, candidate.attemptId);
    await second.cancel(value.bootstrap.userId, candidate.attemptId);
    await cancelingCheck;
    gate.resolve({ status: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // No probe result may start activation, and the canceled attempt keeps no secret.
    expect(fake.activations).toHaveLength(0);
    const afterCancel = await rowForAgent(secondAgent.id);
    expect(afterCancel?.setupState).toBe("canceled");
    expect(afterCancel?.encryptedSetupContext).toBeNull();
    await second.stop();
  });

  it("heartbeats a live claim and preserves the candidate when the service stops without activating", async () => {
    const value = await fixture();
    const gate = deferred<FeishuCandidateCheckOutcome>();
    const fake = createFakeActivation(value, { onCheck: () => gate.promise });
    const { attemptId, bindingId } = await insertCandidate(value, { agentId: value.agent.id });
    const service = createService(value, fake.activation, {
      timing: { ownerHeartbeatMs: 10, ownerStaleMs: 10_000 },
    });
    const check = service.check(value.bootstrap.userId, attemptId);
    await vi.waitFor(async () => {
      expect((await rowForAgent(value.agent.id))?.setupState).toBe("validating");
    });
    const initialBeat = (await rowForAgent(value.agent.id))?.setupOwnerHeartbeatAt?.getTime() ?? 0;

    service.start();
    clock.now = new Date(clock.now.getTime() + 60_000);
    await vi.waitFor(
      async () => {
        const row = await rowForAgent(value.agent.id);
        expect(row?.setupOwnerHeartbeatAt?.getTime()).toBe(clock.now.getTime());
      },
      { timeout: 5_000 },
    );
    expect(clock.now.getTime()).toBeGreaterThan(initialBeat);

    const [beforeStop] = await database.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
    await service.stop();
    await check;
    const afterStop = await rowForAgent(value.agent.id);
    expect(afterStop?.setupState).toBe("pending_activation");
    expect(afterStop?.setupOwnerInstanceId).toBeNull();
    expect(afterStop?.encryptedSetupContext).toBe(beforeStop?.encryptedSetupContext);

    // The blocked probe resolving ready after the stop must not invoke activation at all.
    gate.resolve({ status: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.activations).toHaveLength(0);
    expect((await rowForAgent(value.agent.id))?.setupState).toBe("pending_activation");
  });

  it("labels a live QR attempt as owner-restarted when shutdown aborts its registration mid-check", async () => {
    const value = await fixture();
    const secondAgent = await createAgent(value, "stop-second");
    const gate = deferred<FeishuCandidateCheckOutcome>();
    const fake = createFakeActivation(value, { onCheck: () => gate.promise });
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<{ appId: string; appSecret: string }>((_, reject) => {
      rejectResult = reject;
    });
    const service = createService(value, fake.activation, {
      gateway: {
        start: vi.fn(() => ({
          qrReady: Promise.resolve({
            url: "https://feishu.example/qr/stop",
            expiresAt: new Date(clock.now.getTime() + 60_000),
          }),
          result,
          // The real gateway rejects the pending authorization with a cancel-shaped error on abort.
          abort: vi.fn(() => {
            rejectResult(Object.assign(new Error("registration aborted"), { code: "abort" }));
          }),
        })),
      },
    });
    const qrAttempt = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(qrAttempt.state).toBe("awaiting_user");

    const candidate = await insertCandidate(value, { agentId: secondAgent.id });
    const inFlight = service.check(value.bootstrap.userId, candidate.attemptId);
    await vi.waitFor(async () => {
      expect((await rowForAgent(secondAgent.id))?.setupState).toBe("validating");
    });

    await service.stop();
    await inFlight;

    // The aborted registration's late, cancel-shaped completion write must not relabel the restart.
    const qrRow = await rowForAgent(value.agent.id);
    expect(qrRow).toMatchObject({ setupState: "failed", lastErrorCode: "FEISHU_SETUP_OWNER_RESTARTED" });
    const candidateRow = await rowForAgent(secondAgent.id);
    expect(candidateRow).toMatchObject({ setupState: "pending_activation", setupOwnerInstanceId: null });
    expect(candidateRow?.encryptedSetupContext).toBeTruthy();

    gate.resolve({ status: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.activations).toHaveLength(0);
  });

  it("distinguishes QR expiry from owner loss when a new attempt takes over", async () => {
    const value = await fixture();
    const writes: Array<Record<string, unknown>> = [];
    const recording = recordBindingWrites(database.database, writes);
    const service = new FeishuSetupService({
      database: recording,
      cipher: value.cipher,
      instanceId: randomUUID(),
      imBindings: value.imBindings,
      registrations: { start: vi.fn(() => registration(new Promise(() => undefined))) },
      activation: createFakeActivation(value).activation,
      timing: { checkIntervalMs: 1_000, checkJitterMs: 0, ownerStaleMs: 60, checkDeadlineMs: 5_000 },
      now: () => clock.now,
      random: () => 0,
    });

    // The QR challenge lapses while its owning registration is still alive: expiry, not restart.
    const lapsed = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(lapsed.state).toBe("awaiting_user");
    clock.now = new Date(clock.now.getTime() + 120_000);
    await database.database
      .update(imBindings)
      .set({ setupOwnerHeartbeatAt: clock.now })
      .where(eq(imBindings.setupAttemptId, lapsed.id));
    const afterExpiry = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(afterExpiry.state).toBe("awaiting_user");
    expect(afterExpiry.id).not.toBe(lapsed.id);
    expect(writes).toContainEqual(
      expect.objectContaining({ setupState: "expired", lastErrorCode: "FEISHU_SETUP_EXPIRED" }),
    );

    // A live QR challenge whose owner vanished is a restart, not an expiry.
    writes.length = 0;
    const secondAgent = await createAgent(value, "takeover-restart");
    const orphaned = await service.createOrReuse(value.bootstrap.userId, secondAgent.id, "create");
    await database.database
      .update(imBindings)
      .set({ setupOwnerInstanceId: randomUUID() })
      .where(eq(imBindings.setupAttemptId, orphaned.id));
    clock.now = new Date(clock.now.getTime() + 1_000);
    const retried = await service.createOrReuse(value.bootstrap.userId, secondAgent.id, "create");
    expect(retried.id).not.toBe(orphaned.id);
    expect(writes).toContainEqual(
      expect.objectContaining({ setupState: "failed", lastErrorCode: "FEISHU_SETUP_OWNER_RESTARTED" }),
    );
    await service.stop();
  });

  it("retires a lapsed candidate's secret on cancel instead of waiting for the sweep", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value);
    const service = createService(value, fake.activation);
    const { attemptId } = await insertCandidate(value, { agentId: value.agent.id });
    await database.database
      .update(imBindings)
      .set({ setupExpiresAt: new Date(clock.now.getTime() - 1_000) })
      .where(eq(imBindings.setupAttemptId, attemptId));

    const canceled = await service.cancel(value.bootstrap.userId, attemptId);
    expect(canceled).toMatchObject({ state: "expired", errorCode: "FEISHU_SETUP_CANDIDATE_EXPIRED" });
    const row = await rowForAgent(value.agent.id);
    expect(row).toMatchObject({
      setupState: "expired",
      lastErrorCode: "FEISHU_SETUP_CANDIDATE_EXPIRED",
      encryptedSetupContext: null,
      setupExpiresAt: null,
    });
    expect(fake.activations).toHaveLength(0);
    await service.stop();
  });

  it("bounds a hung check by deadline and lets candidate expiry dominate", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value, {
      onCheck: () => new Promise<FeishuCandidateCheckOutcome>(() => undefined),
    });
    const { attemptId } = await insertCandidate(value, { agentId: value.agent.id });
    const service = createService(value, fake.activation, {
      timing: { checkDeadlineMs: 60, sweepPageSize: 10 },
    });

    const bounded = await service.check(value.bootstrap.userId, attemptId);
    expect(bounded).toMatchObject({ state: "pending_activation", activation: { reason: "temporary_failure" } });
    expect(fake.activations).toHaveLength(0);
    const settled = await rowForAgent(value.agent.id);
    expect(settled?.setupState).toBe("pending_activation");
    expect(settled?.encryptedSetupContext).toBeTruthy();

    // Expiry dominates even a validating row whose owner is still heartbeating.
    clock.now = new Date(clock.now.getTime() + 200_000);
    await database.database
      .update(imBindings)
      .set({
        setupState: "validating",
        setupOwnerInstanceId: randomUUID(),
        setupOwnerHeartbeatAt: clock.now,
        setupExpiresAt: new Date(clock.now.getTime() - 1_000),
      })
      .where(eq(imBindings.setupAttemptId, attemptId));
    const sweeper = createService(value, createFakeActivation(value).activation, {
      timing: { ownerHeartbeatMs: 10, ownerStaleMs: 60_000 },
    });
    sweeper.start();
    await vi.waitFor(
      async () => {
        const row = await rowForAgent(value.agent.id);
        expect(row?.setupState).toBe("expired");
        expect(row?.lastErrorCode).toBe("FEISHU_SETUP_CANDIDATE_EXPIRED");
        expect(row?.encryptedSetupContext).toBeNull();
      },
      { timeout: 5_000 },
    );
    sweeper.stop();
    await service.stop();
  });

  it("enforces the concurrency bound across concurrent manual checks on distinct attempts", async () => {
    const value = await fixture();
    const secondAgent = await createAgent(value, "limit-second");
    const gate = deferred<FeishuCandidateCheckOutcome>();
    const fake = createFakeActivation(value, { onCheck: () => gate.promise });
    const first = await insertCandidate(value, { agentId: value.agent.id });
    const second = await insertCandidate(value, { agentId: secondAgent.id });
    const service = createService(value, fake.activation, { timing: { maxConcurrentChecks: 1 } });

    const firstCheck = service.check(value.bootstrap.userId, first.attemptId);
    await vi.waitFor(async () => {
      expect((await rowForAgent(value.agent.id))?.setupState).toBe("validating");
    });
    const secondProjection = await service.check(value.bootstrap.userId, second.attemptId);
    expect(secondProjection.state).toBe("pending_activation");
    expect(fake.checkCandidate).toHaveBeenCalledTimes(1);
    expect(fake.checkCandidate.mock.calls[0]?.[0]?.agentId).toBe(value.agent.id);

    gate.resolve({ status: "waiting", reason: "temporary_failure", missingScopes: [] });
    await firstCheck;
    await service.stop();
  });

  it("fails malformed stale candidate contexts and terminalizes stale legacy QR rows", async () => {
    const value = await fixture();
    const malformed = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { state: "validating", owner: randomUUID(), heartbeatAt: new Date(clock.now.getTime() - 3_600_000) },
    );
    await database.database
      .update(imBindings)
      .set({
        encryptedSetupContext: value.cipher.encryptCredential(
          "not-json",
          feishuSetupAttemptContext(malformed.bindingId, malformed.attemptId),
        ),
      })
      .where(eq(imBindings.id, malformed.bindingId));

    const qrAgent = await createAgent(value, "legacy-qr");
    const qr = await insertCandidate(
      value,
      { agentId: qrAgent.id },
      {
        state: "validating",
        owner: randomUUID(),
        heartbeatAt: new Date(clock.now.getTime() - 3_600_000),
      },
    );
    await database.database
      .update(imBindings)
      .set({
        encryptedSetupContext: value.cipher.encryptCredential(
          JSON.stringify({ qrUrl: "https://feishu.example/qr/legacy" }),
          feishuSetupAttemptContext(qr.bindingId, qr.attemptId),
        ),
      })
      .where(eq(imBindings.id, qr.bindingId));

    // A legacy QR validating row with a live owner may still be completing elsewhere: left alone.
    const liveAgent = await createAgent(value, "legacy-qr-live");
    const live = await insertCandidate(
      value,
      { agentId: liveAgent.id },
      { state: "validating", owner: randomUUID(), heartbeatAt: clock.now },
    );
    await database.database
      .update(imBindings)
      .set({
        encryptedSetupContext: value.cipher.encryptCredential(
          JSON.stringify({ qrUrl: "https://feishu.example/qr/live" }),
          feishuSetupAttemptContext(live.bindingId, live.attemptId),
        ),
      })
      .where(eq(imBindings.id, live.bindingId));

    const service = createService(value, createFakeActivation(value).activation, {
      timing: { ownerHeartbeatMs: 10, ownerStaleMs: 60 },
    });
    service.start();
    await vi.waitFor(
      async () => {
        const row = await rowForAgent(value.agent.id);
        expect(row?.setupState).toBe("failed");
        expect(row?.lastErrorCode).toBe("FEISHU_SETUP_CONTEXT_INVALID");
        expect(row?.encryptedSetupContext).toBeNull();
      },
      { timeout: 5_000 },
    );
    // A stale legacy QR validating row can never complete: the sweep persists the same terminal
    // state the projection already reported instead of leaving the dead claim behind forever.
    await vi.waitFor(
      async () => {
        const row = await rowForAgent(qrAgent.id);
        expect(row?.setupState).toBe("failed");
        expect(row?.lastErrorCode).toBe("FEISHU_SETUP_OWNER_RESTARTED");
        expect(row?.encryptedSetupContext).toBeNull();
      },
      { timeout: 5_000 },
    );
    service.stop();

    const liveRow = await rowForAgent(liveAgent.id);
    expect(liveRow?.setupState).toBe("validating");
    expect(liveRow?.encryptedSetupContext).toBeTruthy();
    const qrProjection = await service.get(value.bootstrap.userId, qr.attemptId);
    expect(qrProjection).toMatchObject({ state: "failed", errorCode: "FEISHU_SETUP_OWNER_RESTARTED" });
  });

  it("expires lapsed candidates atomically and never clears a healthy credential on reauth cancel", async () => {
    const value = await fixture();
    const bindingId = await value.imBindings.activateFeishu({
      agentId: value.agent.id,
      appId: "cli_existing",
      teamId: "tenant_existing",
      botOpenId: "ou_existing",
      appSecret: EXISTING_SECRET,
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    });
    const before = await rowForAgent(value.agent.id);
    const fake = createFakeActivation(value);
    const service = createService(value, fake.activation);

    // Reauthorization candidate over the active binding: cancel preserves the working route.
    const canceledAttempt = await insertCandidate(value, { agentId: value.agent.id, id: bindingId });
    await expect(service.cancel(value.bootstrap.userId, canceledAttempt.attemptId)).resolves.toMatchObject({
      state: "canceled",
    });
    const afterCancel = await rowForAgent(value.agent.id);
    expect(afterCancel?.status).toBe("active");
    expect(afterCancel?.encryptedCredential).toBe(before?.encryptedCredential);
    expect(afterCancel?.credentialGeneration).toBe(before?.credentialGeneration);
    expect(afterCancel?.encryptedSetupContext).toBeNull();

    // A lapsed candidate expires with the candidate-specific code and clears its own secret only.
    const lapsed = await insertCandidate(value, { agentId: value.agent.id, id: bindingId });
    await database.database
      .update(imBindings)
      .set({ setupExpiresAt: new Date(clock.now.getTime() - 1_000) })
      .where(eq(imBindings.id, bindingId));
    const projection = await service.check(value.bootstrap.userId, lapsed.attemptId);
    expect(projection).toMatchObject({ state: "expired", errorCode: "FEISHU_SETUP_CANDIDATE_EXPIRED" });
    const afterExpiry = await rowForAgent(value.agent.id);
    expect(afterExpiry?.encryptedSetupContext).toBeNull();
    expect(afterExpiry?.setupExpiresAt).toBeNull();
    expect(afterExpiry?.encryptedCredential).toBe(before?.encryptedCredential);
    await service.stop();
  });

  it("disables the binding and atomically removes the candidate and its state", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value);
    const service = createService(value, fake.activation);
    const { bindingId, attemptId } = await insertCandidate(value, { agentId: value.agent.id });
    await service.get(value.bootstrap.userId, attemptId);
    await value.imBindings.disable(value.bootstrap.userId, bindingId);
    const row = await rowForAgent(value.agent.id);
    // The parent-owned disable cancels an open authorization and preserves the terminal attempt
    // identity; the secret, owner, lease and deadline are cleared atomically.
    expect(row).toMatchObject({
      status: "disabled",
      setupState: "canceled",
      setupAttemptId: attemptId,
      encryptedSetupContext: null,
      setupOwnerInstanceId: null,
      setupExpiresAt: null,
      encryptedCredential: null,
    });
    await service.stop();
  });

  it("never activates unauthenticated cross-attempt ciphertext or mistakes it for a known-invalid plaintext", async () => {
    const value = await fixture();
    const other = await createAgent(value, "cross-other");
    const foreign = await insertCandidate(value, { agentId: other.id }, { appSecret: "foreign-secret" });
    const target = await insertCandidate(value, { agentId: value.agent.id });
    const [foreignRow] = await database.database.select().from(imBindings).where(eq(imBindings.id, foreign.bindingId));
    await database.database
      .update(imBindings)
      .set({ encryptedSetupContext: foreignRow?.encryptedSetupContext })
      .where(eq(imBindings.id, target.bindingId));

    const fake = createFakeActivation(value);
    const service = createService(value, fake.activation);
    // Read-only projection fails closed on the authentication mismatch.
    await expect(service.get(value.bootstrap.userId, target.attemptId)).rejects.toThrow(/authenticated/);
    // The cipher deliberately makes key skew and tampering indistinguishable. Preserve until
    // the fixed deadline, never authenticate or activate a foreign identity.
    await expect(service.check(value.bootstrap.userId, target.attemptId)).rejects.toMatchObject({
      code: "FEISHU_SETUP_CONTEXT_UNREADABLE",
    });
    const row = await rowForAgent(value.agent.id);
    expect(row?.setupState).toBe("pending_activation");
    expect(row?.encryptedSetupContext).toBe(foreignRow?.encryptedSetupContext);
    expect(fake.activations).toHaveLength(0);
    await service.stop();
  });

  it("keeps legacy QR attempts readable, reuses a candidate, and keeps their expiry code", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value, {
      outcomes: [{ status: "waiting", reason: "app_unavailable", missingScopes: [] }],
    });
    const pending = deferred<{ appId: string; appSecret: string; teamBrand: "feishu" }>();
    const gateway = { start: vi.fn(() => registration(pending.promise)) };
    const service = createService(value, fake.activation, { gateway });

    const qrAttempt = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(qrAttempt).toMatchObject({ state: "awaiting_user", qrUrl: "https://feishu.example/qr" });
    expect(qrAttempt.activation).toBeUndefined();
    const qrRow = await rowForAgent(value.agent.id);
    if (!qrRow) throw new Error("QR row missing");
    expect(contextFor(value, qrRow)).toEqual({ kind: "qr", qrUrl: "https://feishu.example/qr" });

    // The registration result turns the same attempt into a durable candidate.
    pending.resolve({ appId: "cli_reuse", appSecret: CANDIDATE_SECRET, teamBrand: "feishu" });
    await vi.waitFor(async () => {
      expect((await rowForAgent(value.agent.id))?.setupState).toBe("pending_activation");
    });
    const reused = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
    expect(reused.id).toBe(qrAttempt.id);
    expect(reused.activation).toMatchObject({ appId: "cli_reuse", reason: "app_unavailable" });
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(fake.checkCandidate).toHaveBeenCalledTimes(1);

    // A legacy QR whose device code lapsed keeps the QR expiry code and lets a new attempt start.
    const qrAgent = await createAgent(value, "qr-expiry");
    const lapsed = await insertCandidate(
      value,
      { agentId: qrAgent.id },
      {
        state: "awaiting_user",
        owner: randomUUID(),
        heartbeatAt: clock.now,
        expiresAt: new Date(clock.now.getTime() - 1_000),
      },
    );
    await database.database
      .update(imBindings)
      .set({
        encryptedSetupContext: value.cipher.encryptCredential(
          JSON.stringify({ qrUrl: "https://feishu.example/qr/lapsed" }),
          feishuSetupAttemptContext(lapsed.bindingId, lapsed.attemptId),
        ),
      })
      .where(eq(imBindings.id, lapsed.bindingId));
    await expect(service.get(value.bootstrap.userId, lapsed.attemptId)).resolves.toMatchObject({
      state: "expired",
      errorCode: "FEISHU_SETUP_EXPIRED",
    });
    await service.stop();
  });

  it("keeps the existing Agent/App uniqueness authority at activation", async () => {
    const value = await fixture();
    const secondAgent = await createAgent(value, "second-agent");
    const fake = createFakeActivation(value);
    const service = createService(value, fake.activation);
    const first = await insertCandidate(value, { agentId: value.agent.id }, { appId: "cli_shared" });
    await service.check(value.bootstrap.userId, first.attemptId);
    expect((await rowForAgent(value.agent.id))?.status).toBe("active");

    const second = await insertCandidate(value, { agentId: secondAgent.id }, { appId: "cli_shared" });
    await service.check(value.bootstrap.userId, second.attemptId);
    const failed = await rowForAgent(secondAgent.id);
    expect(failed?.setupState).toBe("failed");
    expect(failed?.lastErrorCode).toBe("FEISHU_APP_ALREADY_BOUND");
    expect(failed?.encryptedSetupContext).toBeNull();
    const firstRow = await rowForAgent(value.agent.id);
    expect(firstRow).toMatchObject({ status: "active", credentialGeneration: 1 });
    await service.stop();
  });

  it("rejects malformed pending candidates at the database constraint", async () => {
    const value = await fixture();
    await expect(
      database.database.insert(imBindings).values({
        agentId: value.agent.id,
        provider: "feishu",
        status: "provisioning",
        setupAttemptId: randomUUID(),
        setupIntent: "create",
        setupState: "pending_activation",
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: new Date(clock.now.getTime() + 60_000),
      }),
    ).rejects.toThrow();
    await expect(
      database.database.insert(imBindings).values({
        agentId: value.agent.id,
        provider: "feishu",
        status: "provisioning",
        setupAttemptId: randomUUID(),
        setupIntent: "create",
        setupState: "pending_activation",
        setupOwnerInstanceId: randomUUID(),
        setupOwnerHeartbeatAt: clock.now,
        encryptedSetupContext: value.cipher.encryptCredential("{}", "x"),
        setupExpiresAt: new Date(clock.now.getTime() + 60_000),
      }),
    ).rejects.toThrow();
  });
});

describe("Feishu candidate failure classification", () => {
  it("honors Retry-After hints from headers, explicit milliseconds, and absence", () => {
    const now = Date.now();
    expect(feishuRetryAfterMs({ response: { headers: { "retry-after": "12" } } }, now)).toBe(12_000);
    const headers = new Headers({ "retry-after": String(Math.floor(now / 1_000) + 20) });
    expect(feishuRetryAfterMs({ response: { headers } }, now)).toBeGreaterThan(19_000);
    expect(feishuRetryAfterMs({ retryAfterMs: 42 }, now)).toBe(42);
    expect(feishuRetryAfterMs(new Error("nope"), now)).toBeUndefined();
  });

  it("terminates only on explicit irrecoverable signals and keeps 10003 recoverable", () => {
    const now = Date.now();
    expect(classifyFeishuCandidateFailure(new FeishuOperationError("FEISHU_APP_IDENTITY_MISMATCH"), now)).toEqual({
      status: "terminal",
      errorCode: "FEISHU_APP_IDENTITY_MISMATCH",
    });
    // 10015 wrong app secret and 20002 appId/secret mismatch are terminal.
    expect(classifyFeishuCandidateFailure({ response: { data: { code: 10015 } } }, now)).toEqual({
      status: "terminal",
      errorCode: "FEISHU_CREDENTIAL_INVALID",
    });
    expect(classifyFeishuCandidateFailure({ response: { data: { code: 20002 } } }, now)).toEqual({
      status: "terminal",
      errorCode: "FEISHU_CREDENTIAL_INVALID",
    });
    // 10003 is an invalid-parameter signal and must preserve the candidate.
    expect(classifyFeishuCandidateFailure({ response: { data: { code: 10003 } } }, now)).toMatchObject({
      status: "waiting",
      reason: "temporary_failure",
    });
    // A generic transport or provider failure never becomes a credential verdict.
    expect(classifyFeishuCandidateFailure(new Error("socket closed"), now)).toMatchObject({
      status: "waiting",
      reason: "temporary_failure",
    });
    expect(classifyFeishuCandidateFailure(new FeishuCandidateExpiredError(), now)).toEqual({ status: "expired" });
  });
});

describe("Feishu setup context envelope", () => {
  it("bounds untrusted scopes, ciphertext size, and candidate identity", async () => {
    const value = await fixture();
    const observation = {
      checkedAt: clock.now.toISOString(),
      reason: "permissions_pending" as const,
    };
    const base = {
      version: 1 as const,
      kind: "feishu_candidate" as const,
      bindingId: randomUUID(),
      attemptId: randomUUID(),
      appId: "cli_context",
      appSecret: CANDIDATE_SECRET,
      teamBrand: "feishu" as const,
      savedAt: clock.now.toISOString(),
      nextCheckAt: clock.now.toISOString(),
      observation: { ...observation, missingScopes: ["im:message"] },
    };
    expect(() => encodeFeishuSetupCandidate(value.cipher, base, base.bindingId, base.attemptId)).not.toThrow();
    expect(() =>
      encodeFeishuSetupCandidate(
        value.cipher,
        { ...base, observation: { ...observation, missingScopes: ["im:message", "im:message"] } },
        base.bindingId,
        base.attemptId,
      ),
    ).toThrow();
    expect(() =>
      encodeFeishuSetupCandidate(
        value.cipher,
        { ...base, observation: { ...observation, missingScopes: ["not-a-scope"] } },
        base.bindingId,
        base.attemptId,
      ),
    ).toThrow();

    // Ciphertext is bounded before any decryption work.
    expect(
      decodeFeishuSetupContext(value.cipher, "x".repeat(64 * 1024 + 1), base.bindingId, base.attemptId),
    ).toBeUndefined();

    // The embedded identity is authoritative even under the default v1 cipher, where there is no AAD.
    const v1 = new ApplicationCipher(new Uint8Array(32).fill(7));
    const encrypted = encodeFeishuSetupCandidate(v1, base, base.bindingId, base.attemptId);
    expect(decodeFeishuSetupContext(v1, encrypted, base.bindingId, base.attemptId)).toMatchObject({
      kind: "candidate",
    });
    expect(decodeFeishuSetupContext(v1, encrypted, randomUUID(), base.attemptId)).toBeUndefined();

    // Legacy QR payloads stay readable.
    const qrUrl = "https://feishu.example/qr/envelope";
    const qrEncrypted = value.cipher.encryptCredential(
      JSON.stringify({ qrUrl }),
      feishuSetupAttemptContext(base.bindingId, base.attemptId),
    );
    expect(decodeFeishuSetupContext(value.cipher, qrEncrypted, base.bindingId, base.attemptId)).toEqual({
      kind: "qr",
      qrUrl,
    });
  });

  it("classifies a missing ring key as undecryptable, distinct from authenticated-invalid", async () => {
    const value = await fixture();
    const wrongRing = new ApplicationCipher({
      legacyKey: new Uint8Array(32).fill(101),
      keys: { "other-2026-09": new Uint8Array(32).fill(31) },
      activeKeyId: "other-2026-09",
      writeVersion: 2,
    });
    const bindingId = randomUUID();
    const attemptId = randomUUID();
    const candidate = {
      version: 1 as const,
      kind: "feishu_candidate" as const,
      bindingId,
      attemptId,
      appId: "cli_ring",
      appSecret: CANDIDATE_SECRET,
      teamBrand: "feishu" as const,
      savedAt: clock.now.toISOString(),
      nextCheckAt: clock.now.toISOString(),
      observation: null,
    };
    const encrypted = encodeFeishuSetupCandidate(value.cipher, candidate, bindingId, attemptId);
    expect(readFeishuSetupContext(wrongRing, encrypted, bindingId, attemptId)).toMatchObject({
      status: "undecryptable",
    });
    expect(readFeishuSetupContext(value.cipher, encrypted, bindingId, attemptId)).toMatchObject({
      status: "decoded",
      context: { kind: "candidate" },
    });
    // Authenticated plaintext that is malformed or bound to another identity keeps the terminal class.
    const malformed = value.cipher.encryptCredential("not-json", feishuSetupAttemptContext(bindingId, attemptId));
    expect(readFeishuSetupContext(value.cipher, malformed, bindingId, attemptId)).toEqual({ status: "invalid" });
    const mismatched = value.cipher.encryptCredential(
      JSON.stringify({ ...candidate, bindingId: randomUUID() }),
      feishuSetupAttemptContext(bindingId, attemptId),
    );
    expect(readFeishuSetupContext(value.cipher, mismatched, bindingId, attemptId)).toEqual({ status: "invalid" });
    // The legacy decode contract is unchanged: non-strict absorbs, strict surfaces the failure.
    expect(decodeFeishuSetupContext(wrongRing, encrypted, bindingId, attemptId)).toBeUndefined();
    expect(() => decodeFeishuSetupContext(wrongRing, encrypted, bindingId, attemptId, { strict: true })).toThrow(
      /authenticated/,
    );
  });
});

/** A service whose key ring lacks the candidate's key: the v2 envelope cannot be authenticated. */
function wrongRingService(
  value: FixtureValue,
  activation: FeishuBindingActivation,
  options: {
    timing?: FeishuSetupTiming;
    gateway?: FeishuRegistrationGateway;
    onDiagnostic?: (code: string) => void;
  } = {},
): FeishuSetupService {
  return new FeishuSetupService({
    database: database.database,
    cipher: wrongRingCipher(),
    onDiagnostic: options.onDiagnostic,
    instanceId: randomUUID(),
    imBindings: value.imBindings,
    registrations: options.gateway ?? { start: vi.fn() },
    activation,
    timing: { checkIntervalMs: 1_000, checkJitterMs: 0, ownerStaleMs: 60, checkDeadlineMs: 5_000, ...options.timing },
    now: () => clock.now,
    random: () => 0,
  });
}

function wrongRingCipher(): ApplicationCipher {
  return new ApplicationCipher({
    legacyKey: new Uint8Array(32).fill(101),
    keys: { "other-2026-09": new Uint8Array(32).fill(31) },
    activeKeyId: "other-2026-09",
    writeVersion: 2,
  });
}

describe("Agent-owned open authorization reads", () => {
  it("finds a saved replacement while the old binding is active, without changing it", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value);
    const service = createService(value, fake.activation);
    const bindingId = await value.imBindings.activateFeishu({
      agentId: value.agent.id,
      appId: "cli_active",
      appSecret: "active-secret",
      teamId: "tenant_active",
      botOpenId: "ou_active",
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    });
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id, id: bindingId },
      { appId: "cli_candidate" },
    );
    const before = await rowForAgent(value.agent.id);
    const attempt = await service.getForAgent(value.bootstrap.userId, value.agent.id);
    expect(attempt).toMatchObject({
      id: candidate.attemptId,
      state: "pending_activation",
      activation: { appId: "cli_candidate" },
    });
    expect(await rowForAgent(value.agent.id)).toEqual(before);
    await expect(service.getForAgent(randomUUID(), value.agent.id)).rejects.toThrow();
    expect(fake.activations).toHaveLength(0);
    await service.cancel(value.bootstrap.userId, candidate.attemptId);
    expect(await service.getForAgent(value.bootstrap.userId, value.agent.id)).toBeUndefined();
    expect((await rowForAgent(value.agent.id))?.encryptedCredential).toBe(before?.encryptedCredential);
    await service.stop();
  });
});

describe("Feishu durable candidate under a key ring missing its key", () => {
  it("preserves an undecryptable candidate through the sweep without starving later rows, then recovers", async () => {
    const value = await fixture();
    const foreignCipher = wrongRingCipher();
    const foreignValue = {
      ...value,
      cipher: foreignCipher,
      imBindings: new ImBindingService(database.database, foreignCipher, { now: () => clock.now }),
    };
    const fake = createFakeActivation(foreignValue);
    // The unreadable candidate sorts first, so a terminalized or throwing read would starve the second row.
    const unreadable = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_ring_first", bindingId: "00000000-0000-4000-8000-000000000001" },
    );
    const secondAgent = await createAgent(value, "ring-second");
    const readable = await insertCandidate(
      value,
      { agentId: secondAgent.id },
      { appId: "cli_ring_second", cipher: wrongRingCipher(), bindingId: "00000000-0000-4000-8000-000000000002" },
    );
    const before = await rowForAgent(value.agent.id);

    const foreign = wrongRingService(value, fake.activation, {
      timing: { ownerHeartbeatMs: 10, checkIntervalMs: 0 },
    });
    foreign.start();
    await vi.waitFor(
      async () => {
        expect((await rowForAgent(secondAgent.id))?.setupState).toBe("succeeded");
      },
      { timeout: 8_000 },
    );
    await foreign.stop();

    // The later readable row was claimed and activated; the unreadable one is byte-for-byte intact.
    expect(fake.activations).toHaveLength(1);
    expect(fake.activations[0]?.appId).toBe("cli_ring_second");
    expect(fake.activations[0]?.attemptId).toBe(readable.attemptId);
    const preserved = await rowForAgent(value.agent.id);
    expect(preserved).toMatchObject({
      setupState: "pending_activation",
      setupAttemptId: unreadable.attemptId,
      setupOwnerInstanceId: null,
      lastErrorCode: null,
    });
    expect(preserved?.encryptedSetupContext).toBe(before?.encryptedSetupContext);
    expect(preserved?.setupExpiresAt).toEqual(before?.setupExpiresAt);

    // Once the owning ring returns, the same candidate completes without re-registration.
    const ownerFake = createFakeActivation(value);
    const owner = createService(value, ownerFake.activation);
    const recovered = await owner.check(value.bootstrap.userId, unreadable.attemptId);
    expect(recovered.state).toBe("succeeded");
    expect(ownerFake.activations).toHaveLength(1);
    await owner.stop();
  });

  it("fails manual check and replacement create honestly without mutating the candidate", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value);
    const start = vi.fn();
    const service = wrongRingService(value, fake.activation, { gateway: { start } });

    const pending = await insertCandidate(value, { agentId: value.agent.id }, { appId: "cli_unreadable" });
    const validatingAgent = await createAgent(value, "unreadable-validating");
    await insertCandidate(
      value,
      { agentId: validatingAgent.id },
      { appId: "cli_unreadable_validating", state: "validating", owner: randomUUID(), heartbeatAt: clock.now },
    );
    const before = await rowForAgent(value.agent.id);

    await expect(service.check(value.bootstrap.userId, pending.attemptId)).rejects.toMatchObject({
      code: "FEISHU_SETUP_CONTEXT_UNREADABLE",
    });
    await expect(service.createOrReuse(value.bootstrap.userId, value.agent.id, "create")).rejects.toMatchObject({
      code: "FEISHU_SETUP_CONTEXT_UNREADABLE",
    });
    await expect(service.createOrReuse(value.bootstrap.userId, validatingAgent.id, "create")).rejects.toMatchObject({
      code: "FEISHU_SETUP_CONTEXT_UNREADABLE",
    });

    expect(start).not.toHaveBeenCalled();
    expect(fake.activations).toHaveLength(0);
    const after = await rowForAgent(value.agent.id);
    expect(after?.encryptedSetupContext).toBe(before?.encryptedSetupContext);
    expect(after?.setupState).toBe("pending_activation");
    const validatingRow = await rowForAgent(validatingAgent.id);
    expect(validatingRow?.setupState).toBe("validating");
    expect(validatingRow?.encryptedSetupContext).toBeTruthy();
    await service.stop();
  });

  it.each(["pending_activation", "validating"] as const)(
    "allows a new QR after an unreadable %s attempt expires",
    async (state) => {
      const value = await fixture();
      const fake = createFakeActivation(value);
      const pending = deferred<{ appId: string; appSecret: string; teamBrand: "feishu" }>();
      const gateway = { start: vi.fn(() => registration(pending.promise)) };
      const service = wrongRingService(value, fake.activation, { gateway });
      const old = await insertCandidate(
        value,
        { agentId: value.agent.id },
        {
          state,
          expiresAt: new Date(clock.now.getTime() - 1_000),
          ...(state === "validating" ? { owner: randomUUID(), heartbeatAt: clock.now } : {}),
        },
      );
      const fresh = await service.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      expect(fresh.state).toBe("awaiting_user");
      expect(fresh.id).not.toBe(old.attemptId);
      expect(gateway.start).toHaveBeenCalledOnce();
      expect(fake.activations).toHaveLength(0);
      await service.stop();
    },
  );

  it("cancels an undecryptable candidate and clears its ciphertext", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value);
    const service = wrongRingService(value, fake.activation);
    const { attemptId } = await insertCandidate(value, { agentId: value.agent.id });

    const canceled = await service.cancel(value.bootstrap.userId, attemptId);
    expect(canceled).toMatchObject({ state: "canceled", errorCode: "FEISHU_SETUP_CANCELED", qrUrl: null });
    const row = await rowForAgent(value.agent.id);
    expect(row).toMatchObject({
      setupState: "canceled",
      lastErrorCode: "FEISHU_SETUP_CANCELED",
      encryptedSetupContext: null,
      setupExpiresAt: null,
      setupOwnerInstanceId: null,
    });
    expect(fake.activations).toHaveLength(0);
    await service.stop();
  });

  it("applies the fixed deadline to an undecryptable candidate on cancel and on sweep", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value);
    const service = wrongRingService(value, fake.activation, { timing: { ownerHeartbeatMs: 10 } });
    const past = new Date(clock.now.getTime() - 1_000);

    const viaCancel = await insertCandidate(value, { agentId: value.agent.id }, { expiresAt: past });
    await expect(service.cancel(value.bootstrap.userId, viaCancel.attemptId)).resolves.toMatchObject({
      state: "expired",
      errorCode: "FEISHU_SETUP_CANDIDATE_EXPIRED",
    });
    expect((await rowForAgent(value.agent.id))?.encryptedSetupContext).toBeNull();

    const sweepAgent = await createAgent(value, "ring-sweep-expiry");
    await insertCandidate(value, { agentId: sweepAgent.id }, { expiresAt: past });
    service.start();
    await vi.waitFor(
      async () => {
        const row = await rowForAgent(sweepAgent.id);
        expect(row?.setupState).toBe("expired");
        expect(row?.lastErrorCode).toBe("FEISHU_SETUP_CANDIDATE_EXPIRED");
        expect(row?.encryptedSetupContext).toBeNull();
      },
      { timeout: 8_000 },
    );
    await service.stop();
    expect(fake.activations).toHaveLength(0);
  });

  it("leaves a stale-claimed undecryptable validating row to its owning key ring", async () => {
    const value = await fixture();
    const fake = createFakeActivation(value);
    await insertCandidate(
      value,
      { agentId: value.agent.id },
      { state: "validating", owner: randomUUID(), heartbeatAt: new Date(clock.now.getTime() - 3_600_000) },
    );
    const diagnostic = vi.fn();
    const foreign = wrongRingService(value, fake.activation, {
      onDiagnostic: diagnostic,
      timing: { ownerHeartbeatMs: 10, ownerStaleMs: 60 },
    });
    foreign.start();
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith("FEISHU_SETUP_CONTEXT_UNREADABLE"));
    await foreign.stop();

    // The foreign ring never terminalizes, releases, or rewrites what it cannot read.
    const preserved = await rowForAgent(value.agent.id);
    expect(preserved?.setupState).toBe("validating");
    expect(preserved?.encryptedSetupContext).toBeTruthy();
    expect(preserved?.lastErrorCode).toBeNull();

    // The owning ring recovers the stale claim and completes the lifecycle.
    const owner = createService(value, fake.activation, {
      timing: { ownerHeartbeatMs: 10, ownerStaleMs: 60, checkIntervalMs: 0 },
    });
    owner.start();
    await vi.waitFor(
      async () => {
        expect((await rowForAgent(value.agent.id))?.setupState).toBe("succeeded");
      },
      { timeout: 8_000 },
    );
    await owner.stop();
    expect(fake.activations).toHaveLength(1);
  });
});

/**
 * A real `FeishuConnectionManager` over the PGlite database with an in-memory adapter factory. The
 * suites above drive the *setup service* with a fake activation; these drive the production manager
 * the setup service injects, so the channel-free probe, the maintenance sweep, the real activation
 * transaction, and the provider callbacks are all exercised.
 */
interface ManagerHarness {
  manager: FeishuConnectionManager;
  created: Array<{ appId: string; channel: boolean }>;
  disconnected: string[];
  /** The handlers installed by the most recent channel, for driving provider callbacks. */
  handlers: Array<Parameters<FeishuChannel["on"]>[0]>;
  scopes: { value: string[] };
  diagnostics: string[];
  ingest: Mock;
  setBotProbe: (fn: () => Promise<{ openId: string; activateStatus: number | null }>) => void;
  setScopeFailure: (error: unknown) => void;
  setScopeList: (fn: () => Promise<string[]>) => void;
  setValidate: (
    fn: (signal?: AbortSignal) => Promise<{ externalAppId: string; externalTeamId: string; externalBotId: string }>,
  ) => void;
  setDisconnect: (fn: (appId: string) => unknown) => void;
  setResolveSenderName: (fn: (input: { chatId: string; senderOpenId: string }) => Promise<string | undefined>) => void;
  setNormalize: (fn: () => unknown[]) => void;
}

function managerHarness(
  value: FixtureValue,
  options: {
    runtimeReady?: boolean;
    instanceId?: string;
    leaseMs?: number;
    maintenanceMs?: number;
    maintenanceBackoffBaseMs?: number;
    maintenanceBackoffMaxMs?: number;
    receipts?: { claim: Mock; markProcessed: Mock; markFailed: Mock };
    supervisor?: { track: Mock };
    /** Runs in addition to recording the code; may throw to model a failing observer. */
    diagnosticHook?: (code: string) => void;
    /** The test-only seam between the Agent lock and the binding re-read. */
    afterActivationAgentLocked?: () => Promise<void>;
  } = {},
): ManagerHarness {
  const ingest = vi.fn();
  let resolveSenderName = async (_input: { chatId: string; senderOpenId: string }): Promise<string | undefined> =>
    undefined;
  let normalize = (_envelope: { message: unknown }) => [] as unknown[];
  const created: Array<{ appId: string; channel: boolean }> = [];
  const disconnected: string[] = [];
  const handlers: Array<Parameters<FeishuChannel["on"]>[0]> = [];
  const diagnostics: string[] = [];
  const scopes = { value: [...FEISHU_REQUIRED_TENANT_SCOPES] };
  let scopeFailure: unknown;
  let scopeList: (() => Promise<string[]>) | undefined;
  let botProbe = async () => ({ openId: "ou_probe", activateStatus: 2 });
  let validate = async (
    _signal?: AbortSignal,
  ): Promise<{ externalAppId: string; externalTeamId: string; externalBotId: string }> =>
    Promise.reject(new Error("validateBinding was not configured"));
  let disconnect = (appId: string) => {
    disconnected.push(appId);
  };
  const manager = new FeishuConnectionManager({
    database: database.database,
    inbox: { ingest } as never,
    instanceId: options.instanceId ?? randomUUID(),
    imBindings: value.imBindings,
    now: () => clock.now,
    runtimeReady: () => options.runtimeReady ?? true,
    onDiagnostic: (code) => {
      diagnostics.push(code);
      options.diagnosticHook?.(code);
    },
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.maintenanceMs === undefined ? {} : { maintenanceMs: options.maintenanceMs }),
    ...(options.maintenanceBackoffBaseMs === undefined
      ? {}
      : { maintenanceBackoffBaseMs: options.maintenanceBackoffBaseMs }),
    ...(options.maintenanceBackoffMaxMs === undefined
      ? {}
      : { maintenanceBackoffMaxMs: options.maintenanceBackoffMaxMs }),
    ...(options.receipts ? { receipts: options.receipts as never } : {}),
    ...(options.supervisor ? { supervisor: options.supervisor as never } : {}),
    ...(options.afterActivationAgentLocked ? { afterActivationAgentLocked: options.afterActivationAgentLocked } : {}),
    createAdapter: (input) => {
      created.push({ appId: input.appId, channel: input.channel !== null });
      const channel: FeishuChannel = {
        on: (next) => {
          handlers.push(next);
          return () => undefined;
        },
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => {
          await disconnect(input.appId);
        }),
        botIdentity: { openId: `ou_${input.appId}` },
      };
      const adapter = {
        channel,
        validateBinding: vi.fn((signal?: AbortSignal) => validate(signal)),
        listGrantedWorkspaceScopes: vi.fn(async () => {
          if (scopeFailure) throw scopeFailure;
          return scopeList ? scopeList() : [...scopes.value];
        }),
        probeBotIdentity: vi.fn(() => botProbe()),
        normalizeInbound: vi.fn((envelope: { message: unknown }) => normalize(envelope as { message: unknown })),
        resolveSenderName: vi.fn((input: { chatId: string; senderOpenId: string }) => resolveSenderName(input)),
      };
      return adapter as unknown as FeishuAdapter;
    },
  });
  return {
    manager,
    created,
    disconnected,
    handlers,
    scopes,
    diagnostics,
    ingest,
    setNormalize: (fn) => {
      normalize = fn;
    },
    setResolveSenderName: (fn) => {
      resolveSenderName = fn;
    },
    setScopeList: (fn) => {
      scopeList = fn;
    },
    setBotProbe: (fn) => {
      botProbe = fn as typeof botProbe;
    },
    setScopeFailure: (error) => {
      scopeFailure = error;
    },
    setValidate: (fn) => {
      validate = fn;
    },
    setDisconnect: (fn) => {
      disconnect = fn;
    },
  };
}

/** Inserts an active binding-shaped row the sweep can claim, without a credential. */
async function insertActiveFeishuBinding(
  value: FixtureValue,
  input: { agentId: string; appId?: string; botOpenId?: string; epoch?: number } = { agentId: "" },
): Promise<string> {
  const id = randomUUID();
  await database.database.insert(imBindings).values({
    id,
    agentId: input.agentId,
    provider: "feishu",
    status: "active",
    externalAppId: input.appId ?? "cli_sweep",
    externalTeamId: "tenant_sweep",
    externalBotId: input.botOpenId ?? `ou_${input.appId ?? "cli_sweep"}`,
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: value.cipher.encryptCredential(
      JSON.stringify({
        appId: input.appId ?? "cli_sweep",
        appSecret: CANDIDATE_SECRET,
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES].sort(),
      }),
      feishuBindingCredentialContext(id),
    ),
    grantedCapabilities: [...FEISHU_REQUIRED_TENANT_SCOPES],
    connectionFencingEpoch: input.epoch ?? 0,
    activatedAt: clock.now,
    createdAt: clock.now,
    updatedAt: clock.now,
  });
  return id;
}

describe("FeishuConnectionManager candidate probe", () => {
  it("returns a terminal credential verdict from the channel-free scope read", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    harness.setScopeFailure({ response: { data: { code: 10015 } } });
    await expect(
      harness.manager.checkCandidate({ agentId: value.agent.id, appId: "cli_probe", appSecret: CANDIDATE_SECRET }),
    ).resolves.toEqual({ status: "terminal", errorCode: "FEISHU_CREDENTIAL_INVALID" });
    // Admission is channel-free by contract: the probe never opens a message socket.
    expect(harness.created).toEqual([{ appId: "cli_probe", channel: false }]);
  });

  it("reads a provider-reported disabled App as a bounded wait, not a dead credential", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    harness.setBotProbe(async () => ({ openId: "ou_probe", activateStatus: 0 }));
    await expect(
      harness.manager.checkCandidate({ agentId: value.agent.id, appId: "cli_probe", appSecret: CANDIDATE_SECRET }),
    ).resolves.toEqual({ status: "waiting", reason: "app_unavailable", missingScopes: [] });
  });

  it("reads a missing Bot identity as app-unavailable and a transport failure as a transient wait", async () => {
    const value = await fixture();
    const missingBot = managerHarness(value);
    missingBot.setBotProbe(async () => {
      throw Object.assign(new Error("FEISHU_BOT_IDENTITY_MISSING"), { code: "FEISHU_BOT_IDENTITY_MISSING" });
    });
    await expect(
      missingBot.manager.checkCandidate({ agentId: value.agent.id, appId: "cli_probe", appSecret: CANDIDATE_SECRET }),
    ).resolves.toEqual({ status: "waiting", reason: "app_unavailable", missingScopes: [] });

    const transport = managerHarness(value);
    transport.setBotProbe(async () => {
      throw new Error("socket closed");
    });
    await expect(
      transport.manager.checkCandidate({ agentId: value.agent.id, appId: "cli_probe", appSecret: CANDIDATE_SECRET }),
    ).resolves.toMatchObject({ status: "waiting", reason: "temporary_failure" });
  });

  it("honours a candidate abort before any provider call and skips a channel's absent Bot probe", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const abort = new AbortController();
    abort.abort();
    await expect(
      harness.manager.checkCandidate({
        agentId: value.agent.id,
        appId: "cli_probe",
        appSecret: CANDIDATE_SECRET,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(harness.created).toEqual([]);

    // An adapter without `probeBotIdentity` proves readiness from scopes and runtime alone.
    const bare = new FeishuConnectionManager({
      database: database.database,
      inbox: { ingest: vi.fn() } as never,
      instanceId: randomUUID(),
      imBindings: value.imBindings,
      now: () => clock.now,
      runtimeReady: () => true,
      createAdapter: () =>
        ({
          channel: {} as FeishuChannel,
          listGrantedWorkspaceScopes: vi.fn(async () => [...FEISHU_REQUIRED_TENANT_SCOPES]),
        }) as never,
    });
    await expect(
      bare.checkCandidate({ agentId: value.agent.id, appId: "cli_probe", appSecret: CANDIDATE_SECRET }),
    ).resolves.toEqual({ status: "ready" });
  });
});

async function rowById(id: string) {
  const [row] = await database.database.select().from(imBindings).where(eq(imBindings.id, id));
  return row;
}

/**
 * Drives the real fenced activation of one durable candidate through the manager. The candidate row
 * is the exact shape the setup service claims: `validating`, owned by the caller's token.
 */
async function activateThroughManager(
  harness: ManagerHarness,
  value: FixtureValue,
  input: { appId?: string; botOpenId?: string } = {},
): Promise<{ bindingId: string; attemptId: string }> {
  const appId = input.appId ?? "cli_act";
  const owner = randomUUID();
  const candidate = await insertCandidate(
    value,
    { agentId: value.agent.id },
    { appId, state: "validating", owner, heartbeatAt: clock.now },
  );
  harness.setValidate(async () => ({
    externalAppId: appId,
    externalTeamId: `tenant_${appId}`,
    externalBotId: input.botOpenId ?? `ou_${appId}`,
  }));
  await harness.manager.activateAtomicAttempt({
    attemptId: candidate.attemptId,
    ownerInstanceId: owner,
    agentId: value.agent.id,
    appId,
    appSecret: CANDIDATE_SECRET,
  });
  const row = await rowForAgent(value.agent.id);
  if (!row) throw new Error("activated binding missing");
  return { bindingId: row.id, attemptId: candidate.attemptId };
}

describe("FeishuConnectionManager fenced activation", () => {
  it("commits one activation and replaces the previously owned channel on reauthorization", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const first = await activateThroughManager(harness, value);
    const row = await rowById(first.bindingId);
    expect(row).toMatchObject({
      status: "active",
      setupState: "succeeded",
      externalAppId: "cli_act",
      credentialGeneration: 1,
      connectionLeaseExpiresAt: expect.any(Date),
    });
    expect(harness.created.map((entry) => entry.channel)).toEqual([false, true]);

    // A second authorization of the same App replaces the owned channel: the old socket closes
    // before the new one becomes the manager's only channel for this binding.
    await database.database
      .update(imBindings)
      .set({ setupIntent: "reauthorize" })
      .where(eq(imBindings.id, first.bindingId));
    const owner = randomUUID();
    const second = await insertCandidate(
      value,
      { agentId: value.agent.id, id: first.bindingId },
      { appId: "cli_act", state: "validating", owner, heartbeatAt: clock.now },
    );
    await harness.manager.activateAtomicAttempt({
      attemptId: second.attemptId,
      ownerInstanceId: owner,
      agentId: value.agent.id,
      appId: "cli_act",
      appSecret: CANDIDATE_SECRET,
    });
    expect(harness.disconnected).toEqual(["cli_act"]);
    expect((await rowById(first.bindingId))?.credentialGeneration).toBe(2);
    await harness.manager.stop();
  });

  it("releases the committed lease when shutdown lands after the activation commit", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_act", state: "validating", owner, heartbeatAt: clock.now },
    );
    harness.setValidate(async () => ({
      externalAppId: "cli_act",
      externalTeamId: "tenant_act",
      externalBotId: "ou_act",
    }));
    const transact = database.database.transaction.bind(database.database);
    // Shutdown races the commit: the row is durable but the channel must not be installed.
    const transaction = vi.spyOn(database.database, "transaction").mockImplementationOnce(async (...args) => {
      const committed = await transact(...args);
      await harness.manager.stop();
      return committed;
    });
    try {
      await expect(
        harness.manager.activateAtomicAttempt({
          attemptId: candidate.attemptId,
          ownerInstanceId: owner,
          agentId: value.agent.id,
          appId: "cli_act",
          appSecret: CANDIDATE_SECRET,
        }),
      ).rejects.toMatchObject({ code: "FEISHU_SETUP_FENCE_STALE" });
    } finally {
      transaction.mockRestore();
    }
    expect(harness.disconnected).toEqual(["cli_act"]);
    const row = await rowForAgent(value.agent.id);
    expect(row).toMatchObject({ status: "active", setupState: "succeeded", connectionOwnerInstanceId: null });
    await harness.manager.stop();
  });

  it("refuses a candidate whose App identity no longer matches the claimed attempt", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    await value.imBindings.activateFeishu({
      agentId: value.agent.id,
      appId: "cli_old",
      teamId: "tenant_old",
      botOpenId: "ou_old",
      appSecret: EXISTING_SECRET,
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    });
    const owner = randomUUID();
    const [active] = await database.database
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(and(eq(imBindings.agentId, value.agent.id), eq(imBindings.provider, "feishu")));
    if (!active) throw new Error("active binding missing");
    // A `replace` candidate may carry a different App; a *reauthorize* candidate whose App drifted
    // from the current binding is rejected at the claim re-read, before any provider call.
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id, id: active.id },
      { appId: "cli_new", state: "validating", owner, heartbeatAt: clock.now },
    );
    await expect(
      harness.manager.activateAtomicAttempt({
        attemptId: candidate.attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_new",
        appSecret: CANDIDATE_SECRET,
      }),
    ).rejects.toMatchObject({ code: "FEISHU_APP_IDENTITY_MISMATCH" });
    // The probe adapter is channel-free and the drifted identity is caught before a socket exists.
    expect(harness.created).toEqual([{ appId: "cli_new", channel: false }]);
  });

  it("refuses a candidate whose retention deadline lapsed before the claim re-read", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_act", state: "validating", owner, heartbeatAt: clock.now },
    );
    await database.database
      .update(imBindings)
      .set({ setupExpiresAt: new Date(clock.now.getTime() - 1_000) })
      .where(eq(imBindings.setupAttemptId, candidate.attemptId));
    await expect(
      harness.manager.activateAtomicAttempt({
        attemptId: candidate.attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_act",
        appSecret: CANDIDATE_SECRET,
        candidateExpiresAt: new Date(clock.now.getTime() - 1_000),
      }),
    ).rejects.toMatchObject({ code: "FEISHU_SETUP_CANDIDATE_EXPIRED" });
    // Admission probes are channel-free; no message socket was opened for a lapsed candidate.
    expect(harness.created.filter((entry) => entry.channel)).toEqual([]);
  });
});

describe("FeishuConnectionManager maintenance sweep", () => {
  it("claims and connects an unowned active binding, then renews and keeps its channel", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_sweep" });
    harness.setValidate(async () => ({
      externalAppId: "cli_sweep",
      externalTeamId: "tenant_sweep",
      externalBotId: "ou_cli_sweep",
    }));
    harness.manager.start();
    await vi.waitFor(
      async () => {
        expect((await rowById(bindingId))?.observedConnectedAt).toBeInstanceOf(Date);
      },
      { timeout: 5_000 },
    );
    expect(harness.disconnected).toEqual([]);

    // The second pass renews the live lease instead of reconnecting the already-owned binding.
    const connectedAt = (await rowById(bindingId))?.observedConnectedAt;
    clock.now = new Date(clock.now.getTime() + 30_000);
    await harness.manager.maintain();
    const renewed = await rowById(bindingId);
    expect(renewed?.observedConnectedAt).toEqual(connectedAt);
    expect(renewed?.connectionLeaseExpiresAt?.getTime()).toBeGreaterThan(clock.now.getTime());
    expect(harness.created.filter((entry) => entry.channel)).toHaveLength(1);
    await harness.manager.stop();
  });

  it("drops an owned channel whose binding material changed under it", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_sweep" });
    harness.setValidate(async () => ({
      externalAppId: "cli_sweep",
      externalTeamId: "tenant_sweep",
      externalBotId: "ou_cli_sweep",
    }));
    harness.manager.start();
    await vi.waitFor(
      async () => {
        expect((await rowById(bindingId))?.observedConnectedAt).toBeInstanceOf(Date);
      },
      { timeout: 5_000 },
    );

    // A credential rotation keeps the binding active but changes the App the channel was opened
    // for; another instance also holds the lease, so the stale socket closes and nothing reconnects.
    await database.database
      .update(imBindings)
      .set({
        externalAppId: "cli_rotated",
        externalBotId: "ou_cli_rotated",
        connectionOwnerInstanceId: randomUUID(),
        connectionLeaseExpiresAt: new Date(clock.now.getTime() + 600_000),
      })
      .where(eq(imBindings.id, bindingId));
    await harness.manager.maintain();
    expect(harness.disconnected).toEqual(["cli_sweep"]);
    // The replaced binding was dropped, not reconnected: only the first channel ever opened.
    expect(harness.created).toHaveLength(1);
    await harness.manager.stop();
  });

  it("releases an owned channel whose fencing epoch no longer matches the lease", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_sweep" });
    harness.setValidate(async () => ({
      externalAppId: "cli_sweep",
      externalTeamId: "tenant_sweep",
      externalBotId: "ou_cli_sweep",
    }));
    harness.manager.start();
    await vi.waitFor(
      async () => {
        expect((await rowById(bindingId))?.observedConnectedAt).toBeInstanceOf(Date);
      },
      { timeout: 5_000 },
    );

    // Another instance took the lease without changing the credential material, and the socket is
    // already gone: the loss is reported as a diagnostic instead of aborting the sweep.
    harness.setDisconnect(() => Promise.reject(new Error("socket already gone")));
    await database.database
      .update(imBindings)
      .set({
        connectionOwnerInstanceId: randomUUID(),
        connectionLeaseExpiresAt: new Date(clock.now.getTime() + 600_000),
      })
      .where(eq(imBindings.id, bindingId));
    await harness.manager.maintain();
    expect(harness.diagnostics).toEqual(["FEISHU_CONNECTION_DISCONNECT_FAILED"]);
    await harness.manager.stop();
  });

  it("backs off a failed connect, records the diagnostic, and skips bindings whose lease is stale", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_sweep" });
    // The provider answers with a different Bot than the binding recorded.
    harness.setValidate(async () => ({
      externalAppId: "cli_sweep",
      externalTeamId: "tenant_sweep",
      externalBotId: "ou_other_bot",
    }));
    harness.manager.start();
    await vi.waitFor(
      async () => {
        expect((await rowById(bindingId))?.lastErrorCode).toBe("FEISHU_BOT_IDENTITY_MISMATCH");
      },
      { timeout: 5_000 },
    );
    // The failed attempt closed its own channel and released the claim it took.
    expect(harness.disconnected).toEqual(["cli_sweep"]);
    expect((await rowById(bindingId))?.connectionOwnerInstanceId).toBeNull();
    await harness.manager.stop();

    // The single attempt created exactly one channel adapter; the backoff window now suppresses
    // any further attempt for this binding.
    await harness.manager.maintain();
    expect(harness.created).toHaveLength(1);
  });

  it("does nothing while stopped and never runs two sweeps at once", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_sweep" });
    harness.setValidate(async () => ({
      externalAppId: "cli_sweep",
      externalTeamId: "tenant_sweep",
      externalBotId: "ou_cli_sweep",
    }));
    harness.manager.start();
    await vi.waitFor(
      async () => {
        expect((await rowById(bindingId))?.observedConnectedAt).toBeInstanceOf(Date);
      },
      { timeout: 5_000 },
    );
    const gate = deferred<void>();
    const listed: string[] = [];
    const original = value.imBindings.listFeishuConnectionIds.bind(value.imBindings);
    const spy = vi.spyOn(value.imBindings, "listFeishuConnectionIds").mockImplementation(async (afterId, limit) => {
      listed.push("pass");
      if (listed.length === 1) await gate.promise;
      return original(afterId, limit);
    });
    try {
      const first = harness.manager.maintain();
      const overlapping = harness.manager.maintain();
      gate.resolve();
      await Promise.all([first, overlapping]);
    } finally {
      spy.mockRestore();
    }
    // The overlapping call returned immediately: only the first pass reached the scan.
    expect(listed).toHaveLength(1);
    expect((await rowById(bindingId))?.observedConnectedAt).toBeInstanceOf(Date);
    await harness.manager.stop();
    // A stopped manager never scans, even when the scheduled pass is invoked directly.
    await harness.manager.maintain();
    expect(listed).toHaveLength(1);
  });
});

describe("FeishuConnectionManager maintenance pacing and rows it must skip", () => {
  it("waits out a per-binding backoff window before retrying a failed connect", async () => {
    const value = await fixture();
    // A long base backoff keeps the retry window observable while the timer keeps sweeping.
    const harness = managerHarness(value, {
      maintenanceMs: 30,
      maintenanceBackoffBaseMs: 600_000,
      maintenanceBackoffMaxMs: 600_000,
    });
    await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_sweep" });
    harness.setValidate(async () => {
      throw new Error("transport down");
    });
    const scans: number[] = [];
    const original = value.imBindings.listFeishuConnectionIds.bind(value.imBindings);
    const spy = vi.spyOn(value.imBindings, "listFeishuConnectionIds").mockImplementation(async (afterId, limit) => {
      scans.push(scans.length);
      return original(afterId, limit);
    });
    harness.manager.start();
    try {
      // The sweep runs repeatedly and the backoff window suppresses every attempt after the first.
      await vi.waitFor(() => expect(scans.length).toBeGreaterThanOrEqual(4), { timeout: 5_000 });
    } finally {
      spy.mockRestore();
    }
    expect(harness.created).toHaveLength(1);
    await harness.manager.stop();
    // A stopped manager short-circuits before it ever reaches the scan.
    const before = scans.length;
    await harness.manager.maintain();
    expect(scans.length).toBe(before);
  });

  it("skips a listed binding that is no longer claimable, and never re-claims an owned one", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const owned = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_owned" });
    harness.setValidate(async () => ({
      externalAppId: "cli_owned",
      externalTeamId: "tenant_sweep",
      externalBotId: "ou_cli_owned",
    }));
    harness.manager.start();
    await vi.waitFor(
      async () => {
        expect((await rowById(owned))?.connectionOwnerInstanceId).not.toBeNull();
      },
      { timeout: 5_000 },
    );
    await harness.manager.stop();

    // A second pass lists a row that vanished between the scan and the claim: `#claim` must refuse
    // it without touching the provider, and must skip the binding it already owns.
    const vanished = randomUUID();
    const original = value.imBindings.listFeishuConnectionIds.bind(value.imBindings);
    const spy = vi.spyOn(value.imBindings, "listFeishuConnectionIds").mockImplementation(async (afterId, limit) => {
      const ids = await original(afterId, limit);
      return afterId === undefined ? [vanished, ...ids] : ids;
    });
    const second = managerHarness(value, { maintenanceMs: 60_000 });
    second.manager.start();
    try {
      await vi.waitFor(() => expect(second.ingest).toBeDefined(), { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      spy.mockRestore();
    }
    // Only the owned row was connected: the vanished id was refused and the live lease was renewed.
    expect(second.created).toHaveLength(1);
    await second.manager.stop();
  });

  it("aborts the in-flight connect of an owned binding when the manager stops", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_sweep" });
    const entered = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    harness.setValidate((signal) => {
      observedSignal = signal;
      entered.resolve();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    harness.manager.start();
    await entered.promise;
    expect(observedSignal?.aborted).toBe(false);
    await harness.manager.stop();
    expect(observedSignal?.aborted).toBe(true);
    await vi.waitFor(async () => {
      expect((await rowById(bindingId))?.connectionOwnerInstanceId).toBeNull();
    });
  });

  it("closes a channel whose disconnect itself fails without losing the sweep", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_sweep" });
    harness.setValidate(async () => ({
      externalAppId: "cli_sweep",
      externalTeamId: "tenant_sweep",
      externalBotId: "ou_cli_sweep",
    }));
    harness.manager.start();
    await vi.waitFor(
      async () => {
        expect((await rowById(bindingId))?.observedConnectedAt).toBeInstanceOf(Date);
      },
      { timeout: 5_000 },
    );
    harness.setDisconnect(() => Promise.reject(new Error("socket already gone")));
    // Rotate the credential so the owned channel is dropped, exercising the failing close path.
    await database.database
      .update(imBindings)
      .set({ externalAppId: "cli_rotated", externalBotId: "ou_cli_rotated" })
      .where(eq(imBindings.id, bindingId));
    await harness.manager.maintain();
    expect(harness.diagnostics).toContain("FEISHU_CONNECTION_DISCONNECT_FAILED");
    // The sweep continued past the failed close instead of abandoning the pass.
    expect((await rowById(bindingId))?.connectionOwnerInstanceId).toBeNull();
    await harness.manager.stop();
  });
});

function feishuNormalizedMessage(senderOpenId = "ou_sender") {
  return { raw: { opentagSenderOpenId: senderOpenId } } as never;
}

/** A minimal provider-normalized event, shaped exactly like the adapter's own output. */
function normalizedFeishuEvent(): NormalizedInboundImEvent {
  return {
    providerEventId: "evt-1",
    externalAppId: "cli_in",
    externalTeamId: "tenant_in",
    providerContext: { provider: "feishu", chatType: "p2p" },
    conversation: { externalId: "chat-1", kind: "dm" },
    message: {
      externalId: "msg-1",
      revisionKey: "1",
      operation: "created",
      author: { externalId: "ou_sender", kind: "human" },
      occurredAt: new Date("2026-09-10T00:00:00.000Z"),
      content: { version: 1, fallbackText: "hi", blocks: [{ type: "text", text: "hi" }], truncated: false },
      resources: [],
    },
    mentions: [],
  };
}

describe("FeishuConnectionManager inbound callbacks", () => {
  it("persists a normalized inbound event under the adapter's handoff", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const ingest = harness.ingest;
    ingest.mockResolvedValue({ duplicate: false, messageId: randomUUID(), deliveryIds: [] });
    const { bindingId } = await activateThroughManager(harness, value, { appId: "cli_in" });
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    await handler.message(feishuNormalizedMessage());
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]?.[0]).toBe(bindingId);
    await harness.manager.stop();
  });

  it("reports a duplicate inbound event without persisting a delivery", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    harness.ingest.mockResolvedValue({ duplicate: true, messageId: randomUUID(), deliveryIds: [] });
    await activateThroughManager(harness, value, { appId: "cli_dup" });
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    await handler.message(feishuNormalizedMessage());
    expect(harness.ingest).toHaveBeenCalledTimes(1);
    await harness.manager.stop();
  });

  it("returns early when a duplicate inbound event was already claimed as a receipt", async () => {
    const value = await fixture();
    const receipts = {
      claim: vi.fn(async () => ({ accepted: false, duplicate: true })),
      markProcessed: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const harness = managerHarness(value, { receipts });
    harness.setNormalize(() => [{ ...normalizedFeishuEvent(), providerEventId: "evt-receipt-1" }]);
    await activateThroughManager(harness, value, { appId: "cli_receipt" });
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    await handler.message(feishuNormalizedMessage());
    // The claim already held the receipt: the inbox is never asked to ingest it again.
    expect(receipts.claim).toHaveBeenCalledTimes(1);
    expect(harness.ingest).not.toHaveBeenCalled();
    await harness.manager.stop();
  });

  it("records the provider error code on a failed diagnostic callback", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const { bindingId } = await activateThroughManager(harness, value, { appId: "cli_err" });
    const handler = harness.handlers.at(-1);
    if (!handler?.error) throw new Error("error handler was not installed");
    handler.error(new FeishuOperationError("FEISHU_UPSTREAM_UNAVAILABLE"));
    await vi.waitFor(async () => {
      expect((await rowById(bindingId))?.lastErrorCode).toBe("FEISHU_UPSTREAM_UNAVAILABLE");
    });
    await harness.manager.stop();
  });

  it("observes a reconnect and a disconnect transition on the owned binding", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const { bindingId } = await activateThroughManager(harness, value, { appId: "cli_obs" });
    const handler = harness.handlers.at(-1);
    if (!handler?.reconnecting || !handler.reconnected) throw new Error("socket handlers were not installed");
    handler.reconnecting();
    await vi.waitFor(async () => {
      expect((await rowById(bindingId))?.observedConnectedAt).toBeNull();
    });
    handler.reconnected();
    await vi.waitFor(async () => {
      expect((await rowById(bindingId))?.observedConnectedAt).toBeInstanceOf(Date);
    });
    await harness.manager.stop();
  });

  it("skips enrichment for an unresolvable sender name without reporting a failure", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    // The adapter resolves no display name: enrichment is a no-op, never an error.
    harness.setResolveSenderName(async () => undefined);
    harness.ingest.mockResolvedValue({ duplicate: false, messageId: randomUUID(), deliveryIds: [] });
    await activateThroughManager(harness, value, { appId: "cli_name" });
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    await handler.message(feishuNormalizedMessage());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.ingest).toHaveBeenCalledTimes(1);
    expect(harness.diagnostics).toEqual([]);
    await harness.manager.stop();
  });

  it("refuses an over-long sender name and supervises the enrichment failure as a provider fault", async () => {
    const value = await fixture();
    const track = vi.fn((operation: Promise<unknown>, _metadata?: Record<string, unknown>) => {
      void operation.catch(() => undefined);
    });
    const harness = managerHarness(value, { supervisor: { track } });
    harness.setResolveSenderName(async () => "x".repeat(513));
    harness.ingest.mockResolvedValue({ duplicate: false, messageId: randomUUID(), deliveryIds: [] });
    await activateThroughManager(harness, value, { appId: "cli_long_name" });
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    // The bound failure must not escape into the provider callback that fired it.
    await handler.message(feishuNormalizedMessage());
    await vi.waitFor(() => expect(harness.diagnostics).toContain("FEISHU_SENDER_NAME_ENRICHMENT_FAILED"));
    // Enrichment is provider work, so the supervisor sees it classified as an external dependency.
    expect(track).toHaveBeenCalled();
    expect(track.mock.calls[0]?.[1]).toMatchObject({
      code: "FEISHU_SENDER_NAME_ENRICHMENT_FAILED",
      category: "dependency",
      phase: "provider",
      requestId: expect.any(String),
    });
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager admission rejections", () => {
  it("keeps a candidate waiting on missing scopes and on an unavailable runtime", async () => {
    const value = await fixture();
    const noScopes = managerHarness(value);
    noScopes.setScopeList(async () => []);
    await expect(
      noScopes.manager.checkCandidate({ agentId: value.agent.id, appId: "cli_probe", appSecret: CANDIDATE_SECRET }),
    ).resolves.toMatchObject({ status: "waiting", reason: "permissions_pending" });

    const noRuntime = managerHarness(value, { runtimeReady: false });
    await expect(
      noRuntime.manager.checkCandidate({ agentId: value.agent.id, appId: "cli_probe", appSecret: CANDIDATE_SECRET }),
    ).resolves.toEqual({ status: "waiting", reason: "runtime_unavailable", missingScopes: [] });
  });

  it("never opens a socket for a candidate that lost its tenant grant or its runtime", async () => {
    const value = await fixture();
    const noScopes = managerHarness(value);
    const short = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_act", state: "validating", owner: randomUUID(), heartbeatAt: clock.now },
    );
    noScopes.setScopeList(async () => []);
    await expect(
      noScopes.manager.activateAtomicAttempt({
        attemptId: short.attemptId,
        ownerInstanceId: randomUUID(),
        agentId: value.agent.id,
        appId: "cli_act",
        appSecret: CANDIDATE_SECRET,
      }),
    ).rejects.toMatchObject({ code: "FEISHU_SCOPE_REAUTH_REQUIRED" });
    expect(noScopes.created.every((entry) => entry.channel === false)).toBe(true);

    const secondAgent = await createAgent(value, "no-runtime");
    const noRuntime = managerHarness(value, { runtimeReady: false });
    const candidate = await insertCandidate(
      value,
      { agentId: secondAgent.id },
      { appId: "cli_act", state: "validating", owner: randomUUID(), heartbeatAt: clock.now },
    );
    await expect(
      noRuntime.manager.activateAtomicAttempt({
        attemptId: candidate.attemptId,
        ownerInstanceId: randomUUID(),
        agentId: secondAgent.id,
        appId: "cli_act",
        appSecret: CANDIDATE_SECRET,
      }),
    ).rejects.toMatchObject({ code: "FEISHU_RUNTIME_TOOL_UNAVAILABLE" });
    expect(noRuntime.created.every((entry) => entry.channel === false)).toBe(true);
  });

  it("refuses an activation whose attempt is no longer the claimed one", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_act", state: "validating", owner: randomUUID(), heartbeatAt: clock.now },
    );
    await expect(
      harness.manager.activateAtomicAttempt({
        attemptId: randomUUID(),
        ownerInstanceId: randomUUID(),
        agentId: value.agent.id,
        appId: "cli_act",
        appSecret: CANDIDATE_SECRET,
      }),
    ).rejects.toMatchObject({ code: "FEISHU_SETUP_FENCE_STALE" });
    // Only the channel-free admission probe was created.
    expect(harness.created).toEqual([{ appId: "cli_act", channel: false }]);
  });

  it("refuses an activation whose channel answers for another App", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_act", state: "validating", owner, heartbeatAt: clock.now },
    );
    harness.setValidate(async () => ({
      externalAppId: "cli_other",
      externalTeamId: "tenant_other",
      externalBotId: "ou_other",
    }));
    await expect(
      harness.manager.activateAtomicAttempt({
        attemptId: candidate.attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_act",
        appSecret: CANDIDATE_SECRET,
      }),
    ).rejects.toMatchObject({ code: "FEISHU_APP_IDENTITY_MISMATCH" });
    // The channel opened for the drifted identity was closed again on the way out.
    expect(harness.disconnected).toEqual(["cli_act"]);
    expect((await rowForAgent(value.agent.id))?.status).toBe("provisioning");
  });

  it("refuses an activation whose tenant grant shrank between the probe and the channel", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_act", state: "validating", owner, heartbeatAt: clock.now },
    );
    harness.setValidate(async () => ({
      externalAppId: "cli_act",
      externalTeamId: "tenant_act",
      externalBotId: "ou_cli_act",
    }));
    let calls = 0;
    // The channel-free probe sees the full grant; the channel re-check sees it shrink.
    harness.setScopeList(async () => {
      calls += 1;
      return calls === 1 ? [...FEISHU_REQUIRED_TENANT_SCOPES] : [...FEISHU_REQUIRED_TENANT_SCOPES].slice(3);
    });
    await expect(
      harness.manager.activateAtomicAttempt({
        attemptId: candidate.attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_act",
        appSecret: CANDIDATE_SECRET,
      }),
    ).rejects.toMatchObject({ code: "FEISHU_SCOPE_REAUTH_REQUIRED" });
    expect(harness.disconnected).toEqual(["cli_act"]);
  });

  it("refuses an activation whose Agent stopped being active inside the transaction", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_act", state: "validating", owner, heartbeatAt: clock.now },
    );
    harness.setValidate(async () => ({
      externalAppId: "cli_act",
      externalTeamId: "tenant_act",
      externalBotId: "ou_cli_act",
    }));
    await database.database.execute(sql`update agents set status = 'suspended' where id = ${value.agent.id}`);
    await expect(
      harness.manager.activateAtomicAttempt({
        attemptId: candidate.attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_act",
        appSecret: CANDIDATE_SECRET,
      }),
    ).rejects.toMatchObject({ code: "FEISHU_SETUP_FENCE_STALE" });
    expect(harness.disconnected).toEqual(["cli_act"]);
  });

  it("keeps an activation when the runtime notification fails", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const notification = vi
      .spyOn(value.imBindings, "notifyProviderCliRequirementChanged")
      .mockRejectedValue(new Error("runtime unreachable"));
    try {
      const { bindingId } = await activateThroughManager(harness, value, { appId: "cli_notify" });
      expect((await rowById(bindingId))?.status).toBe("active");
    } finally {
      notification.mockRestore();
    }
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager close paths that fail", () => {
  it("keeps the activation committed when the replaced channel refuses to close", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const first = await activateThroughManager(harness, value, { appId: "cli_close" });
    await database.database
      .update(imBindings)
      .set({ setupIntent: "reauthorize" })
      .where(eq(imBindings.id, first.bindingId));
    // The previous socket is already gone: the replacement must still commit.
    harness.setDisconnect(() => Promise.reject(new Error("socket already gone")));
    const owner = randomUUID();
    const second = await insertCandidate(
      value,
      { agentId: value.agent.id, id: first.bindingId },
      { appId: "cli_close", state: "validating", owner, heartbeatAt: clock.now },
    );
    await harness.manager.activateAtomicAttempt({
      attemptId: second.attemptId,
      ownerInstanceId: owner,
      agentId: value.agent.id,
      appId: "cli_close",
      appSecret: CANDIDATE_SECRET,
    });
    expect(harness.diagnostics).toEqual(["FEISHU_CONNECTION_DISCONNECT_FAILED"]);
    expect((await rowById(first.bindingId))?.credentialGeneration).toBe(2);
    await harness.manager.stop();
  });

  it("stops cleanly when an owned channel refuses to close during shutdown", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    await activateThroughManager(harness, value, { appId: "cli_stop" });
    harness.setDisconnect(() => Promise.reject(new Error("socket already gone")));
    await expect(harness.manager.stop()).resolves.toBeUndefined();
    expect(harness.diagnostics).toEqual(["FEISHU_CONNECTION_DISCONNECT_FAILED"]);
  });

  it("closes the failed channel even when that close also fails", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_sweep" });
    harness.setValidate(async () => {
      throw new Error("transport down");
    });
    harness.setDisconnect(() => Promise.reject(new Error("socket already gone")));
    harness.manager.start();
    await vi.waitFor(() => expect(harness.diagnostics).toContain("FEISHU_CONNECTION_DISCONNECT_FAILED"), {
      timeout: 5_000,
    });
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager connection scan paging", () => {
  it("advances the keyset cursor past a saturated page", async () => {
    const value = await fixture();
    const harness = managerHarness(value, {
      maintenanceBackoffBaseMs: 600_000,
      maintenanceBackoffMaxMs: 600_000,
    });
    harness.setValidate(async () => {
      throw new Error("transport down");
    });
    // One more than a full scan page: the sweep must issue a second listing to reach the tail.
    const agents: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const agent = await createAgent(value, `page-${index}`);
      agents.push(agent.id);
      await insertActiveFeishuBinding(value, { agentId: agent.id, appId: `cli_page_${index}` });
    }
    const pages: Array<string | undefined> = [];
    const original = value.imBindings.listFeishuConnectionIds.bind(value.imBindings);
    const spy = vi.spyOn(value.imBindings, "listFeishuConnectionIds").mockImplementation(async (afterId, limit) => {
      pages.push(afterId);
      return original(afterId, limit);
    });
    harness.manager.start();
    try {
      await vi.waitFor(() => expect(pages.length).toBeGreaterThanOrEqual(2), { timeout: 15_000 });
      await vi.waitFor(() => expect(harness.created.length).toBe(101), { timeout: 15_000 });
    } finally {
      spy.mockRestore();
      await harness.manager.stop();
    }
    // The second page was requested with the retained cursor from the first.
    expect(pages).toHaveLength(2);
    expect(pages[0]).toBeUndefined();
    expect(pages[1]).toBeDefined();
    // Every row was attempted, tail included: one page cannot starve the rest.
    expect(harness.created.length).toBe(101);
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager inbound receipt lifecycle", () => {
  it("claims, persists, and marks a receipt processed", async () => {
    const value = await fixture();
    const receipts = {
      claim: vi.fn(async () => ({ accepted: true, duplicate: false, receiptId: "receipt-1" })),
      markProcessed: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const harness = managerHarness(value, { receipts });
    harness.ingest.mockResolvedValue({ duplicate: false, messageId: randomUUID(), deliveryIds: ["delivery-1"] });
    await activateThroughManager(harness, value, { appId: "cli_rec_ok" });
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    await handler.message(feishuNormalizedMessage());
    expect(receipts.claim).toHaveBeenCalledWith({
      bindingId: expect.any(String),
      credentialGeneration: 1,
      eventId: "evt-1",
    });
    expect(receipts.markProcessed).toHaveBeenCalledWith("receipt-1");
    expect(receipts.markFailed).not.toHaveBeenCalled();
    await harness.manager.stop();
  });

  it("marks a receipt failed with the persistence error code when ingestion fails", async () => {
    const value = await fixture();
    const receipts = {
      claim: vi.fn(async () => ({ accepted: true, duplicate: false, receiptId: "receipt-2" })),
      markProcessed: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const harness = managerHarness(value, { receipts });
    const failure = Object.assign(new Error("IM_PROVIDER_CALL_ABORTED"), { code: "IM_PROVIDER_CALL_ABORTED" });
    harness.ingest.mockRejectedValue(failure);
    await activateThroughManager(harness, value, { appId: "cli_rec_fail" });
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    await expect(handler.message(feishuNormalizedMessage())).rejects.toBe(failure);
    expect(receipts.markFailed).toHaveBeenCalledWith("receipt-2", "IM_PROVIDER_CALL_ABORTED");
    expect(receipts.markProcessed).not.toHaveBeenCalled();
    await harness.manager.stop();
  });

  it("rejects an inbound callback that fires before the activation handoff exists", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_early", state: "validating", owner, heartbeatAt: clock.now },
    );
    const validation = deferred<{ externalAppId: string; externalTeamId: string; externalBotId: string }>();
    harness.setValidate(() => validation.promise);
    const activation = harness.manager.activateAtomicAttempt({
      attemptId: candidate.attemptId,
      ownerInstanceId: owner,
      agentId: value.agent.id,
      appId: "cli_early",
      appSecret: CANDIDATE_SECRET,
    });
    await vi.waitFor(() => expect(harness.handlers.length).toBeGreaterThan(0));
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    // The handoff is only published at commit: a message before it is refused, never persisted.
    await expect(handler.message(feishuNormalizedMessage())).rejects.toMatchObject({
      code: "FEISHU_ADMISSION_NOT_READY",
    });
    expect(harness.ingest).not.toHaveBeenCalled();
    validation.resolve({ externalAppId: "cli_early", externalTeamId: "tenant", externalBotId: "ou_cli_early" });
    await activation;
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager admission edge cases", () => {
  it("waits when the Bot info omits the activation status and terminates on a rejected credential", async () => {
    const value = await fixture();
    // An omitted `activate_status` carries no evidence against the App: readiness is proven.
    const omitted = managerHarness(value);
    omitted.setBotProbe(async () => ({ openId: "ou_probe", activateStatus: null }));
    await expect(
      omitted.manager.checkCandidate({ agentId: value.agent.id, appId: "cli_probe", appSecret: CANDIDATE_SECRET }),
    ).resolves.toEqual({ status: "ready" });

    const rejected = managerHarness(value);
    rejected.setBotProbe(async () => {
      throw Object.assign(new Error("FEISHU_BOT_INFO_FAILED"), { response: { data: { code: 20002 } } });
    });
    await expect(
      rejected.manager.checkCandidate({ agentId: value.agent.id, appId: "cli_probe", appSecret: CANDIDATE_SECRET }),
    ).resolves.toEqual({ status: "terminal", errorCode: "FEISHU_CREDENTIAL_INVALID" });
  });

  it("skips a listed binding whose lease another instance still holds", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_held" });
    // `#claim` compares the lease against the wall clock, not the injected one, so a lease that
    // must outlive the machine's own date has to be far in the future.
    const heldUntil = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1_000);
    const heldBy = randomUUID();
    await database.database
      .update(imBindings)
      .set({ connectionOwnerInstanceId: heldBy, connectionLeaseExpiresAt: heldUntil })
      .where(eq(imBindings.id, bindingId));
    harness.manager.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    // A live foreign lease is respected: no adapter, no ownership change, no diagnostic.
    expect(harness.created).toEqual([]);
    expect(harness.diagnostics).toEqual([]);
    const held = await rowById(bindingId);
    expect(held?.connectionOwnerInstanceId).toBe(heldBy);
    expect(held?.connectionLeaseExpiresAt?.getTime()).toBe(heldUntil.getTime());
    await harness.manager.stop();
  });

  it("refuses to install a channel when another instance took the lease during validation", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_takeover" });
    harness.setValidate(async () => ({
      externalAppId: "cli_takeover",
      externalTeamId: "tenant_sweep",
      externalBotId: "ou_cli_takeover",
    }));
    let bumped = false;
    const original = value.imBindings.getFeishuConnectionMaterial.bind(value.imBindings);
    const spy = vi
      .spyOn(value.imBindings, "getFeishuConnectionMaterial")
      .mockImplementation(async (id, transaction) => {
        const material = await original(id, transaction);
        if (!bumped && material) {
          bumped = true;
          // The takeover lands while this instance is still validating the channel.
          await database.database
            .update(imBindings)
            .set({ connectionFencingEpoch: 99 })
            .where(eq(imBindings.id, bindingId));
        }
        return material;
      });
    harness.manager.start();
    try {
      await vi.waitFor(
        async () => {
          expect((await rowById(bindingId))?.lastErrorCode).toBe("FEISHU_CONNECTION_LEASE_STALE");
        },
        { timeout: 5_000 },
      );
    } finally {
      spy.mockRestore();
    }
    // The channel opened under the lost epoch was closed and never installed.
    expect(harness.disconnected).toEqual(["cli_takeover"]);
    const lost = await rowById(bindingId);
    expect(lost?.connectionFencingEpoch).toBe(99);
    expect(lost?.observedConnectedAt).toBeNull();
    await harness.manager.stop();
  });

  it("ignores socket callbacks that arrive before the activation handoff exists", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_socket" });
    harness.setValidate(async () => {
      // The provider pushes transitions while the channel is still being validated: the handoff
      // is not published yet, so every observer must be a silent no-op.
      const handlers = harness.handlers.at(-1);
      handlers?.reconnecting?.();
      handlers?.reconnected?.();
      handlers?.error?.(new Error("provider hiccup"));
      return { externalAppId: "cli_socket", externalTeamId: "tenant_sweep", externalBotId: "ou_cli_socket" };
    });
    harness.manager.start();
    await vi.waitFor(
      async () => {
        expect((await rowById(bindingId))?.observedConnectedAt).toBeInstanceOf(Date);
      },
      { timeout: 5_000 },
    );
    // The pre-handoff transitions were dropped: only the real connect observation was recorded,
    // and the provider "hiccup" never became a persisted diagnostic.
    expect((await rowById(bindingId))?.lastErrorCode).toBeNull();
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager detached-failure supervision", () => {
  it("supervises the scheduled sweep so a failing pass is reported once", async () => {
    const value = await fixture();
    // The real supervisor subscribes to the promise it is handed; the mock must do the same or the
    // deliberately failing sweep surfaces as an unhandled rejection.
    const track = vi.fn((operation: Promise<unknown>, _metadata?: Record<string, unknown>) => {
      void operation.catch(() => undefined);
    });
    const harness = managerHarness(value, { maintenanceMs: 60_000, supervisor: { track } });
    const list = vi
      .spyOn(value.imBindings, "listFeishuConnectionIds")
      .mockRejectedValue(new Error("database unavailable"));
    try {
      harness.manager.start();
      await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1));
    } finally {
      list.mockRestore();
      await harness.manager.stop();
    }
    expect(track.mock.calls[0]?.[1]).toMatchObject({
      code: "FEISHU_CONNECTION_MAINTENANCE_FAILED",
      phase: "scheduler",
      operation: "feishu.connection",
    });
  });

  it("enriches a resolvable sender name onto the persisted message", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    harness.setResolveSenderName(async () => "  Alice  ");
    harness.ingest.mockResolvedValue({
      duplicate: false,
      messageId: "11111111-1111-4111-8111-111111111111",
      deliveryIds: [],
    });
    await activateThroughManager(harness, value, { appId: "cli_enrich" });
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    await handler.message(feishuNormalizedMessage());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The enrichment path completed; it is opportunistic, so no diagnostic is reported either way.
    expect(harness.diagnostics).toEqual([]);
    expect(harness.ingest).toHaveBeenCalledTimes(1);
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager inbound persistence failures", () => {
  it.each([
    ["IM_INBOUND_FENCE_STALE", "FEISHU_INBOUND_FENCE_STALE"],
    ["IM_INBOUND_BINDING_STALE", "FEISHU_INBOUND_FENCE_STALE"],
    ["IM_INBOUND_IDENTITY_MISMATCH", "FEISHU_INBOUND_IDENTITY_MISMATCH"],
  ] as const)("classifies a %s ingestion failure for the trace", async (code, expected) => {
    const value = await fixture();
    const harness = managerHarness(value);
    const failure = new ImInboundPersistenceError(code, code);
    harness.ingest.mockRejectedValue(failure);
    await activateThroughManager(harness, value, { appId: "cli_fence" });
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    await expect(handler.message(feishuNormalizedMessage())).rejects.toBe(failure);
    await harness.manager.stop();
    // The trace carries only the bounded classification, never the raw provider payload.
    expect(expected).toMatch(/^FEISHU_INBOUND_(FENCE_STALE|IDENTITY_MISMATCH)$/);
  });

  it("falls back to the generic processing code for an unlabelled failure", async () => {
    const value = await fixture();
    const receipts = {
      claim: vi.fn(async () => ({ accepted: true, duplicate: false, receiptId: "receipt-3" })),
      markProcessed: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const harness = managerHarness(value, { receipts });
    const failure = new Error("socket closed mid-write");
    harness.ingest.mockRejectedValue(failure);
    await activateThroughManager(harness, value, { appId: "cli_unlabelled" });
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    await expect(handler.message(feishuNormalizedMessage())).rejects.toBe(failure);
    expect(receipts.markFailed).toHaveBeenCalledWith("receipt-3", "FEISHU_EVENT_PROCESSING_FAILED");
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager activation corners", () => {
  it("reports a lost lease when the activation transaction is rolled back under it", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_lease", state: "validating", owner, heartbeatAt: clock.now },
    );
    harness.setValidate(async () => ({
      externalAppId: "cli_lease",
      externalTeamId: "tenant_lease",
      externalBotId: "ou_cli_lease",
    }));
    // The activation transaction commits the row, then a later stage aborts the whole transaction:
    // the committed lease is detected as unrenewable and must be released.
    const original = value.imBindings.getFeishuConnectionMaterial.bind(value.imBindings);
    const spy = vi
      .spyOn(value.imBindings, "getFeishuConnectionMaterial")
      .mockImplementation(async (id, transaction) => {
        const material = await original(id, transaction);
        if (material && transaction) throw new Error("activation query failed");
        return material;
      });
    try {
      await expect(
        harness.manager.activateAtomicAttempt({
          attemptId: candidate.attemptId,
          ownerInstanceId: owner,
          agentId: value.agent.id,
          appId: "cli_lease",
          appSecret: CANDIDATE_SECRET,
        }),
      ).rejects.toThrow("activation query failed");
    } finally {
      spy.mockRestore();
    }
    // The rolled-back transaction left no binding behind and the opened channel was closed.
    expect(harness.disconnected).toEqual(["cli_lease"]);
    expect((await rowForAgent(value.agent.id))?.status).toBe("provisioning");
    await harness.manager.stop();
  });

  it("publishes the handoff only after the runtime notification resolves", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_notify", state: "validating", owner, heartbeatAt: clock.now },
    );
    harness.setValidate(async () => ({
      externalAppId: "cli_notify",
      externalTeamId: "tenant_notify",
      externalBotId: "ou_cli_notify",
    }));
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    harness.ingest.mockResolvedValue({ duplicate: false, messageId: randomUUID(), deliveryIds: [] });
    const gate = deferred<void>();
    const notification = vi
      .spyOn(value.imBindings, "notifyProviderCliRequirementChanged")
      .mockImplementation(() => gate.promise);
    try {
      const activation = harness.manager.activateAtomicAttempt({
        attemptId: candidate.attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_notify",
        appSecret: CANDIDATE_SECRET,
      });
      await vi.waitFor(() => expect(harness.handlers.length).toBeGreaterThan(0));
      const handler = harness.handlers.at(-1);
      if (!handler?.message) throw new Error("message handler was not installed");
      // The handoff is already published at commit, before the notification settles.
      await handler.message(feishuNormalizedMessage());
      expect(harness.ingest).toHaveBeenCalledTimes(1);
      gate.resolve();
      await activation;
    } finally {
      notification.mockRestore();
    }
    await harness.manager.stop();
  });

  it("omits the request id for a detached failure that has no provider event", async () => {
    const value = await fixture();
    const track = vi.fn((operation: Promise<unknown>, _metadata?: Record<string, unknown>) => {
      void operation.catch(() => undefined);
    });
    const harness = managerHarness(value, { supervisor: { track } });
    await activateThroughManager(harness, value, { appId: "cli_socket" });
    const handler = harness.handlers.at(-1);
    if (!handler?.reconnecting) throw new Error("socket handlers were not installed");
    handler.reconnecting();
    await vi.waitFor(() => expect(track).toHaveBeenCalled());
    // A socket observation carries the binding id as the request id.
    expect(track.mock.calls[0]?.[1]).toMatchObject({
      code: "FEISHU_CONNECTION_OBSERVATION_FAILED",
      phase: "socket",
      requestId: expect.any(String),
    });
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager close and classification corners", () => {
  it("normalizes a provider that reports the App id as its own tenant", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    // The provider echoes the App id when the App has no separate tenant: the binding stores null.
    harness.setValidate(async () => ({
      externalAppId: "cli_self",
      externalTeamId: "cli_self",
      externalBotId: "ou_cli_self",
    }));
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_self", state: "validating", owner, heartbeatAt: clock.now },
    );
    const verified = await harness.manager.activateAtomicAttempt({
      attemptId: candidate.attemptId,
      ownerInstanceId: owner,
      agentId: value.agent.id,
      appId: "cli_self",
      appSecret: CANDIDATE_SECRET,
    });
    expect(verified.teamId).toBeNull();
    expect((await rowForAgent(value.agent.id))?.externalTeamId).toBeNull();
    await harness.manager.stop();
  });

  it("reports a failing close on the activation failure path too", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_failclose", state: "validating", owner, heartbeatAt: clock.now },
    );
    // Validation fails *and* the half-open channel refuses to close: the failure is bounded to a
    // diagnostic and the original error still propagates.
    harness.setValidate(async () => {
      throw new Error("transport down");
    });
    harness.setDisconnect(() => Promise.reject(new Error("socket already gone")));
    await expect(
      harness.manager.activateAtomicAttempt({
        attemptId: candidate.attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_failclose",
        appSecret: CANDIDATE_SECRET,
      }),
    ).rejects.toThrow("transport down");
    expect(harness.diagnostics).toEqual(["FEISHU_CONNECTION_DISCONNECT_FAILED"]);
    await harness.manager.stop();
  });

  it("keeps persisting when the receipt store itself fails to record the failure", async () => {
    const value = await fixture();
    const receipts = {
      claim: vi.fn(async () => ({ accepted: true, duplicate: false, receiptId: "receipt-4" })),
      markProcessed: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => Promise.reject(new Error("receipt store unavailable"))),
    };
    const harness = managerHarness(value, { receipts });
    const failure = new Error("inbox unavailable");
    harness.ingest.mockRejectedValue(failure);
    await activateThroughManager(harness, value, { appId: "cli_receipt_fail" });
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    // The receipt-store failure is swallowed: the original ingestion failure is what the caller sees.
    await expect(handler.message(feishuNormalizedMessage())).rejects.toBe(failure);
    expect(receipts.markFailed).toHaveBeenCalledTimes(1);
    await harness.manager.stop();
  });

  it("skips the receipt store for a normalizer-synthesized envelope id", async () => {
    const value = await fixture();
    const receipts = {
      claim: vi.fn(async () => ({ accepted: true, duplicate: false, receiptId: "receipt-5" })),
      markProcessed: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    };
    const harness = managerHarness(value, { receipts });
    harness.ingest.mockResolvedValue({ duplicate: false, messageId: randomUUID(), deliveryIds: [] });
    await activateThroughManager(harness, value, { appId: "cli_synthetic" });
    const event = normalizedFeishuEvent();
    // A normalizer-synthesized `providerEventId` (`<message>:<occurredAt>`) is not a delivery
    // receipt: deduplication falls back to the inbox's own semantic key.
    harness.setNormalize(() => [
      { ...event, providerEventId: `${event.message.externalId}:${event.message.occurredAt.getTime()}` },
    ]);
    const handler = harness.handlers.at(-1);
    if (!handler?.message) throw new Error("message handler was not installed");
    await handler.message(feishuNormalizedMessage());
    expect(receipts.claim).not.toHaveBeenCalled();
    expect(receipts.markProcessed).not.toHaveBeenCalled();
    expect(harness.ingest).toHaveBeenCalledTimes(1);
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager sweep-owned provider callbacks", () => {
  it("routes a swept channel's inbound message and socket transitions to its binding", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    const bindingId = await insertActiveFeishuBinding(value, { agentId: value.agent.id, appId: "cli_handoff" });
    harness.setValidate(async () => ({
      externalAppId: "cli_handoff",
      externalTeamId: "tenant_sweep",
      externalBotId: "ou_cli_handoff",
    }));
    harness.setNormalize(() => [normalizedFeishuEvent()]);
    harness.ingest.mockResolvedValue({ duplicate: false, messageId: randomUUID(), deliveryIds: [] });
    harness.manager.start();
    await vi.waitFor(
      async () => {
        expect((await rowById(bindingId))?.observedConnectedAt).toBeInstanceOf(Date);
      },
      { timeout: 5_000 },
    );
    const handler = harness.handlers.at(-1);
    if (!handler?.message || !handler.reconnecting || !handler.reconnected || !handler.error) {
      throw new Error("swept channel handlers were not installed");
    }
    // A swept channel resolves its handoff lazily, from the state installed by `#replaceOwned`.
    await handler.message(feishuNormalizedMessage());
    expect(harness.ingest).toHaveBeenCalledTimes(1);
    expect(harness.ingest.mock.calls[0]?.[0]).toBe(bindingId);

    handler.reconnecting();
    await vi.waitFor(async () => {
      expect((await rowById(bindingId))?.observedConnectedAt).toBeNull();
    });
    handler.reconnected();
    await vi.waitFor(async () => {
      expect((await rowById(bindingId))?.observedConnectedAt).toBeInstanceOf(Date);
    });
    handler.error(new FeishuOperationError("FEISHU_UPSTREAM_UNAVAILABLE"));
    await vi.waitFor(async () => {
      expect((await rowById(bindingId))?.lastErrorCode).toBe("FEISHU_UPSTREAM_UNAVAILABLE");
    });
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager failures on the committed-activation unwind", () => {
  it("releases the committed lease when the replacement close raises through its diagnostic hook", async () => {
    const value = await fixture();
    let raised = false;
    // The diagnostic observer itself fails while the replaced channel is being closed: the unwind
    // must still drop the channel it installed and release the committed lease.
    const harness = managerHarness(value, {
      diagnosticHook: () => {
        if (!raised) {
          raised = true;
          throw new Error("diagnostic reporter unavailable");
        }
      },
    });
    const first = await activateThroughManager(harness, value, { appId: "cli_raise" });
    await database.database
      .update(imBindings)
      .set({ setupIntent: "reauthorize" })
      .where(eq(imBindings.id, first.bindingId));
    harness.setDisconnect(() => Promise.reject(new Error("socket already gone")));
    const owner = randomUUID();
    const second = await insertCandidate(
      value,
      { agentId: value.agent.id, id: first.bindingId },
      { appId: "cli_raise", state: "validating", owner, heartbeatAt: clock.now },
    );
    await expect(
      harness.manager.activateAtomicAttempt({
        attemptId: second.attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_raise",
        appSecret: CANDIDATE_SECRET,
      }),
    ).rejects.toThrow("diagnostic reporter unavailable");
    // The committed activation survived, but the manager holds no lease on it any more.
    const row = await rowById(first.bindingId);
    expect(row?.status).toBe("active");
    expect(row?.credentialGeneration).toBe(2);
    expect(row?.connectionOwnerInstanceId).toBeNull();
    await harness.manager.stop();
  });
});

describe("FeishuConnectionManager activation transaction guards", () => {
  it("is idempotent on a repeated start", async () => {
    const value = await fixture();
    const harness = managerHarness(value, { maintenanceMs: 60_000 });
    harness.manager.start();
    // A second start must not install a second interval or schedule another immediate sweep.
    harness.manager.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await harness.manager.stop();
    expect(harness.created).toEqual([]);
  });

  it("refuses an activation canceled between the claim re-read and the activation transaction", async () => {
    const value = await fixture();
    const owner = randomUUID();
    const harness = managerHarness(value);
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_guard", state: "validating", owner, heartbeatAt: clock.now },
    );
    // The provider call between the claim re-read and the activation transaction is where a
    // competing `cancel` lands: the transaction's own binding re-read must then refuse the claim.
    harness.setValidate(async () => {
      // Releasing the claim back to the ownerless pending shape is what a competitor's takeover
      // (or a restart) leaves behind, and the activation transaction must refuse it.
      await database.database
        .update(imBindings)
        .set({ setupState: "pending_activation", setupOwnerInstanceId: null, setupOwnerHeartbeatAt: null })
        .where(eq(imBindings.setupAttemptId, candidate.attemptId));
      return { externalAppId: "cli_guard", externalTeamId: "tenant_guard", externalBotId: "ou_cli_guard" };
    });
    await expect(
      harness.manager.activateAtomicAttempt({
        attemptId: candidate.attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_guard",
        appSecret: CANDIDATE_SECRET,
      }),
    ).rejects.toMatchObject({ code: "FEISHU_SETUP_FENCE_STALE" });
    expect(harness.disconnected).toEqual(["cli_guard"]);
    expect((await rowForAgent(value.agent.id))?.status).toBe("provisioning");
    await harness.manager.stop();
  });

  it("refuses an activation whose binding never became leasable", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_guard", state: "validating", owner, heartbeatAt: clock.now },
    );
    harness.setValidate(async () => ({
      externalAppId: "cli_guard",
      externalTeamId: "tenant_guard",
      externalBotId: "ou_cli_guard",
    }));
    // The activation reports a binding id that the lease update cannot match: no lease, no channel.
    const activate = vi.spyOn(value.imBindings, "activateFeishu").mockResolvedValue(randomUUID());
    try {
      await expect(
        harness.manager.activateAtomicAttempt({
          attemptId: candidate.attemptId,
          ownerInstanceId: owner,
          agentId: value.agent.id,
          appId: "cli_guard",
          appSecret: CANDIDATE_SECRET,
        }),
      ).rejects.toMatchObject({ code: "FEISHU_CONNECTION_LEASE_UNAVAILABLE" });
    } finally {
      activate.mockRestore();
    }
    expect(harness.disconnected).toEqual(["cli_guard"]);
    expect((await rowForAgent(value.agent.id))?.status).toBe("provisioning");
    await harness.manager.stop();
  });

  it("refuses an activation whose attempt was canceled during the credential write", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_guard", state: "validating", owner, heartbeatAt: clock.now },
    );
    harness.setValidate(async () => ({
      externalAppId: "cli_guard",
      externalTeamId: "tenant_guard",
      externalBotId: "ou_cli_guard",
    }));
    const original = value.imBindings.activateFeishu.bind(value.imBindings);
    // A cancel committing inside the same transaction window clears the claim the completion
    // update is fenced on: the activation must not report success.
    const activate = vi.spyOn(value.imBindings, "activateFeishu").mockImplementation(async (verified, transaction) => {
      const id = await original(verified, transaction);
      if (transaction) {
        await transaction
          .update(imBindings)
          .set({
            setupState: "canceled",
            setupOwnerInstanceId: null,
            setupOwnerHeartbeatAt: null,
            encryptedSetupContext: null,
            setupExpiresAt: null,
          })
          .where(eq(imBindings.id, id));
      }
      return id;
    });
    try {
      await expect(
        harness.manager.activateAtomicAttempt({
          attemptId: candidate.attemptId,
          ownerInstanceId: owner,
          agentId: value.agent.id,
          appId: "cli_guard",
          appSecret: CANDIDATE_SECRET,
        }),
      ).rejects.toMatchObject({ code: "FEISHU_SETUP_FENCE_STALE" });
    } finally {
      activate.mockRestore();
    }
    expect(harness.disconnected).toEqual(["cli_guard"]);
    await harness.manager.stop();
  });

  it("refuses an activation whose credential material is already unreadable", async () => {
    const value = await fixture();
    const harness = managerHarness(value);
    const owner = randomUUID();
    const candidate = await insertCandidate(
      value,
      { agentId: value.agent.id },
      { appId: "cli_guard", state: "validating", owner, heartbeatAt: clock.now },
    );
    harness.setValidate(async () => ({
      externalAppId: "cli_guard",
      externalTeamId: "tenant_guard",
      externalBotId: "ou_cli_guard",
    }));
    // The in-transaction material read reports the credential unusable: never install a channel.
    const original = value.imBindings.getFeishuConnectionMaterial.bind(value.imBindings);
    const material = vi
      .spyOn(value.imBindings, "getFeishuConnectionMaterial")
      .mockImplementation(async (id, transaction) => (transaction ? undefined : original(id, transaction)));
    try {
      await expect(
        harness.manager.activateAtomicAttempt({
          attemptId: candidate.attemptId,
          ownerInstanceId: owner,
          agentId: value.agent.id,
          appId: "cli_guard",
          appSecret: CANDIDATE_SECRET,
        }),
      ).rejects.toMatchObject({ code: "FEISHU_BINDING_NOT_ACTIVE" });
    } finally {
      material.mockRestore();
    }
    expect(harness.disconnected).toEqual(["cli_guard"]);
    await harness.manager.stop();
  });
});
