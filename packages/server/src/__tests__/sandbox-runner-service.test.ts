/** E3 allocation orchestration decisions on the embedded PostgreSQL engine; cloud via a fake admin. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, imBindings, sandboxes, sessions, users } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import type { RunnerInstanceSpec } from "../services/cloud-run/index.js";
import { CloudRunAdminError, type CloudRunInstanceView } from "../services/cloud-run/index.js";
import { type RunnerInstanceIdentityInput, runnerInstanceId } from "../services/cloud-run/instance-identity.js";
import { ComputerService } from "../services/computers/index.js";
import { SandboxService } from "../services/sandboxes/index.js";
import {
  type RunnerBootstrapClaims,
  RunnerBootstrapTokenError,
  RunnerBootstrapTokenService,
} from "../services/sandboxes/runner-bootstrap-token.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../services/sandboxes/runner-hub.js";
import { SandboxRunnerService } from "../services/sandboxes/sandbox-runner-service.js";
import { SessionService } from "../services/sessions/index.js";
import { FAKE_PROJECT, FAKE_REGION, FakeCloudRunAdmin } from "./support/fake-cloud-run-admin.js";

/**
 * Fake with call counters proving which flows touch Cloud. `verifyOwnership` itself (name +
 * allocation labels only; NO policy checks — policy failures must never block deletion of an
 * owned resource) comes from the shared fake, mirroring `CloudRunAdmin.verifyOwnership`.
 */
class RunnerFakeCloudRunAdmin extends FakeCloudRunAdmin {
  getCalls = 0;
  ownershipChecks = 0;

  override async getInstance(name: string): Promise<CloudRunInstanceView | undefined> {
    this.getCalls += 1;
    return super.getInstance(name);
  }

  override verifyOwnership(view: CloudRunInstanceView, identity: RunnerInstanceIdentityInput): void {
    this.ownershipChecks += 1;
    super.verifyOwnership(view, identity);
  }
}

import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
const RUNNER_VERSION = "0.0.5";
const cloudIdentities = { enabled: true, runnerVersion: RUNNER_VERSION, storageBase: "gs://unit-cloud/sandboxes" };
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

async function account() {
  const id = randomUUID();
  await unit.database.insert(users).values({ id, email: `${id}@example.test`, displayName: "E3 fixture" });
  return id;
}

async function ownedSandbox(accountId: string) {
  const cloud = await new ComputerService(unit.database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(unit.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e3-pi-${randomUUID().slice(0, 8)}`,
    displayName: "E3 Pi",
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
  const sandbox = await new SandboxService(unit.database, new SessionService(unit.database), {
    cloudIdentities,
  }).ensureForAccount(accountId, {
    imBindingId: bindingId,
    channelId: "unit-channel",
    conversationKind: "channel",
    kind: "channel",
  });
  return { sandbox, agent, bindingId, cloud };
}

async function sandboxRow(sandboxId: string) {
  const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
  return row as typeof sandboxes.$inferSelect;
}

function makeService(
  fake: RunnerFakeCloudRunAdmin,
  options: {
    acceptanceTimeoutMs?: number;
    createConvergeTimeoutMs?: number;
    deleteVerifyTimeoutMs?: number;
    expectedRunnerVersion?: string;
    tokens?: RunnerBootstrapTokenService;
    capacity?: { accountLimit: number; platformLimit: number };
  } = {},
) {
  const tokens =
    options.tokens ??
    new RunnerBootstrapTokenService("unit-test-jwt-secret-at-least-32-characters", { ttlSeconds: 600 });
  const hub = new RunnerHub();
  const service = new SandboxRunnerService(unit.database, {
    cloudAdmin: fake as never,
    tokens,
    hub,
    environment: "staging",
    backendUrl: "wss://api.example.com/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: options.expectedRunnerVersion ?? RUNNER_VERSION,
    acceptanceTimeoutMs: options.acceptanceTimeoutMs ?? 30_000,
    createConvergeTimeoutMs: options.createConvergeTimeoutMs ?? 30_000,
    sleep: () => Promise.resolve(),
    deleteVerifyTimeoutMs: options.deleteVerifyTimeoutMs ?? 10_000,
    ...(options.capacity ? { capacity: options.capacity } : {}),
  });
  return { service, tokens, hub };
}

/** A bootstrap token service whose Nth issuance fails exactly once, exposing loser-side recording. */
class FlakyTokens extends RunnerBootstrapTokenService {
  calls = 0;
  readonly #failAt: number;

  constructor(options: { failAt: number }) {
    super("unit-test-jwt-secret-at-least-32-characters", { ttlSeconds: 600 });
    this.#failAt = options.failAt;
  }

  override async issue(claims: RunnerBootstrapClaims): Promise<string> {
    this.calls += 1;
    if (this.calls === this.#failAt) throw new Error("signing unavailable");
    return super.issue(claims);
  }
}

function fakeSocket(sent: unknown[] = []): RunnerControlSocket & { sent: unknown[]; closeCode?: number } {
  return {
    sent,
    closeCode: undefined,
    send(frame) {
      sent.push(frame);
    },
    close(code) {
      this.closeCode = code;
    },
  };
}

const READINESS = {
  sandboxName: "ots-s-x-1",
  rootfs: "/opt/sandbox-root",
  nodeVersion: "v24.19.0",
  piVersion: "0.84.2",
  runnerVersion: RUNNER_VERSION,
  reportedAt: new Date().toISOString(),
};

describe("RunnerBootstrapTokenService", () => {
  it("round-trips a freshly issued token through verify with only the custom claims", async () => {
    const tokens = new RunnerBootstrapTokenService("roundtrip-secret-at-least-32-characters", { ttlSeconds: 600 });
    const claims = {
      sandboxId: randomUUID(),
      sessionId: randomUUID(),
      environmentGeneration: 3,
      resourceName: "projects/p/locations/r/instances/ot-s-x-3",
    };
    const verified = await tokens.verify(await tokens.issue(claims));
    expect(verified).toEqual(claims);
    expect(Object.keys(verified).sort()).toEqual(["environmentGeneration", "resourceName", "sandboxId", "sessionId"]);
  });

  it("rejects an expired token and a tampered claim value", async () => {
    const tokens = new RunnerBootstrapTokenService("roundtrip-secret-at-least-32-characters", { ttlSeconds: 600 });
    const claims = {
      sandboxId: randomUUID(),
      sessionId: randomUUID(),
      environmentGeneration: 1,
      resourceName: "projects/p/locations/r/instances/ot-s-x-1",
    };
    const expiredIssuer = new RunnerBootstrapTokenService("roundtrip-secret-at-least-32-characters", {
      ttlSeconds: 600,
      now: () => new Date(Date.now() - 3_600_000),
    });
    await expect(tokens.verify(await expiredIssuer.issue(claims))).rejects.toBeInstanceOf(RunnerBootstrapTokenError);
    const [header, body, signature] = (await tokens.issue(claims)).split(".");
    const payload = JSON.parse(Buffer.from(body as string, "base64url").toString("utf8"));
    payload.environmentGeneration = 99;
    const tampered = `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
    await expect(tokens.verify(tampered)).rejects.toBeInstanceOf(RunnerBootstrapTokenError);
  });
});

describe("RunnerHub connection identity", () => {
  const scope: RunnerScope = {
    sandboxId: "sandbox",
    sessionId: "session",
    environmentGeneration: 1,
    resourceName: "projects/p/locations/r/instances/ot-s-x-1",
  };

  it("an old same-scope socket can never publish readiness or resolve a result", () => {
    const hub = new RunnerHub();
    const oldSocket = fakeSocket();
    const newSocket = fakeSocket();
    hub.attach(scope, oldSocket);
    hub.attach(scope, newSocket);
    expect(hub.markReady(scope, READINESS, oldSocket)).toBe(false);
    expect(hub.markReady(scope, READINESS, newSocket)).toBe(true);
    expect(hub.sendToCurrent(scope.sandboxId, oldSocket, { type: "server:heartbeat" })).toBe(false);
    expect(hub.sendToCurrent(scope.sandboxId, newSocket, { type: "server:heartbeat" })).toBe(true);
    expect(
      hub.resolveAcceptanceResult(
        scope.sandboxId,
        { type: "acceptance:result", requestId: "r", outcome: "passed" },
        oldSocket,
      ),
    ).toBe(false);
  });

  it("rejects a second concurrent acceptance immediately instead of queueing", async () => {
    const hub = new RunnerHub();
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    const first = hub.runAcceptance(
      scope.sandboxId,
      { mode: "offline", deadlineAtMs: Date.now() + 10_000 },
      { timeoutMs: 10_000 },
    );
    await expect(
      hub.runAcceptance(scope.sandboxId, { mode: "offline", deadlineAtMs: Date.now() + 10_000 }, { timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ name: "RunnerAcceptanceUnavailableError" });
    const requestId = (socket.sent[0] as { requestId: string }).requestId;
    hub.resolveAcceptanceResult(scope.sandboxId, { type: "acceptance:result", requestId, outcome: "passed" }, socket);
    await expect(first).resolves.toMatchObject({ outcome: "passed" });
  });

  it("rejects an already-aborted acceptance without sending a frame", async () => {
    const hub = new RunnerHub();
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    const controller = new AbortController();
    controller.abort();
    await expect(
      hub.runAcceptance(
        scope.sandboxId,
        { mode: "offline", deadlineAtMs: Date.now() + 10_000 },
        { timeoutMs: 10_000, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "RunnerAcceptanceUnavailableError" });
    expect(socket.sent).toHaveLength(0);
  });

  it("rejects pending work immediately when the socket send fails", async () => {
    const hub = new RunnerHub();
    const socket = fakeSocket();
    socket.send = () => {
      throw new Error("socket gone");
    };
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    await expect(
      hub.runAcceptance(scope.sandboxId, { mode: "offline", deadlineAtMs: Date.now() + 10_000 }, { timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ name: "RunnerAcceptanceUnavailableError" });
  });
});

describe("SandboxRunnerService ownership and authority", () => {
  it("answers 404 for every operation when the sandbox belongs to another account", async () => {
    const owner = await account();
    const stranger = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    for (const act of [
      () => service.startForAccount(stranger, sandbox.sandboxId),
      () => service.statusForAccount(stranger, sandbox.sandboxId),
      () => service.stopForAccount(stranger, sandbox.sandboxId),
      () => service.runAcceptanceForAccount(stranger, sandbox.sandboxId, { mode: "offline" }),
    ]) {
      await expect(act()).rejects.toMatchObject({ statusCode: 404, code: "RESOURCE_NOT_FOUND" });
    }
    expect(fake.createCalls).toHaveLength(0);
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("keeps status/stop ownership access but denies start/connect/execute for a suspended Agent", async () => {
    const owner = await account();
    const { sandbox, agent } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    await service.startForAccount(owner, sandbox.sandboxId);
    await unit.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, agent.id));

    const status = await service.statusForAccount(owner, sandbox.sandboxId);
    expect(status.lifecycle).toBe("preparing");
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.runAcceptanceForAccount(owner, sandbox.sandboxId, { mode: "offline" })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.validateRunnerScope({
        sandboxId: sandbox.sandboxId,
        sessionId: sandbox.sessionId,
        environmentGeneration: 1,
        resourceName: status.currentResourceName as string,
      }),
    ).resolves.toBeUndefined();
    // Stop remains available for cleanup.
    const stopped = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");
  });

  it("denies start for a non-active binding, an ended Session and a suspended Account", async () => {
    const owner = await account();
    const { sandbox, bindingId } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    await unit.database.update(imBindings).set({ status: "error" }).where(eq(imBindings.id, bindingId));
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 404 });
    expect(await service.statusForAccount(owner, sandbox.sandboxId)).toMatchObject({ lifecycle: "unallocated" });
    await unit.database.update(imBindings).set({ status: "active" }).where(eq(imBindings.id, bindingId));
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, sandbox.sessionId));
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 404 });
    await unit.database.update(sessions).set({ endedAt: null }).where(eq(sessions.id, sandbox.sessionId));
    await unit.database.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, owner));
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 404 });
    expect(fake.createCalls).toHaveLength(0);
  });
});

describe("SandboxRunnerService start", () => {
  it("persists the deterministic name and submission marker BEFORE cloud I/O", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    let open!: () => void;
    fake.createGate = {
      promise: new Promise<void>((resolve) => {
        open = resolve;
      }),
      open: () => open(),
    };
    const { service } = makeService(fake);
    const start = service.startForAccount(owner, sandbox.sandboxId);
    await vi.waitFor(() => expect(fake.createCalls).toHaveLength(1));
    const pending = await sandboxRow(sandbox.sandboxId);
    expect(pending.lifecycle).toBe("preparing");
    expect(pending.environmentGeneration).toBe(1);
    expect(pending.currentResourceName).toBe(
      `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/instances/${runnerInstanceId({
        environment: "staging",
        sandboxId: sandbox.sandboxId,
        sessionId: sandbox.sessionId,
        environmentGeneration: 1,
      })}`,
    );
    expect(pending.currentResourceUid).toBeNull();
    expect(pending.lastErrorCode).toBe("cloud_create_pending");
    open();
    const status = await start;
    expect(status.lifecycle).toBe("preparing");
    expect(status.currentResourceUid).toMatch(/^uid-/);
    expect(status.currentOperationName).toContain("/operations/");
    expect(fake.liveInstanceCount()).toBe(1);
  });

  it("is idempotent for a second start of the same allocation", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const first = await service.startForAccount(owner, sandbox.sandboxId);
    const second = await service.startForAccount(owner, sandbox.sandboxId);
    expect(second.environmentGeneration).toBe(1);
    expect(second.currentResourceName).toBe(first.currentResourceName);
    expect(fake.liveInstanceCount()).toBe(1);
    expect(fake.createCalls).toHaveLength(1);
  });

  it("concurrent starts submit exactly one create", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const [left, right] = await Promise.all([
      service.startForAccount(owner, sandbox.sandboxId),
      service.startForAccount(owner, sandbox.sandboxId),
    ]);
    expect(left.currentResourceName).toBe(right.currentResourceName);
    expect(fake.liveInstanceCount()).toBe(1);
    expect(fake.createCalls).toHaveLength(1);
    const after = await service.statusForAccount(owner, sandbox.sandboxId);
    expect(after.currentResourceUid).toMatch(/^uid-/);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(row?.environmentGeneration).toBe(1);
  });

  it("keeps an operation that finished without a resource uncertain, never rejected", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    await service.startForAccount(owner, sandbox.sandboxId);
    const row = await sandboxRow(sandbox.sandboxId);
    const name = row.currentResourceName as string;
    // done=true with neither an error nor a resource is ambiguous, not proof of nothing.
    fake.operations.set(row.currentOperationName as string, { state: "done" });
    const instance = fake.instances.get(name);
    if (instance) instance.gone = true;
    await unit.database
      .update(sandboxes)
      .set({ currentResourceUid: null, lastErrorCode: null, lastErrorAt: null })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    expect(status.lifecycle).toBe("preparing");
    expect(status.lastErrorCode).toBe("cloud_create_uncertain");
    expect(fake.createCalls).toHaveLength(1); // no second POST
  });

  it("an unknown create result preserves the name and never POSTs twice for the generation", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    fake.createUnknownOnce = true;
    const { service } = makeService(fake);
    const first = await service.startForAccount(owner, sandbox.sandboxId);
    expect(first.lifecycle).toBe("preparing");
    expect(first.currentResourceName).not.toBeNull();
    expect(first.lastErrorCode).toBe("cloud_create_uncertain");
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.liveInstanceCount()).toBe(1);
    // The second start reconciles the SAME deterministic resource with GET; no second POST.
    const second = await service.startForAccount(owner, sandbox.sandboxId);
    expect(second.currentResourceUid).toMatch(/^uid-/);
    expect(second.lastErrorCode).toBeNull();
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.liveInstanceCount()).toBe(1);
  });

  it("a definitive create rejection is retryable; a transport failure is not", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    fake.failNextCreateWith = new CloudRunAdminError("unavailable", "backend exploded", { status: 500 });
    const { service } = makeService(fake);
    const uncertain = await service.startForAccount(owner, sandbox.sandboxId);
    expect(uncertain.lastErrorCode).toBe("cloud_create_uncertain");
    await service.startForAccount(owner, sandbox.sandboxId);
    expect(fake.createCalls).toHaveLength(1); // 5xx is not a definitive failure

    const rejected = new RunnerFakeCloudRunAdmin();
    rejected.failNextCreateWith = new CloudRunAdminError("invalid", "image refused", {
      status: 400,
      createRejected: true,
    });
    const secondFixture = await ownedSandbox(owner);
    const second = makeService(rejected);
    await expect(second.service.startForAccount(owner, secondFixture.sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 503,
    });
    const rejectedRow = await sandboxRow(secondFixture.sandbox.sandboxId);
    expect(rejectedRow.lastErrorCode).toBe("cloud_create_rejected");
    expect(rejectedRow.currentResourceName).not.toBeNull();
    // A definitive rejection allows the next start to submit again.
    const retried = await second.service.startForAccount(owner, secondFixture.sandbox.sandboxId);
    expect(retried.currentResourceUid).toMatch(/^uid-/);
    expect(rejected.createCalls).toHaveLength(2);
    expect(rejected.liveInstanceCount()).toBe(1);
  });

  it("an invalid/ownership error WITHOUT createRejected never retries or clears (a resource may exist)", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    // Adapter's post-POST GET+policy verification failures carry createRejected=false.
    fake.failNextCreateWith = new CloudRunAdminError("ownership_mismatch", "adopted resource failed verification");
    const { service } = makeService(fake, { deleteVerifyTimeoutMs: 150 });
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const blocked = await sandboxRow(sandbox.sandboxId);
    expect(blocked.lastErrorCode).toBe("cloud_instance_unverified");
    expect(blocked.currentResourceName).not.toBeNull();
    expect(blocked.currentResourceUid).toBeNull();
    // Reconcile and stop must never submit another POST nor clear the reference.
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    expect(status.lifecycle).toBe("preparing");
    expect(fake.createCalls).toHaveLength(1);
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const releasing = await sandboxRow(sandbox.sandboxId);
    expect(releasing.lifecycle).toBe("releasing");
    expect(releasing.currentResourceName).not.toBeNull();
    expect(fake.createCalls).toHaveLength(1);
  });

  it("an early Runner readiness report is deferred until the create caller records the verified UID", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    let open!: () => void;
    fake.createGate = {
      promise: new Promise<void>((resolve) => {
        open = resolve;
      }),
      open: () => open(),
    };
    const { service, hub } = makeService(fake);
    const start = service.startForAccount(owner, sandbox.sandboxId);
    await vi.waitFor(() => expect(fake.createCalls).toHaveLength(1));
    const pending = await sandboxRow(sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: pending.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    // The create result has not landed: readiness must not flip lifecycle, and must not kill the
    // legitimate Runner.
    expect(await service.markRunnerReady(scope, READINESS)).toBe("deferred");
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("preparing");
    open();
    await start;
    const status = await service.statusForAccount(owner, sandbox.sandboxId);
    expect(status.lifecycle).toBe("ready");
    expect(status.runnerReady).toBe(true);
    expect(fake.createCalls).toHaveLength(1);
  });

  it("requires the exact configured Runner version before readiness", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service, hub } = makeService(fake);
    await service.startForAccount(owner, sandbox.sandboxId);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: row?.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, { ...READINESS, runnerVersion: "9.9.9" }, socket);
    expect(await service.markRunnerReady(scope, { ...READINESS, runnerVersion: "9.9.9" })).toBe("version_mismatch");
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("preparing");
  });

  it("a deferred create that lands while releasing finishes the pending release automatically", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    let open!: () => void;
    fake.createGate = {
      promise: new Promise<void>((resolve) => {
        open = resolve;
      }),
      open: () => open(),
    };
    const { service } = makeService(fake, { deleteVerifyTimeoutMs: 150 });
    const startA = service.startForAccount(owner, sandbox.sandboxId);
    await vi.waitFor(() => expect(fake.createCalls).toHaveLength(1));
    const generationOne = (await sandboxRow(sandbox.sandboxId)).currentResourceName as string;
    // Stop while the create is in flight: the outcome is unknown, so release stays incomplete and
    // keeps the reference instead of clearing it. The pending submission marker is preserved.
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const releasing = await sandboxRow(sandbox.sandboxId);
    expect(releasing.lifecycle).toBe("releasing");
    expect(releasing.currentResourceName).toBe(generationOne);
    expect(releasing.lastErrorCode).toBe("cloud_create_pending");
    // The late create lands and records its UID even though the row is releasing, then the same
    // start request finishes the pending release without requiring a second user stop.
    open();
    await expect(startA).resolves.toMatchObject({ lifecycle: "unallocated" });
    const cleared = await sandboxRow(sandbox.sandboxId);
    expect(cleared.currentResourceName).toBeNull();
    expect(cleared.currentResourceUid).toBeNull();
    expect(fake.liveInstanceCount()).toBe(0);
    expect(fake.createCalls).toHaveLength(1);
  });
});

describe("SandboxRunnerService capacity admission (E9)", () => {
  it("exposes 3/20 defaults, honors configured ceilings, and rejects misconfiguration", async () => {
    const fake = new RunnerFakeCloudRunAdmin();
    expect(makeService(fake).service.capacityLimits).toEqual({ accountLimit: 3, platformLimit: 20 });
    expect(makeService(fake, { capacity: { accountLimit: 2, platformLimit: 9 } }).service.capacityLimits).toEqual({
      accountLimit: 2,
      platformLimit: 9,
    });
    for (const capacity of [
      { accountLimit: 0, platformLimit: 20 },
      { accountLimit: 3, platformLimit: -1 },
      { accountLimit: 1.5, platformLimit: 20 },
    ]) {
      expect(() => makeService(fake, { capacity })).toThrow(/capacity/);
    }
  });

  it("rejects a new reservation at the Account ceiling without any cloud call or row mutation", async () => {
    const owner = await account();
    const first = await ownedSandbox(owner);
    const second = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake, { capacity: { accountLimit: 1, platformLimit: 20 } });
    await service.startForAccount(owner, first.sandbox.sandboxId);
    expect(fake.createCalls).toHaveLength(1);

    await expect(service.startForAccount(owner, second.sandbox.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      category: "transient",
      statusCode: 429,
      scope: "account",
    });
    // The rejected reservation rolled back completely: no generation, no name, no create.
    expect(await sandboxRow(second.sandbox.sandboxId)).toMatchObject({
      lifecycle: "unallocated",
      environmentGeneration: 0,
      currentResourceName: null,
      currentResourceUid: null,
      lastErrorCode: null,
    });
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.liveInstanceCount()).toBe(1);
  });

  it("rejects at the platform ceiling across Accounts with the platform scope", async () => {
    const left = await account();
    const right = await account();
    const first = await ownedSandbox(left);
    const second = await ownedSandbox(right);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake, { capacity: { accountLimit: 5, platformLimit: 1 } });
    await service.startForAccount(left, first.sandbox.sandboxId);

    await expect(service.startForAccount(right, second.sandbox.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      statusCode: 429,
      scope: "platform",
    });
    expect(fake.createCalls).toHaveLength(1);
    expect(await sandboxRow(second.sandbox.sandboxId)).toMatchObject({
      lifecycle: "unallocated",
      environmentGeneration: 0,
    });
  });

  it("counts an unknown create outcome until verified absence", async () => {
    const owner = await account();
    const first = await ownedSandbox(owner);
    const second = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    fake.createUnknownWithoutResourceOnce = true;
    const { service } = makeService(fake, { capacity: { accountLimit: 1, platformLimit: 20 } });
    // The create outcome is unknown (no resource, no LRO): the row keeps its slot conservatively.
    await service.startForAccount(owner, first.sandbox.sandboxId);
    expect(await sandboxRow(first.sandbox.sandboxId)).toMatchObject({
      lifecycle: "preparing",
      lastErrorCode: "cloud_create_uncertain",
    });

    await expect(service.startForAccount(owner, second.sandbox.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      scope: "account",
    });
    // The uncertain row was never released early, and the rejected starter never reached the cloud.
    expect(fake.createCalls).toHaveLength(1);
    await expect(service.startForAccount(owner, second.sandbox.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
    });
  });

  it("counts a delete-unconfirmed releasing row, and a finished release frees the slot at the ceiling", async () => {
    const owner = await account();
    const first = await ownedSandbox(owner);
    const second = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake, { capacity: { accountLimit: 1, platformLimit: 20 } });
    await service.startForAccount(owner, first.sandbox.sandboxId);

    // The delete fails: the row stays releasing with the binding and keeps occupying its slot.
    fake.deleteFailures = 1;
    await expect(service.stopForAccount(owner, first.sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(await sandboxRow(first.sandbox.sandboxId)).toMatchObject({
      lifecycle: "releasing",
      lastErrorCode: "cloud_delete_incomplete",
    });
    await expect(service.startForAccount(owner, second.sandbox.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      scope: "account",
    });

    // Release is never blocked by the ceiling: the retried stop verifies removal and frees the slot.
    await service.stopForAccount(owner, first.sandbox.sandboxId);
    expect(await sandboxRow(first.sandbox.sandboxId)).toMatchObject({
      lifecycle: "unallocated",
      currentResourceName: null,
    });
    await service.startForAccount(owner, second.sandbox.sandboxId);
    expect(fake.createCalls).toHaveLength(2);
    expect(fake.liveInstanceCount()).toBe(1);
  });

  it("counts suspended-Agent and idle-claimed environments until their cleanup is verified", async () => {
    const owner = await account();
    const first = await ownedSandbox(owner);
    const second = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake, { capacity: { accountLimit: 1, platformLimit: 20 } });
    await service.startForAccount(owner, first.sandbox.sandboxId);
    // A ready environment quiesced by an automatic idle claim still owns its physical binding.
    const allocated = await sandboxRow(first.sandbox.sandboxId);
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "ready", idleReclaimAt: new Date() })
      .where(eq(sandboxes.id, first.sandbox.sandboxId));
    // A suspended Agent's un-cleaned resource still occupies. The second Agent stays active, so
    // only the ceiling can explain the rejection.
    await unit.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, first.agent.id));

    await expect(service.startForAccount(owner, second.sandbox.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      scope: "account",
    });
    expect(allocated.currentResourceName).not.toBeNull();
    expect(fake.createCalls).toHaveLength(1);
  });

  it("never charges an existing allocation twice: reconcile and retry pass at the ceiling", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    fake.failNextCreateWith = new CloudRunAdminError("invalid", "create rejected", {
      status: 400,
      createRejected: true,
    });
    const { service } = makeService(fake, { capacity: { accountLimit: 1, platformLimit: 20 } });
    // The first submission is definitively rejected: the generation is already charged (preparing).
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(await sandboxRow(sandbox.sandboxId)).toMatchObject({
      lifecycle: "preparing",
      environmentGeneration: 1,
      lastErrorCode: "cloud_create_rejected",
    });

    // A retry of the SAME charged generation is admission-exempt and converges normally.
    const retried = await service.startForAccount(owner, sandbox.sandboxId);
    expect(retried.lifecycle).toBe("preparing");
    expect(retried.environmentGeneration).toBe(1);
    expect(fake.createCalls).toHaveLength(2);

    // A repeated start of the tracked allocation reconciles/reports without touching admission.
    const again = await service.startForAccount(owner, sandbox.sandboxId);
    expect(again.environmentGeneration).toBe(1);
    expect(fake.createCalls).toHaveLength(2);
    expect(fake.liveInstanceCount()).toBe(1);
  });
});

describe("SandboxRunnerService retry races", () => {
  /** Reach a definitive-rejected generation: retryable marker, persisted name, no UID or LRO. */
  async function rejectedSandbox(owner: string, options: { deleteVerifyTimeoutMs?: number } = {}) {
    const fixture = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    fake.failNextCreateWith = new CloudRunAdminError("invalid", "rejected", { status: 400, createRejected: true });
    const made = makeService(fake, { deleteVerifyTimeoutMs: options.deleteVerifyTimeoutMs ?? 150 });
    await expect(made.service.startForAccount(owner, fixture.sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 503,
    });
    return { ...fixture, fake, ...made };
  }

  it("clears the previous operation identity on retry so a concurrent stop cannot reuse stale LRO evidence", async () => {
    const owner = await account();
    const { sandbox, fake, service } = await rejectedSandbox(owner, { deleteVerifyTimeoutMs: 150 });
    // A previous attempt left a finished, failed operation on the row.
    const staleOperation = "projects/unit-project/locations/us-west1/operations/op-stale";
    await unit.database
      .update(sandboxes)
      .set({ currentOperationName: staleOperation })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    fake.operations.set(staleOperation, { state: "error", errorCode: 13 });
    const name = (await sandboxRow(sandbox.sandboxId)).currentResourceName as string;

    // The retry wins the claim and its POST hangs.
    let open!: () => void;
    fake.createGate = {
      promise: new Promise<void>((resolve) => {
        open = resolve;
      }),
      open: () => open(),
    };
    const retry = service.startForAccount(owner, sandbox.sandboxId);
    await vi.waitFor(() => expect(fake.createCalls).toHaveLength(2));
    const claimed = await sandboxRow(sandbox.sandboxId);
    expect(claimed.currentOperationName).toBeNull();
    expect(claimed.lastErrorCode).toBe("cloud_create_pending");

    // Stop while the new request may still allocate: the stale failed LRO must NOT clear the row.
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const releasing = await sandboxRow(sandbox.sandboxId);
    expect(releasing.lifecycle).toBe("releasing");
    expect(releasing.currentResourceName).toBe(name);
    expect(releasing.lastErrorCode).toBe("cloud_create_pending");

    // The late retry succeeds and the pending release finishes in the same request.
    open();
    await expect(retry).resolves.toMatchObject({ lifecycle: "unallocated" });
    const cleared = await sandboxRow(sandbox.sandboxId);
    expect(cleared.currentResourceName).toBeNull();
    expect(fake.liveInstanceCount()).toBe(0);
    expect(fake.createCalls).toHaveLength(2);
  });

  it("a delayed LRO rejection cannot overwrite a newer pending submission or trigger another retry", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    await service.startForAccount(owner, sandbox.sandboxId);
    const initial = await sandboxRow(sandbox.sandboxId);
    const name = initial.currentResourceName as string;
    const staleOperation = initial.currentOperationName as string;
    fake.operations.set(staleOperation, { state: "error", errorCode: 13 });
    const instance = fake.instances.get(name);
    if (instance) instance.gone = true;
    await unit.database
      .update(sandboxes)
      .set({ currentResourceUid: null, lastErrorCode: "cloud_create_uncertain", lastErrorAt: new Date() })
      .where(eq(sandboxes.id, sandbox.sandboxId));

    // The first reconcile blocks inside getOperation for the stale LRO...
    const realGetOperation = fake.getOperation.bind(fake);
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let gated = false;
    let markFirstReadStarted!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    fake.getOperation = async (operationName) => {
      if (operationName === staleOperation && !gated) {
        gated = true;
        markFirstReadStarted();
        await firstReadGate;
      }
      return realGetOperation(operationName);
    };

    const staleReconcile = service.startForAccount(owner, sandbox.sandboxId);
    await firstReadStarted;

    // ...while a newer retry rejects the same LRO first, claims the row and hangs in its POST.
    let open!: () => void;
    fake.createGate = {
      promise: new Promise<void>((resolve) => {
        open = resolve;
      }),
      open: () => open(),
    };
    const newerRetry = service.startForAccount(owner, sandbox.sandboxId);
    await vi.waitFor(() => expect(fake.createCalls).toHaveLength(2));
    const pending = await sandboxRow(sandbox.sandboxId);
    expect(pending.lastErrorCode).toBe("cloud_create_pending");
    expect(pending.currentOperationName).toBeNull();

    // The stale read now resolves to an error; it must not win anything.
    releaseFirstRead();
    await expect(staleReconcile).resolves.toMatchObject({ lifecycle: "preparing" });
    const afterStale = await sandboxRow(sandbox.sandboxId);
    expect(afterStale.lastErrorCode).toBe("cloud_create_pending");
    expect(afterStale.currentOperationName).toBeNull();
    expect(fake.createCalls).toHaveLength(2); // no third POST

    open();
    await newerRetry;
    const done = await sandboxRow(sandbox.sandboxId);
    expect(done.currentResourceUid).toMatch(/^uid-/);
    expect(done.lastErrorCode).toBeNull();
    expect(fake.liveInstanceCount()).toBe(1);
  });

  it("concurrent retries serialize on the claim: only the winner mints a credential or can fail", async () => {
    const owner = await account();
    const { sandbox, fake } = await rejectedSandbox(owner);
    // Any issuance after the winning retry's first would throw; a losing retry must never reach it.
    const tokens = new FlakyTokens({ failAt: 2 });
    const { service } = makeService(fake, { tokens });
    const results = await Promise.allSettled([
      service.startForAccount(owner, sandbox.sandboxId),
      service.startForAccount(owner, sandbox.sandboxId),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(tokens.calls).toBe(1); // the loser returned at the CAS without minting
    expect(fake.createCalls).toHaveLength(2); // the rejected attempt + exactly one retry
    const row = await sandboxRow(sandbox.sandboxId);
    expect(row.currentResourceUid).toMatch(/^uid-/);
    expect(row.lastErrorCode).toBeNull(); // a loser's failure never overwrote the winner
  });

  it("a winning retry whose token issuance fails records a retryable local failure without POSTing", async () => {
    const owner = await account();
    const { sandbox, fake } = await rejectedSandbox(owner);
    const tokens = new FlakyTokens({ failAt: 1 });
    const { service } = makeService(fake, { tokens });
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toThrow("signing unavailable");
    const row = await sandboxRow(sandbox.sandboxId);
    expect(row.lastErrorCode).toBe("cloud_create_failed");
    expect(fake.createCalls).toHaveLength(1); // nothing was POSTed
    // The marker is retryable: a later start may submit again.
    const retried = await service.startForAccount(owner, sandbox.sandboxId);
    expect(retried.currentResourceUid).toMatch(/^uid-/);
    expect(fake.createCalls).toHaveLength(2);
  });

  it("preserves a definitive create marker across a failed stop read so a later 404 releases the row", async () => {
    const owner = await account();
    const { sandbox, fake, service } = await rejectedSandbox(owner, { deleteVerifyTimeoutMs: 150 });
    const rejected = await sandboxRow(sandbox.sandboxId);
    expect(rejected.lastErrorCode).toBe("cloud_create_rejected");
    expect(rejected.currentOperationName).toBeNull();
    // The stop-phase GET fails (the same IAM/transient problem that rejected the create): the
    // delete-phase failure must NOT overwrite the definitive create marker. Previously this
    // wrote `cloud_delete_incomplete`, after which no stop could ever clear the row.
    fake.getInstanceFailures = 1;
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const afterFailure = await sandboxRow(sandbox.sandboxId);
    expect(afterFailure.lifecycle).toBe("releasing");
    expect(afterFailure.lastErrorCode).toBe("cloud_create_rejected");
    expect(afterFailure.currentResourceName).toBe(rejected.currentResourceName);
    // The read recovers and returns 404: the preserved marker is definitive evidence, so this
    // stop clears the row instead of timing out into uncertainty again.
    const recovered = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(recovered.lifecycle).toBe("unallocated");
    expect(recovered.currentResourceName).toBeNull();
    expect(recovered.lastErrorCode).toBeNull();
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("preserves a local pre-submission failure marker across a failed stop read", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const tokens = new FlakyTokens({ failAt: 1 });
    const { service } = makeService(fake, { tokens, deleteVerifyTimeoutMs: 150 });
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toThrow("signing unavailable");
    expect((await sandboxRow(sandbox.sandboxId)).lastErrorCode).toBe("cloud_create_failed");
    fake.getInstanceFailures = 1;
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const afterFailure = await sandboxRow(sandbox.sandboxId);
    expect(afterFailure.lifecycle).toBe("releasing");
    expect(afterFailure.lastErrorCode).toBe("cloud_create_failed");
    const recovered = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(recovered.lifecycle).toBe("unallocated");
    expect(fake.createCalls).toHaveLength(0);
  });

  it("preserves the unverified diagnostic across a failed stop read and never clears on 404 alone", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    // Post-POST adoption failure WITHOUT createRejected: a resource may exist, so the row is
    // never retried and never cleared — and this fake never landed one, so reads stay 404.
    fake.failNextCreateWith = new CloudRunAdminError("ownership_mismatch", "adopted resource failed verification");
    const { service } = makeService(fake, { deleteVerifyTimeoutMs: 150 });
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect((await sandboxRow(sandbox.sandboxId)).lastErrorCode).toBe("cloud_instance_unverified");
    // The stop-phase GET fails: the diagnostic must survive the delete-phase failure (it was
    // previously erased by `cloud_delete_incomplete`).
    fake.getInstanceFailures = 1;
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const afterFailure = await sandboxRow(sandbox.sandboxId);
    expect(afterFailure.lifecycle).toBe("releasing");
    expect(afterFailure.lastErrorCode).toBe("cloud_instance_unverified");
    // 404 alone is still NOT definitive for an unverified row (a late create may materialize):
    // the uncertainty window's own marker write must not erase the diagnostic either, and the
    // reference is kept — no relaxed unknown-create cleanup.
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const stillHeld = await sandboxRow(sandbox.sandboxId);
    expect(stillHeld.lifecycle).toBe("releasing");
    expect(stillHeld.currentResourceName).not.toBeNull();
    expect(stillHeld.lastErrorCode).toBe("cloud_instance_unverified");
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.deleteCalls).toHaveLength(0);
  });
});

describe("SandboxRunnerService stop", () => {
  async function startedSandbox(owner: string) {
    const fixture = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service, hub, tokens } = makeService(fake);
    await service.startForAccount(owner, fixture.sandbox.sandboxId);
    return { ...fixture, fake, service, hub, tokens };
  }

  it("releases with delete verified by 404 before clearing the tracked reference", async () => {
    const owner = await account();
    const { sandbox, fake, service } = await startedSandbox(owner);
    const status = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(status.lifecycle).toBe("unallocated");
    expect(status.currentResourceName).toBeNull();
    expect(status.currentResourceUid).toBeNull();
    expect(status.currentOperationName).toBeNull();
    expect(fake.liveInstanceCount()).toBe(0);
    expect(fake.deleteCalls).toHaveLength(1);
  });

  it("is idempotent for an already unallocated sandbox", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const status = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(status.lifecycle).toBe("unallocated");
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("keeps the resource reference and reports failure when deletion fails", async () => {
    const owner = await account();
    const { sandbox, fake, service } = await startedSandbox(owner);
    fake.deleteFailures = 1;
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
    });
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(row?.lifecycle).toBe("releasing");
    expect(row?.currentResourceName).not.toBeNull();
    expect(row?.currentResourceUid).not.toBeNull();
    expect(row?.lastErrorCode).toBe("cloud_delete_incomplete");
    expect(fake.liveInstanceCount()).toBe(1);
    // Retry succeeds and converges to unallocated.
    const retried = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(retried.lifecycle).toBe("unallocated");
    expect(retried.currentResourceName).toBeNull();
    expect(fake.liveInstanceCount()).toBe(0);
  });

  it("never erases the reference when the tracked UID changed underneath", async () => {
    const owner = await account();
    const { sandbox, fake, service } = await startedSandbox(owner);
    const row = await sandboxRow(sandbox.sandboxId);
    fake.replaceUid(row.currentResourceName as string, "uid-tampered");
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const after = await sandboxRow(sandbox.sandboxId);
    expect(after.lifecycle).toBe("releasing");
    expect(after.currentResourceName).not.toBeNull();
    expect(fake.liveInstanceCount()).toBe(1); // the tampered replacement is untouched; ours is never deleted under it
  });

  it("conflicts start while releasing", async () => {
    const owner = await account();
    const { sandbox, fake, service } = await startedSandbox(owner);
    fake.deleteFailures = 1;
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 409,
      code: "SANDBOX_RUNNER_CONFLICT",
    });
  });

  it("reports a same-name replacement after deletion instead of erasing the release evidence", async () => {
    const owner = await account();
    const { sandbox, fake, service } = await startedSandbox(owner);
    // Our Instance is deleted, but a same-name resource with a different UID appears during the
    // read-back: ours is gone, but the replacement must be reported, not silently assumed.
    fake.deleteSpawnsReplacementUid = "uid-replacement";
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const after = await sandboxRow(sandbox.sandboxId);
    expect(after.lifecycle).toBe("releasing");
    expect(after.currentResourceName).not.toBeNull();
    expect(fake.liveInstanceCount()).toBe(1); // the replacement is untouched and visible
  });

  it("treats a completed operation that reports success as allocated, keeping releasing until visible", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake, { deleteVerifyTimeoutMs: 120 });
    await service.startForAccount(owner, sandbox.sandboxId);
    const row = await sandboxRow(sandbox.sandboxId);
    const name = row.currentResourceName as string;
    // The create succeeded remotely (operation done with this resource), but the read is not
    // visible yet and the row's UID was never recorded.
    fake.operations.set(row.currentOperationName as string, { state: "done", resourceName: name });
    const instance = fake.instances.get(name);
    if (instance) instance.gone = true;
    await unit.database
      .update(sandboxes)
      .set({ currentResourceUid: null, lastErrorCode: "cloud_create_pending", lastErrorAt: new Date() })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const releasing = await sandboxRow(sandbox.sandboxId);
    expect(releasing.lifecycle).toBe("releasing");
    expect(releasing.currentResourceName).toBe(name); // never cleared on a successful operation
    // The instance becomes visible again; the retried stop verifies, tracks and deletes it.
    if (instance) instance.gone = false;
    const stopped = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");
    expect(fake.liveInstanceCount()).toBe(0);
  });

  it("keeps releasing and the reference when an unknown create is still unreadable", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    fake.createUnknownWithoutResourceOnce = true;
    const { service } = makeService(fake, { deleteVerifyTimeoutMs: 120 });
    await service.startForAccount(owner, sandbox.sandboxId);
    const [pending] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(pending?.lastErrorCode).toBe("cloud_create_uncertain");
    const name = pending?.currentResourceName as string;
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const [releasing] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(releasing?.lifecycle).toBe("releasing");
    expect(releasing?.currentResourceName).toBe(name);
    // The late resource materializes; a retried stop finds it, verifies and deletes it.
    const spec = fake.createCalls[0] as RunnerInstanceSpec;
    fake.materialize(spec);
    const stopped = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");
    expect(fake.liveInstanceCount()).toBe(0);
  });

  it("deletes an owned Instance whose policy fails verification instead of stranding it", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    // A persistent POLICY failure with intact ownership (deterministic name + labels match):
    // adoption and readiness stay blocked, but stop must still delete our own resource — a
    // policy failure must never protect a billable Instance from cleanup.
    fake.failVerifyWith = new CloudRunAdminError("invalid", "egress is not ALL_TRAFFIC");
    fake.failVerifyCount = -1;
    const { service } = makeService(fake);
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const blocked = await sandboxRow(sandbox.sandboxId);
    expect(blocked.lastErrorCode).toBe("cloud_instance_unverified");
    expect(blocked.currentResourceUid).toBeNull();
    expect(fake.liveInstanceCount()).toBe(1);
    // Ownership (name + labels) gates the delete; the UID + etag are enforced by the
    // conditional delete itself. Full policy verification stays off the delete path.
    const stopped = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");
    expect(stopped.currentResourceName).toBeNull();
    expect(fake.liveInstanceCount()).toBe(0);
    expect(fake.deleteCalls).toHaveLength(1);
    expect(fake.ownershipChecks).toBeGreaterThan(0);
  });
});

describe("SandboxRunnerService runner scope + readiness", () => {
  async function started(owner: string) {
    const fixture = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const made = makeService(fake);
    const status = await made.service.startForAccount(owner, fixture.sandbox.sandboxId);
    return { ...fixture, fake, ...made, status };
  }

  it("validates bootstrap claims against the CURRENT allocation only", async () => {
    const owner = await account();
    const { sandbox, service, status } = await started(owner);
    const base = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    expect(await service.validateRunnerScope(base)).toMatchObject({ sandboxId: sandbox.sandboxId });
    expect(await service.validateRunnerScope({ ...base, environmentGeneration: 2 })).toBeUndefined();
    expect(
      await service.validateRunnerScope({ ...base, resourceName: "projects/x/locations/y/instances/z" }),
    ).toBeUndefined();
    expect(await service.validateRunnerScope({ ...base, sessionId: randomUUID() })).toBeUndefined();
    expect(await service.validateRunnerScope({ ...base, sandboxId: randomUUID() })).toBeUndefined();
  });

  it("denies credential renewal for rejected allocations while allowing early pending runners", async () => {
    const owner = await account();
    const { sandbox, service, status } = await started(owner);
    const scope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    for (const lastErrorCode of ["cloud_instance_unverified", "cloud_create_rejected", "cloud_create_failed"]) {
      await unit.database
        .update(sandboxes)
        .set({ currentResourceUid: null, lastErrorCode, lastErrorAt: new Date() })
        .where(eq(sandboxes.id, sandbox.sandboxId));
      expect(await service.validateRunnerScope(scope)).toBeUndefined();
    }
    await unit.database
      .update(sandboxes)
      .set({ lastErrorCode: "cloud_create_pending" })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.validateRunnerScope(scope)).toMatchObject({ sandboxId: sandbox.sandboxId });
  });

  it("marks ready only for the current scope with a verified UID; a stale runner cannot mutate", async () => {
    const owner = await account();
    const { sandbox, service, hub, status } = await started(owner);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    expect(await service.markRunnerReady(scope, READINESS)).toBe("ready");
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(row?.lifecycle).toBe("ready");
    // Stale generation: refused, row untouched.
    expect(await service.markRunnerReady({ ...scope, environmentGeneration: 99 }, READINESS)).toBe("stale");
    const [after] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(after?.lifecycle).toBe("ready");
    expect(after?.environmentGeneration).toBe(1);
  });

  it("does not report runnerReady while releasing", async () => {
    const owner = await account();
    const { sandbox, service, hub, status } = await started(owner);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    await service.markRunnerReady(scope, READINESS);
    const fakeStop = service.stopForAccount(owner, sandbox.sandboxId);
    // Stop closes the hub scope immediately; readiness can no longer be reported.
    await fakeStop;
    const after = await service.statusForAccount(owner, sandbox.sandboxId);
    expect(after.runnerReady).toBe(false);
    expect(after.runnerConnected).toBe(false);
  });

  it("rejects acceptance when the environment is not ready", async () => {
    const owner = await account();
    const { sandbox, service } = await started(owner);
    await expect(service.runAcceptanceForAccount(owner, sandbox.sandboxId, { mode: "offline" })).rejects.toMatchObject({
      statusCode: 409,
      code: "SANDBOX_RUNNER_CONFLICT",
    });
  });

  it("readiness performs no cloud I/O: an untracked generation stays deferred until a start reconciles it", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    // The create outcome is unknown and nothing readable landed: no UID is tracked.
    fake.createUnknownWithoutResourceOnce = true;
    const { service, hub } = makeService(fake);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    expect(status.lastErrorCode).toBe("cloud_create_uncertain");
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    const getsBefore = fake.getCalls;
    // Readiness is database CAS/promotion only: a Runner-originated frame must never reconcile,
    // create or release inline — the report stays deferred and the connection stays up.
    expect(await service.markRunnerReady(scope, READINESS)).toBe("deferred");
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("preparing");
    expect(fake.getCalls).toBe(getsBefore);
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.deleteCalls).toHaveLength(0);
    // Cloud I/O belongs to start/stop: a later start reconciles the materialized resource
    // (policy-verified, UID tracked) and promotes the deferred report in the same request.
    fake.materialize(fake.createCalls[0] as RunnerInstanceSpec);
    const reconciled = await service.startForAccount(owner, sandbox.sandboxId);
    expect(reconciled.lifecycle).toBe("ready");
    expect(reconciled.runnerReady).toBe(true);
    expect(fake.createCalls).toHaveLength(1); // the reconcile was GET-only
  });
});

describe("SandboxRunnerService original-image reconnect after a target change", () => {
  const OLD_VERSION = "0.0.4";
  const NEW_VERSION = "0.0.6";
  const OLD_IMAGE = `unit/image@sha256:${"1".repeat(64)}`;
  const NEW_IMAGE = `unit/image@sha256:${"2".repeat(64)}`;

  /** One READY environment whose Instance was created and verified under a previous target. */
  async function readyUnderTarget(
    owner: string,
    target: { image: string; version: string } = { image: OLD_IMAGE, version: OLD_VERSION },
  ) {
    const fixture = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    fake.targetImage = target.image;
    const made = makeService(fake, { expectedRunnerVersion: target.version });
    await made.service.startForAccount(owner, fixture.sandbox.sandboxId);
    const row = await sandboxRow(fixture.sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: fixture.sandbox.sandboxId,
      sessionId: fixture.sandbox.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName as string,
    };
    const readiness = { ...READINESS, runnerVersion: target.version };
    const socket = fakeSocket();
    made.hub.attach(scope, socket);
    made.hub.markReady(scope, readiness, socket);
    expect(await made.service.markRunnerReady(scope, readiness)).toBe("ready");
    expect((await sandboxRow(fixture.sandbox.sandboxId)).lifecycle).toBe("ready");
    return { ...fixture, fake, ...made, scope, socket };
  }

  /** A fresh Server process over the same database/cloud with a changed deployment target. */
  function restartedWithTarget(fake: RunnerFakeCloudRunAdmin, target: { image: string; version: string }) {
    fake.targetImage = target.image;
    return makeService(fake, { expectedRunnerVersion: target.version });
  }

  /** Park the next provider read so the test can mutate the row mid-verification. */
  function gateNextProviderRead(fake: RunnerFakeCloudRunAdmin) {
    const realGet = fake.getInstance.bind(fake);
    let release!: () => void;
    let markStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let gated = true;
    fake.getInstance = async (name: string) => {
      if (gated) {
        gated = false;
        markStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realGet(name);
    };
    return { readStarted, release: () => release() };
  }

  it("accepts a previously verified READY Instance reconnecting on its original image after a target upgrade", async () => {
    const owner = await account();
    const { sandbox, fake, scope } = await readyUnderTarget(owner);
    const restart = restartedWithTarget(fake, { image: NEW_IMAGE, version: NEW_VERSION });
    const socket = fakeSocket();
    restart.hub.attach(scope, socket);
    const getsBefore = fake.getCalls;
    // The Runner still runs its original build: exactly one bounded provider re-verification
    // (tracked ownership + non-image policy + provably original image) accepts the report.
    expect(await restart.service.markRunnerReady(scope, { ...READINESS, runnerVersion: OLD_VERSION })).toBe("ready");
    expect(fake.getCalls).toBe(getsBefore + 1);
    expect(restart.hub.markReady(scope, { ...READINESS, runnerVersion: OLD_VERSION }, socket)).toBe(true);
    const status = await restart.service.statusForAccount(owner, sandbox.sandboxId);
    expect(status.lifecycle).toBe("ready");
    expect(status.runnerReady).toBe(true);
    // No replacement, no cleanup: the existing Instance simply continues.
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.deleteCalls).toHaveLength(0);
    expect(fake.liveInstanceCount()).toBe(1);
    // And the legacy Instance still releases normally on explicit stop.
    const stopped = await restart.service.stopForAccount(owner, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");
    expect(fake.liveInstanceCount()).toBe(0);
  });

  it("keeps a newer existing Runner permitted when the target rolls back", async () => {
    const owner = await account();
    // The Instance was created and verified under the NEWER target; the target rolls back.
    const { sandbox, fake, scope } = await readyUnderTarget(owner, { image: NEW_IMAGE, version: NEW_VERSION });
    const rollback = restartedWithTarget(fake, { image: OLD_IMAGE, version: OLD_VERSION });
    const socket = fakeSocket();
    rollback.hub.attach(scope, socket);
    expect(await rollback.service.markRunnerReady(scope, { ...READINESS, runnerVersion: NEW_VERSION })).toBe("ready");
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("ready");
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.liveInstanceCount()).toBe(1);
  });

  it("rejects a wrong-version report on the CURRENT target image even for a tracked READY row", async () => {
    const owner = await account();
    const { sandbox, fake, scope } = await readyUnderTarget(owner);
    // The target image did NOT change; only the expected version string moved. A report naming
    // neither the expected version nor a provably different image is a wrong-version report.
    const restart = makeService(fake, { expectedRunnerVersion: NEW_VERSION });
    const socket = fakeSocket();
    restart.hub.attach(scope, socket);
    expect(await restart.service.markRunnerReady(scope, { ...READINESS, runnerVersion: OLD_VERSION })).toBe(
      "version_mismatch",
    );
    expect(restart.hub.describe(sandbox.sandboxId).ready).toBe(false);
    expect((await restart.service.statusForAccount(owner, sandbox.sandboxId)).runnerReady).toBe(false);
  });

  it("keeps first admission fail-closed: preparing allocations never reach the original-image path", async () => {
    const owner = await account();
    const { sandbox, fake, scope } = await readyUnderTarget(owner);
    // Back the row down to a tracked-but-never-ready allocation (create verified, no readiness).
    await unit.database.update(sandboxes).set({ lifecycle: "preparing" }).where(eq(sandboxes.id, sandbox.sandboxId));
    const restart = restartedWithTarget(fake, { image: NEW_IMAGE, version: NEW_VERSION });
    const getsBefore = fake.getCalls;
    expect(await restart.service.markRunnerReady(scope, { ...READINESS, runnerVersion: OLD_VERSION })).toBe(
      "version_mismatch",
    );
    expect(fake.getCalls).toBe(getsBefore);
    // An UNTRACKED new allocation (create outcome unknown, no UID) is rejected the same way.
    const second = await ownedSandbox(owner);
    fake.createUnknownWithoutResourceOnce = true;
    const pending = await restart.service.startForAccount(owner, second.sandbox.sandboxId);
    expect(pending.lastErrorCode).toBe("cloud_create_uncertain");
    expect(pending.currentResourceUid).toBeNull();
    const untrackedScope: RunnerScope = {
      sandboxId: second.sandbox.sandboxId,
      sessionId: second.sandbox.sessionId,
      environmentGeneration: pending.environmentGeneration,
      resourceName: pending.currentResourceName as string,
    };
    expect(await restart.service.markRunnerReady(untrackedScope, { ...READINESS, runnerVersion: OLD_VERSION })).toBe(
      "version_mismatch",
    );
    expect(fake.getCalls).toBe(getsBefore);
    expect((await sandboxRow(second.sandbox.sandboxId)).lifecycle).toBe("preparing");
  });

  it("fails closed when the tracked binding changes while the provider read is in flight", async () => {
    const owner = await account();
    const { sandbox, fake, scope } = await readyUnderTarget(owner);
    const restart = restartedWithTarget(fake, { image: NEW_IMAGE, version: NEW_VERSION });
    const gate = gateNextProviderRead(fake);
    const pending = restart.service.markRunnerReady(scope, { ...READINESS, runnerVersion: OLD_VERSION });
    await gate.readStarted;
    // The tracked UID was replaced mid-verification: the recheck after the read must refuse.
    await unit.database
      .update(sandboxes)
      .set({ currentResourceUid: "uid-swapped" })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    gate.release();
    expect(await pending).toBe("stale");
    expect(await sandboxRow(sandbox.sandboxId)).toMatchObject({
      lifecycle: "ready",
      currentResourceUid: "uid-swapped",
    });
  });

  it("defers instead of accepting when an idle claim lands during the provider read", async () => {
    const owner = await account();
    const { sandbox, fake, scope } = await readyUnderTarget(owner);
    const restart = restartedWithTarget(fake, { image: NEW_IMAGE, version: NEW_VERSION });
    const gate = gateNextProviderRead(fake);
    const pending = restart.service.markRunnerReady(scope, { ...READINESS, runnerVersion: OLD_VERSION });
    await gate.readStarted;
    // A claim landed mid-verification: the environment is quiescing for a transfer or deletion,
    // so readiness must not be re-published; the seal-capable channel stays attached.
    await unit.database.update(sandboxes).set({ idleReclaimAt: new Date() }).where(eq(sandboxes.id, sandbox.sandboxId));
    gate.release();
    expect(await pending).toBe("deferred");
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("ready");
  });

  it("propagates a temporary provider failure for reconnect and permits the next verified attempt", async () => {
    const owner = await account();
    const { sandbox, fake, scope } = await readyUnderTarget(owner);
    const restart = restartedWithTarget(fake, { image: NEW_IMAGE, version: NEW_VERSION });
    fake.getInstanceFailures = 1;
    await expect(
      restart.service.markRunnerReady(scope, { ...READINESS, runnerVersion: OLD_VERSION }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    // The tracked READY row is untouched: a transient read failure is not a revocation.
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("ready");
    expect(fake.liveInstanceCount()).toBe(1);
    expect(await restart.service.markRunnerReady(scope, { ...READINESS, runnerVersion: OLD_VERSION })).toBe("ready");
  });

  it("rejects an externally updated image even when the physical UID is unchanged", async () => {
    const owner = await account();
    const { sandbox, fake, scope } = await readyUnderTarget(owner);
    const before = await sandboxRow(sandbox.sandboxId);
    const restart = restartedWithTarget(fake, { image: NEW_IMAGE, version: NEW_VERSION });
    fake.replaceImage(scope.resourceName, `unit/image@sha256:${"3".repeat(64)}`);
    expect(await restart.service.markRunnerReady(scope, { ...READINESS, runnerVersion: OLD_VERSION })).toBe(
      "version_mismatch",
    );
    expect((await sandboxRow(sandbox.sandboxId)).currentResourceUid).toBe(before.currentResourceUid);
  });

  it("keeps a claimed environment's seal channel without any provider verification", async () => {
    const owner = await account();
    const { sandbox, fake, scope } = await readyUnderTarget(owner);
    await unit.database.update(sandboxes).set({ idleReclaimAt: new Date() }).where(eq(sandboxes.id, sandbox.sandboxId));
    const restart = restartedWithTarget(fake, { image: NEW_IMAGE, version: NEW_VERSION });
    const getsBefore = fake.getCalls;
    expect(await restart.service.markRunnerReady(scope, { ...READINESS, runnerVersion: OLD_VERSION })).toBe("deferred");
    expect(fake.getCalls).toBe(getsBefore);
  });
});

describe("SandboxRunnerService acceptance", () => {
  async function readySandbox(owner: string, options: { acceptanceTimeoutMs?: number } = {}) {
    const fixture = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service, hub } = makeService(fake, options);
    const status = await service.startForAccount(owner, fixture.sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: fixture.sandbox.sandboxId,
      sessionId: fixture.sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    expect(await service.markRunnerReady(scope, READINESS)).toBe("ready");
    return { ...fixture, fake, service, hub, socket, scope };
  }

  it("correlates a bounded acceptance run end-to-end without echoing secrets", async () => {
    const owner = await account();
    const { sandbox, service, hub, socket } = await readySandbox(owner);
    const pending = service.runAcceptanceForAccount(owner, sandbox.sandboxId, {
      mode: "real",
      piConfig: { authJson: '{"deepseek":{"token":"secret"}}' },
    });
    type RunFrame = {
      type: "acceptance:run";
      requestId: string;
      mode: string;
      deadlineAtMs: number;
      piConfig?: unknown;
    };
    let runFrame: RunFrame | undefined;
    await vi.waitFor(() => {
      runFrame = socket.sent.find((frame): frame is RunFrame => (frame as { type?: string }).type === "acceptance:run");
      expect(runFrame).toBeDefined();
    });
    expect(runFrame?.mode).toBe("real");
    expect(runFrame?.deadlineAtMs).toBeGreaterThan(Date.now());
    expect((runFrame?.piConfig as { authJson: string } | undefined)?.authJson).toContain("secret");
    hub.resolveAcceptanceResult(
      sandbox.sandboxId,
      {
        type: "acceptance:result",
        requestId: runFrame?.requestId ?? "",
        outcome: "passed",
        report: { events: [], failed: false, model: "passed", offline: "passed" },
      },
      socket,
    );
    const response = await pending;
    expect(response.outcome).toBe("passed");
    expect(response.requestId).toBe(runFrame?.requestId);
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(response.environmentGeneration).toBe(1);
  });

  it("times a hung run out as a conflict and cancels on the runner", async () => {
    const owner = await account();
    const { sandbox, service, socket } = await readySandbox(owner, { acceptanceTimeoutMs: 200 });
    await expect(service.runAcceptanceForAccount(owner, sandbox.sandboxId, { mode: "offline" })).rejects.toMatchObject({
      statusCode: 409,
      code: "SANDBOX_RUNNER_CONFLICT",
    });
    await vi.waitFor(() => {
      expect(socket.sent.some((frame) => (frame as { type?: string }).type === "acceptance:cancel")).toBe(true);
    });
  });

  it("rejects a concurrent second acceptance immediately", async () => {
    const owner = await account();
    const { sandbox, service, hub, socket } = await readySandbox(owner);
    const first = service.runAcceptanceForAccount(owner, sandbox.sandboxId, { mode: "offline" });
    await vi.waitFor(() => {
      expect(socket.sent.some((frame) => (frame as { type?: string }).type === "acceptance:run")).toBe(true);
    });
    await expect(service.runAcceptanceForAccount(owner, sandbox.sandboxId, { mode: "offline" })).rejects.toMatchObject({
      statusCode: 409,
    });
    const requestId = (
      socket.sent.find((frame) => (frame as { type?: string }).type === "acceptance:run") as {
        requestId: string;
      }
    ).requestId;
    hub.resolveAcceptanceResult(sandbox.sandboxId, { type: "acceptance:result", requestId, outcome: "passed" }, socket);
    await expect(first).resolves.toMatchObject({ outcome: "passed" });
  });
});
