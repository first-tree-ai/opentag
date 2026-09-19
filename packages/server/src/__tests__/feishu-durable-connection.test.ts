import { randomUUID } from "node:crypto";
import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import { computers, imBindings } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { feishuSetupAttemptContext } from "../services/im-bindings/credential-material.js";
import {
  classifyFeishuCandidateFailure,
  decodeFeishuSetupContext,
  encodeFeishuSetupCandidate,
  type FeishuBindingActivation,
  type FeishuCandidateCheckOutcome,
  FeishuCandidateExpiredError,
  FeishuOperationError,
  FeishuSetupService,
  type FeishuSetupTiming,
  feishuRetryAfterMs,
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
  options: { timing?: FeishuSetupTiming; gateway?: FeishuRegistrationGateway } = {},
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
  attemptId?: string;
  appId?: string;
  appSecret?: string;
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
    value.cipher,
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
  const bindingId = binding.id ?? randomUUID();
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

  it("treats a cross-attempt ciphertext as terminal without activating the foreign candidate", async () => {
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
    // Maintenance fails the row instead of crashing, and clears the unreadable secret.
    const projection = await service.check(value.bootstrap.userId, target.attemptId);
    expect(projection.state).toBe("failed");
    const row = await rowForAgent(value.agent.id);
    expect(row?.lastErrorCode).toBe("FEISHU_SETUP_CONTEXT_INVALID");
    expect(row?.encryptedSetupContext).toBeNull();
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
});
