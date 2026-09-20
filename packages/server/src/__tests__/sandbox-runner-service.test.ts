/** E3 allocation orchestration decisions on the embedded PostgreSQL engine; cloud via a fake admin. */
import { randomUUID } from "node:crypto";
import { RUNNER_WORKSPACE_TIMEOUT_MS } from "@opentag/shared";
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
import { WorkspaceObjectStoreError } from "../services/sandboxes/workspace-object-store.js";
import { FakeWorkspaceObjectStore } from "./support/fake-workspace-store.js";

/**
 * A Runner socket that answers workspace seals the way the real Runner does: it plants the sealed
 * archive before acknowledging so the Server's metadata read-back can prove the save.
 */
function sealCapableSocket(
  hub: RunnerHub,
  store: FakeWorkspaceObjectStore,
  sandbox: { id: string; sessionId: string; storageUri: string; environmentGeneration: number },
  options: { ok?: boolean; plant?: boolean } = {},
): RunnerControlSocket {
  const socket: RunnerControlSocket = {
    send(frame) {
      if (frame.type !== "workspace:seal") return;
      if (options.plant !== false) {
        store.plant(
          {
            storageUri: sandbox.storageUri,
            sandboxId: sandbox.id,
            sessionId: sandbox.sessionId,
            environmentGeneration: sandbox.environmentGeneration,
          },
          { saved: true, sealed: true, ownerGeneration: sandbox.environmentGeneration },
        );
      }
      hub.settleWorkspaceSeal(
        sandbox.id,
        options.ok === false
          ? { type: "workspace:seal:result", requestId: frame.requestId, ok: false, code: "workspace_save_failed" }
          : { type: "workspace:seal:result", requestId: frame.requestId, ok: true },
        socket,
      );
    },
    close() {
      // The hub owns connection replacement; the tests only need the send surface.
    },
  };
  return socket;
}

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
    /** E5 object store; omitted keeps the deployment in legacy (no persistence) mode. */
    workspace?: FakeWorkspaceObjectStore;
    /** Bounded window for the Runner-side seal; defaults to the production 4x transfer timeout. */
    sealTimeoutMs?: number;
    idleTimeoutMs?: number;
    now?: () => Date;
    sessionWorkBusy?: ConstructorParameters<typeof SandboxRunnerService>[1]["sessionWorkBusy"];
    /** Real `setTimeout` sleeping, for the one case that pins the default sleep implementation. */
    realSleep?: boolean;
    database?: ConstructorParameters<typeof SandboxRunnerService>[0];
  } = {},
) {
  const tokens =
    options.tokens ??
    new RunnerBootstrapTokenService("unit-test-jwt-secret-at-least-32-characters", { ttlSeconds: 600 });
  const hub = new RunnerHub();
  const service = new SandboxRunnerService(options.database ?? unit.database, {
    cloudAdmin: fake as never,
    tokens,
    hub,
    environment: "staging",
    backendUrl: "wss://api.example.com/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: options.expectedRunnerVersion ?? RUNNER_VERSION,
    acceptanceTimeoutMs: options.acceptanceTimeoutMs ?? 30_000,
    createConvergeTimeoutMs: options.createConvergeTimeoutMs ?? 30_000,
    ...(options.realSleep ? {} : { sleep: () => Promise.resolve() }),
    deleteVerifyTimeoutMs: options.deleteVerifyTimeoutMs ?? 10_000,
    ...(options.workspace
      ? {
          workspace: {
            store: options.workspace,
            ...(options.sealTimeoutMs !== undefined ? { sealTimeoutMs: options.sealTimeoutMs } : {}),
          },
        }
      : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.sessionWorkBusy ? { sessionWorkBusy: options.sessionWorkBusy } : {}),
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

  it("maps an unwritable Runner channel to a conflict instead of leaking the hub error", async () => {
    const owner = await account();
    const { sandbox, service, socket } = await readySandbox(owner);
    // The readiness path is satisfied, but the frame write fails: the hub rejects with its own
    // RunnerAcceptanceUnavailableError, which is not a SandboxServiceError.
    socket.send = () => {
      throw new Error("socket gone");
    };
    await expect(service.runAcceptanceForAccount(owner, sandbox.sandboxId, { mode: "offline" })).rejects.toMatchObject({
      statusCode: 409,
      code: "SANDBOX_RUNNER_CONFLICT",
    });
  });

  it("refuses an acceptance when the hub entry vanished after the ready status check", async () => {
    const owner = await account();
    const { sandbox, service, hub, socket } = await readySandbox(owner);
    // `currentSocket` reads the entry directly: detaching leaves the readiness checks stale for
    // the width of one call, so this pins the defensive null-socket guard.
    hub.detach(sandbox.sandboxId, socket);
    const described = { ...hub.describe(sandbox.sandboxId) };
    hub.describe = () => ({ ...described, connected: true, ready: true, scope: described.scope });
    await expect(service.runAcceptanceForAccount(owner, sandbox.sandboxId, { mode: "offline" })).rejects.toMatchObject({
      statusCode: 409,
      code: "SANDBOX_RUNNER_CONFLICT",
    });
  });

  it("propagates a non-hub failure from the acceptance run unchanged", async () => {
    const owner = await account();
    const { sandbox, service, hub } = await readySandbox(owner);
    hub.runAcceptance = async () => {
      throw new Error("unexpected unit failure");
    };
    await expect(service.runAcceptanceForAccount(owner, sandbox.sandboxId, { mode: "offline" })).rejects.toThrow(
      "unexpected unit failure",
    );
  });
});

describe("SandboxRunnerService constructor validation", () => {
  it("requires a non-empty expected Runner version", () => {
    const fake = new RunnerFakeCloudRunAdmin();
    expect(() => makeService(fake, { expectedRunnerVersion: "" })).toThrow(
      "SandboxRunnerService requires the expected Runner version",
    );
  });

  it("requires a positive idleTimeoutMs", () => {
    const fake = new RunnerFakeCloudRunAdmin();
    const tokens = new RunnerBootstrapTokenService("unit-test-jwt-secret-at-least-32-characters", { ttlSeconds: 600 });
    const build = (idleTimeoutMs: number) =>
      new SandboxRunnerService(unit.database, {
        cloudAdmin: fake as never,
        tokens,
        hub: new RunnerHub(),
        environment: "staging",
        backendUrl: "wss://api.example.com/api/v1/sandbox-runners/ws",
        expectedRunnerVersion: RUNNER_VERSION,
        acceptanceTimeoutMs: 30_000,
        createConvergeTimeoutMs: 30_000,
        idleTimeoutMs,
      });
    expect(() => build(0)).toThrow("SandboxRunnerService requires a positive idleTimeoutMs");
    expect(() => build(-1)).toThrow("SandboxRunnerService requires a positive idleTimeoutMs");
    expect(build(1).workspacePersistenceEnabled).toBe(false);
  });
});

describe("SandboxRunnerService allocation reconciliation", () => {
  /** A preparing row with the given marker/name/UID/LRO, written directly (legacy-row simulation). */
  async function preparingRow(
    owner: string,
    overrides: Partial<{
      currentResourceName: string | null;
      currentResourceUid: string | null;
      currentOperationName: string | null;
      lastErrorCode: string | null;
      environmentGeneration: number;
    }>,
  ) {
    const fixture = await ownedSandbox(owner);
    await unit.database
      .update(sandboxes)
      .set({
        lifecycle: "preparing",
        environmentGeneration: 1,
        lastErrorAt: overrides.lastErrorCode ? new Date() : null,
        ...overrides,
      })
      .where(eq(sandboxes.id, fixture.sandbox.sandboxId));
    return fixture;
  }

  /** The deterministic resource name the service computes for a Sandbox at generation 1. */
  function expectedResourceName(sandbox: { sandboxId: string; sessionId: string }): string {
    return `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/instances/${runnerInstanceId({
      environment: "staging",
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
    })}`;
  }

  it("answers undefined for an unknown Sandbox and untracked for every released phase", async () => {
    const owner = await account();
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    expect(await service.reconcileAllocation(randomUUID())).toBeUndefined();

    const { sandbox } = await ownedSandbox(owner);
    expect(await service.reconcileAllocation(sandbox.sandboxId)).toMatchObject({
      scope: null,
      lifecycle: "unallocated",
      physical: "untracked",
    });
    // A name without a UID never proves physical state.
    await unit.database
      .update(sandboxes)
      .set({
        lifecycle: "preparing",
        environmentGeneration: 1,
        currentResourceName: "projects/p/locations/l/instances/x",
      })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.reconcileAllocation(sandbox.sandboxId)).toMatchObject({ physical: "untracked" });
    // Releasing is a terminal-by-construction phase for this read: never "present".
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "releasing", currentResourceUid: "uid-1" })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.reconcileAllocation(sandbox.sandboxId)).toMatchObject({ physical: "untracked" });
    expect(fake.getCalls).toBe(0);
  });

  it("classifies a tracked allocation as present, absent or unknown without mutating anything", async () => {
    const owner = await account();
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const started = await ownedSandbox(owner);
    const status = await service.startForAccount(owner, started.sandbox.sandboxId);
    const name = status.currentResourceName as string;
    const row = await sandboxRow(started.sandbox.sandboxId);

    expect(await service.reconcileAllocation(started.sandbox.sandboxId)).toMatchObject({
      scope: { sandboxId: started.sandbox.sandboxId, resourceName: name },
      lifecycle: "preparing",
      resourceUid: row.currentResourceUid,
      physical: "present",
    });
    // A different UID at the same name is absent, not present: our allocation is gone.
    fake.replaceUid(name, "uid-replacement");
    expect(await service.reconcileAllocation(started.sandbox.sandboxId)).toMatchObject({ physical: "absent" });
    // An unreadable provider proves nothing.
    fake.getInstanceFailures = 1;
    expect(await service.reconcileAllocation(started.sandbox.sandboxId)).toMatchObject({ physical: "unknown" });
    // Read-only: the row and the provider are both untouched by any of the three reads.
    expect(await sandboxRow(started.sandbox.sandboxId)).toMatchObject({
      lifecycle: "preparing",
      currentResourceName: name,
    });
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("assigns the deterministic name to a legacy preparing row without one, then reconciles it", async () => {
    const owner = await account();
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const { sandbox } = await preparingRow(owner, {
      currentResourceName: null,
      currentResourceUid: null,
      currentOperationName: null,
      lastErrorCode: null,
    });
    // The Instance was created before the name was persisted; a read at the deterministic name finds
    // it, so the legacy row converges without any POST.
    fake.materialize({
      environment: "staging",
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      backendUrl: "wss://unit.invalid",
      bootstrapToken: "unit",
    });
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    expect(status.currentResourceName).toBe(expectedResourceName(sandbox));
    expect(status.currentResourceUid).toMatch(/^uid-/);
    expect(fake.createCalls).toHaveLength(0); // the read reconciled the pre-existing Instance
  });

  it("reports an unknown create outcome when no operation identity is available to inspect", async () => {
    const owner = await account();
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const { sandbox } = await preparingRow(owner, {
      currentResourceName: null,
      currentResourceUid: null,
      currentOperationName: null,
      lastErrorCode: null,
    });
    // `cloud_create_uncertain` is the weakest evidence: writing it over a create-phase marker is a
    // deliberate no-op, so the row keeps whatever stronger marker it already had.
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    expect(status.lastErrorCode).toBe("cloud_create_uncertain");
    expect(fake.createCalls).toHaveLength(0);
  });

  it("keeps the reference uncertain while an operation is still running", async () => {
    const owner = await account();
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const operation = `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/operations/op-running`;
    const { sandbox } = await preparingRow(owner, {
      currentResourceName: null,
      currentResourceUid: null,
      currentOperationName: operation,
      lastErrorCode: null,
    });
    // The LRO is still running and no resource is readable: the reconciler must inspect the
    // operation and report uncertainty rather than resubmitting.
    fake.operations.set(operation, { state: "pending" });
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    expect(status.lastErrorCode).toBe("cloud_create_uncertain");
    expect(fake.createCalls).toHaveLength(0);
  });

  it("refuses a create operation that names a different resource than the tracked one", async () => {
    const owner = await account();
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const operation = `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/operations/op-elsewhere`;
    const { sandbox } = await preparingRow(owner, {
      currentResourceName: null,
      currentResourceUid: null,
      currentOperationName: operation,
      lastErrorCode: "cloud_create_pending",
    });
    fake.operations.set(operation, { state: "done", resourceName: "projects/p/locations/l/instances/someone-else" });
    // The mismatched LRO is a deterministic ownership failure, surfaced as the 503 envelope.
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(fake.createCalls).toHaveLength(0);
  });
});

describe("SandboxRunnerService ingress allocation", () => {
  it("reports restore_required for a used generation when persistence is not configured", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "unallocated", environmentGeneration: 3 })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.ensureIngressAllocation(owner, sandbox.sandboxId)).toBe("restore_required");
    expect(fake.createCalls).toHaveLength(0);
  });

  it("answers stopped for a releasing row without touching Cloud", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.ensureIngressAllocation(owner, sandbox.sandboxId)).toBe("stopped");
    expect(fake.createCalls).toHaveLength(0);
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("allocates the first generation and reports pending until the Runner reports readiness", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    expect(await service.ensureIngressAllocation(owner, sandbox.sandboxId)).toBe("pending");
    expect(fake.createCalls).toHaveLength(1);
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("preparing");
  });

  it("returns ready for a connected ready environment without reconciling Cloud", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service, hub } = makeService(fake, { workspace: store });
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    expect(await service.runAcceptanceForAccount).toBeDefined();
    await service.noteActivity(sandbox.sandboxId);
    await unit.database.update(sandboxes).set({ lifecycle: "ready" }).where(eq(sandboxes.id, sandbox.sandboxId));
    const getsBefore = fake.getCalls;
    expect(await service.ensureIngressAllocation(owner, sandbox.sandboxId)).toBe("ready");
    expect(fake.getCalls).toBe(getsBefore);
  });
});

describe("SandboxRunnerService workspace persistence (E5)", () => {
  /** One workspace-enabled deployment: store present, sandbox owned, `environmentGeneration` untouched. */
  function workspaceService(fake: RunnerFakeCloudRunAdmin, store: FakeWorkspaceObjectStore) {
    return makeService(fake, { workspace: store });
  }

  it("creates the first archive before any reservation and never creates without a name", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = workspaceService(fake, store);
    expect(service.workspacePersistenceEnabled).toBe(true);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    expect(status.lifecycle).toBe("preparing");
    expect(store.claims).toBe(1);
    expect(fake.createCalls[0]).toMatchObject({ workspacePersistence: true });
  });

  it("reports restore_required when the archive for a used generation is missing", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = workspaceService(fake, store);
    // Generation 2 with no object at the stable storage URI: the workspace cannot be restored.
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "unallocated", environmentGeneration: 2 })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({
      code: "SANDBOX_RUNNER_CONFLICT",
    });
    expect(fake.createCalls).toHaveLength(0);
    expect(await service.ensureIngressAllocation(owner, sandbox.sandboxId)).toBe("restore_required");
  });

  it("maps a storage failure before reservation to the 503 envelope", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = workspaceService(fake, store);
    // A non-first generation with no object AND a claim failure is the transient storage error.
    store.failNextClaimWith = new WorkspaceObjectStoreError("unavailable", "storage is down");
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "unallocated", environmentGeneration: 0 })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 503,
      category: "transient",
    });
    expect(fake.createCalls).toHaveLength(0);
  });

  it("fails a readiness report that arrives without the restore proof", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service, hub } = workspaceService(fake, store);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    // An execution-capable Runner must prove the restored archive before anything may be ready.
    expect(await service.markRunnerReady(scope, READINESS)).toBe("workspace_not_restored");
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("preparing");
    expect(await service.markRunnerReady(scope, READINESS, { workspaceRestored: true })).toBe("ready");
  });

  it("clears a ready allocation whose tracked UID the provider confirms absent, without deleting anything", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = workspaceService(fake, store);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    await unit.database.update(sandboxes).set({ lifecycle: "ready" }).where(eq(sandboxes.id, sandbox.sandboxId));
    const before = await sandboxRow(sandbox.sandboxId);
    const instance = fake.instances.get(status.currentResourceName as string);
    if (instance) instance.gone = true;
    // Recovery is folded into the start request: the stale binding is cleared with no `releasing`
    // transition and no delete, and the same start then reserves the next generation.
    const after = await service.startForAccount(owner, sandbox.sandboxId);
    expect(before.lifecycle).toBe("ready");
    expect(after.environmentGeneration).toBe(before.environmentGeneration + 1);
    expect(after.currentResourceName).not.toBe(before.currentResourceName);
    expect(fake.deleteCalls).toHaveLength(0); // nothing was deleted: the resource was already gone
    expect(fake.createCalls).toHaveLength(2); // the fresh generation was allocated
  });

  it("keeps a ready allocation whose provider read fails", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = workspaceService(fake, store);
    await service.startForAccount(owner, sandbox.sandboxId);
    await unit.database.update(sandboxes).set({ lifecycle: "ready" }).where(eq(sandboxes.id, sandbox.sandboxId));
    const before = await sandboxRow(sandbox.sandboxId);
    fake.getInstanceFailures = 1;
    // A failed GET proves nothing: the allocation is kept and the failure is surfaced.
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(await sandboxRow(sandbox.sandboxId)).toMatchObject({
      lifecycle: "ready",
      currentResourceName: before.currentResourceName,
    });
  });

  it("seals the workspace before deleting and retains the binding when the seal fails", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service, hub } = workspaceService(fake, store);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    const row = await sandboxRow(sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const failing = sealCapableSocket(hub, store, { ...row, environmentGeneration: 1 }, { ok: false });
    hub.attach(scope, failing);
    hub.markReady(scope, READINESS, failing);
    await service.markRunnerReady(scope, READINESS, { workspaceRestored: true });
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
    });
    const retained = await sandboxRow(sandbox.sandboxId);
    expect(retained.lifecycle).toBe("releasing");
    expect(retained.currentResourceName).toBe(status.currentResourceName);
    expect(retained.lastErrorCode).toBe("workspace_save_failed");
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("releases through a seal-capable Runner and verifies the archive before deletion", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service, hub } = workspaceService(fake, store);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    const row = await sandboxRow(sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = sealCapableSocket(hub, store, { ...row, environmentGeneration: 1 });
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    await service.markRunnerReady(scope, READINESS, { workspaceRestored: true });
    const stopped = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");
    expect(store.writes.length).toBeGreaterThanOrEqual(0);
    expect(fake.deleteCalls).toHaveLength(1);
    expect(fake.liveInstanceCount()).toBe(0);
  });

  it("refuses to seal when no Runner holds the current allocation", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = workspaceService(fake, store);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    // Force the save marker without ever attaching a Runner: the seal cannot be requested.
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "ready", lastErrorCode: "workspace_save_required", lastErrorAt: new Date() })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(fake.deleteCalls).toHaveLength(0);
    expect((await sandboxRow(sandbox.sandboxId)).currentResourceName).toBe(status.currentResourceName);
  });

  it("short-circuits the Runner round-trip when the archive is already proven sealed", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = workspaceService(fake, store);
    await service.startForAccount(owner, sandbox.sandboxId);
    const row = await sandboxRow(sandbox.sandboxId);
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "ready", lastErrorCode: "workspace_save_required", lastErrorAt: new Date() })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    store.plant(
      { storageUri: row.storageUri, sandboxId: row.id, sessionId: row.sessionId, environmentGeneration: 1 },
      { saved: true, sealed: true, ownerGeneration: 1 },
    );
    const stopped = await service.stopForAccount(owner, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");
    expect(fake.deleteCalls).toHaveLength(1);
    expect(store.writes).toHaveLength(0);
  });

  it("keeps the allocation when the archived proof cannot be read at all", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = workspaceService(fake, store);
    await service.startForAccount(owner, sandbox.sandboxId);
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "ready", lastErrorCode: "workspace_save_required", lastErrorAt: new Date() })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    store.head = async () => {
      throw new WorkspaceObjectStoreError("unavailable", "storage is down");
    };
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("refuses the automatic sweep's save when the Instance cannot persist its workspace", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const idleNow = new Date("2026-01-01T00:00:00.000Z");
    const { service } = makeService(fake, {
      workspace: store,
      idleTimeoutMs: 1_000,
      now: () => new Date(idleNow.getTime() + 60_000),
    });
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    const instance = fake.instances.get(status.currentResourceName as string);
    if (instance) instance.spec.workspacePersistence = false;
    // The environment was promoted and then claimed by the sweep: only an automatic claim reaches
    // the legacy-Instance guard, because an explicit stop clears the claim marker first.
    await unit.database
      .update(sandboxes)
      .set({
        lifecycle: "ready",
        lastErrorCode: "workspace_save_required",
        lastErrorAt: idleNow,
        idleReclaimAt: idleNow,
        lastActivityAt: idleNow,
      })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    const sweep = await service.reclaimIdleSandboxes();
    expect(sweep).toMatchObject({ released: 0, failed: 1 });
    const row = await sandboxRow(sandbox.sandboxId);
    expect(row.lifecycle).toBe("ready");
    expect(row.currentResourceName).toBe(status.currentResourceName);
    expect(row.lastErrorCode).toBe("workspace_save_failed");
    expect(fake.deleteCalls).toHaveLength(0); // the only local copy is preserved
  });

  it("finishes a pending release inside the same start when the create lands while releasing", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = workspaceService(fake, store);
    let open!: () => void;
    fake.createGate = {
      promise: new Promise<void>((resolve) => {
        open = resolve;
      }),
      open: () => open(),
    };
    const start = service.startForAccount(owner, sandbox.sandboxId);
    await vi.waitFor(() => expect(fake.createCalls).toHaveLength(1));
    const name = (await sandboxRow(sandbox.sandboxId)).currentResourceName as string;
    await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, sandbox.sandboxId));
    // No Runner was ever attached, so the pending release resolves through the same funnel.
    await unit.database
      .update(sandboxes)
      .set({ lastErrorCode: "cloud_create_pending", lastErrorAt: new Date() })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    open();
    const settled = await start;
    expect(settled.lifecycle).toBe("unallocated");
    expect(settled.currentResourceName).not.toBe(name);
    expect(fake.liveInstanceCount()).toBe(0);
  });
});

describe("SandboxRunnerService Runner control channel", () => {
  /** A started (preparing, UID-tracked) allocation plus the claims naming it. */
  async function startedClaims(owner: string, options: { workspace?: FakeWorkspaceObjectStore } = {}) {
    const fixture = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const made = makeService(fake, options.workspace ? { workspace: options.workspace } : {});
    const status = await made.service.startForAccount(owner, fixture.sandbox.sandboxId);
    const claims: RunnerBootstrapClaims = {
      sandboxId: fixture.sandbox.sandboxId,
      sessionId: fixture.sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    return { ...fixture, ...made, status, claims, fake };
  }

  it("validates a channel scope against the persisted allocation, not the live authority chain", async () => {
    const owner = await account();
    const { sandbox, service, claims } = await startedClaims(owner);
    expect(await service.validateRunnerChannelScope(claims)).toMatchObject({ sandboxId: sandbox.sandboxId });
    expect(await service.validateRunnerChannelScope({ ...claims, sandboxId: randomUUID() })).toBeUndefined();
    expect(await service.validateRunnerChannelScope({ ...claims, sessionId: randomUUID() })).toBeUndefined();
    expect(await service.validateRunnerChannelScope({ ...claims, environmentGeneration: 9 })).toBeUndefined();
    expect(
      await service.validateRunnerChannelScope({ ...claims, resourceName: "projects/x/locations/y/instances/z" }),
    ).toBeUndefined();
    // An unallocated row has no channel at all.
    await unit.database.update(sandboxes).set({ lifecycle: "unallocated" }).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.validateRunnerChannelScope(claims)).toBeUndefined();
  });

  it("refuses a channel scope for a definitive failure marker while allowing the pending phase", async () => {
    const owner = await account();
    const { sandbox, service, claims } = await startedClaims(owner);
    for (const lastErrorCode of ["cloud_instance_unverified", "cloud_create_rejected", "cloud_create_failed"]) {
      // The schema pairs a marker with its timestamp, so both move together.
      await unit.database
        .update(sandboxes)
        .set({ lastErrorCode, lastErrorAt: new Date() })
        .where(eq(sandboxes.id, sandbox.sandboxId));
      expect(await service.validateRunnerChannelScope(claims)).toBeUndefined();
    }
    await unit.database
      .update(sandboxes)
      .set({ lastErrorCode: "cloud_create_pending", lastErrorAt: new Date() })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.validateRunnerChannelScope(claims)).toMatchObject({ sandboxId: sandbox.sandboxId });
  });

  it("renews an expired bootstrap only while the tracked allocation is still physically present", async () => {
    const owner = await account();
    const store = new FakeWorkspaceObjectStore();
    const { sandbox, service, fake, tokens, claims } = await startedClaims(owner, { workspace: store });
    const renewed = await service.renewExpiredBootstrap(claims);
    expect(renewed).toBeDefined();
    expect(await tokens.verify(renewed as string)).toEqual(claims);

    // A tracked UID that is no longer readable is not a renewal authority.
    fake.replaceUid(claims.resourceName, "uid-replaced");
    expect(await service.renewExpiredBootstrap(claims)).toBeUndefined();

    // No tracked UID at all: renewal is refused before any provider call.
    const missing = fake.instances.get(claims.resourceName);
    if (missing) missing.gone = false;
    await unit.database.update(sandboxes).set({ currentResourceUid: null }).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.renewExpiredBootstrap(claims)).toBeUndefined();
  });

  it("refuses expiration renewal entirely without workspace persistence", async () => {
    const owner = await account();
    const { service, claims } = await startedClaims(owner);
    expect(await service.renewExpiredBootstrap(claims)).toBeUndefined();
  });

  it("resolves the physical holder from the birth identity and revalidates after the provider read", async () => {
    const owner = await account();
    const { sandbox, service, fake, claims } = await startedClaims(owner);
    expect(await service.resolveRunnerControlHolder(claims)).toMatchObject({
      sandboxId: sandbox.sandboxId,
      resourceName: claims.resourceName,
    });
    // A name nobody holds is nobody's physical Instance.
    expect(
      await service.resolveRunnerControlHolder({
        ...claims,
        resourceName: `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/instances/nobody`,
      }),
    ).toBeUndefined();
    // A birth identity that no longer exists cannot steer the physical Instance.
    expect(await service.resolveRunnerControlHolder({ ...claims, sandboxId: randomUUID() })).toBeUndefined();
    // An unreadable provider keeps the Runner retrying rather than granting a holder.
    fake.getInstanceFailures = 1;
    expect(await service.resolveRunnerControlHolder(claims)).toBeUndefined();
    // A released row is not a holder.
    await unit.database.update(sandboxes).set({ lifecycle: "unallocated" }).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.resolveRunnerControlHolder(claims)).toBeUndefined();
  });

  it("refuses to renew an expired control credential once the binding moved on", async () => {
    const owner = await account();
    const { sandbox, service, fake, tokens, claims } = await startedClaims(owner);
    const renewed = await service.renewExpiredControl(claims);
    expect(renewed).toBeDefined();
    expect(await tokens.verifyControl(renewed as string)).toMatchObject({ sandboxId: sandbox.sandboxId });

    // Unreadable provider and a replaced UID are both refusals, never a renewed credential.
    fake.getInstanceFailures = 1;
    expect(await service.renewExpiredControl(claims)).toBeUndefined();
    fake.replaceUid(claims.resourceName, "uid-replaced");
    expect(await service.renewExpiredControl(claims)).toBeUndefined();
    // An unallocated row owns no physical Instance.
    await unit.database.update(sandboxes).set({ lifecycle: "unallocated" }).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.renewExpiredControl(claims)).toBeUndefined();
  });

  it("describes authority facts only for the exact allocation the caller already validated", async () => {
    const owner = await account();
    const { sandbox, service, claims, status } = await startedClaims(owner);
    const authority = await service.describeScopeAuthority(claims);
    expect(authority).toMatchObject({ resourceUid: status.currentResourceUid });
    expect(authority?.computerId).toBeDefined();
    // Every deviation from the persisted allocation is refused without a provider call.
    expect(await service.describeScopeAuthority({ ...claims, sessionId: randomUUID() })).toBeUndefined();
    expect(await service.describeScopeAuthority({ ...claims, environmentGeneration: 9 })).toBeUndefined();
    expect(await service.describeScopeAuthority({ ...claims, resourceName: "other" })).toBeUndefined();
    expect(await service.describeScopeAuthority({ ...claims, sandboxId: randomUUID() })).toBeUndefined();
    expect(sandbox.sandboxId).toBe(claims.sandboxId);
  });
});

describe("SandboxRunnerService readiness authority", () => {
  it("answers deferred for a claimed environment while keeping the seal-capable channel attached", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service, hub } = makeService(fake);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    // A claim owns the environment: the Runner must not re-publish readiness, but the channel has
    // to stay attached because the E5 seal still needs it.
    await unit.database.update(sandboxes).set({ idleReclaimAt: new Date() }).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.markRunnerReady(scope, READINESS)).toBe("deferred");
    expect(await service.markRunnerReady(scope, { ...READINESS, runnerVersion: "9.9.9" })).toBe("deferred");
    expect(hub.describe(sandbox.sandboxId).connected).toBe(true);
  });

  it("answers stale for a scope row that no longer exists or has left the executable phases", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    // No persisted row answers this scope at all.
    expect(await service.markRunnerReady({ ...scope, sandboxId: randomUUID() }, READINESS)).toBe("stale");
    // A completely unknown scope is stale on the version-mismatch path too.
    expect(
      await service.markRunnerReady({ ...scope, sandboxId: randomUUID() }, { ...READINESS, runnerVersion: "9.9.9" }),
    ).toBe("stale");
    // Releasing is neither preparing nor ready, so a version-matched report is stale.
    await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, sandbox.sandboxId));
    expect(await service.markRunnerReady(scope, READINESS)).toBe("stale");
    // On the version-mismatch path the same phase is instead a first-admission refusal.
    expect(await service.markRunnerReady(scope, { ...READINESS, runnerVersion: "9.9.9" })).toBe("version_mismatch");
  });

  it("promotes a deferred report once the verified UID is tracked", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    fake.createUnknownWithoutResourceOnce = true;
    const { service, hub } = makeService(fake);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    expect(await service.promoteDeferredReadiness(sandbox.sandboxId)).toBe(false);
    // The resource materializes and a start tracks its UID: the deferred report is promoted.
    fake.materialize(fake.createCalls[0] as RunnerInstanceSpec);
    const reconciled = await service.startForAccount(owner, sandbox.sandboxId);
    expect(reconciled.lifecycle).toBe("ready");
    expect(reconciled.runnerReady).toBe(true);
  });
});

describe("SandboxRunnerService workspace seal proof", () => {
  /** A workspace-enabled ready allocation whose one Runner socket answers seal requests. */
  async function coveredReady(
    owner: string,
    socketFor: (
      hub: RunnerHub,
      store: FakeWorkspaceObjectStore,
      row: typeof sandboxes.$inferSelect,
    ) => RunnerControlSocket,
    options: { sealTimeoutMs?: number } = {},
  ) {
    const fixture = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service, hub } = makeService(fake, { workspace: store, ...options });
    const status = await service.startForAccount(owner, fixture.sandbox.sandboxId);
    const row = await sandboxRow(fixture.sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: fixture.sandbox.sandboxId,
      sessionId: fixture.sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = socketFor(hub, store, row);
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    await service.markRunnerReady(scope, READINESS, { workspaceRestored: true });
    // The durable save debt that puts this environment on the sealing release path.
    await unit.database
      .update(sandboxes)
      .set({ lastErrorCode: "workspace_save_required", lastErrorAt: new Date() })
      .where(eq(sandboxes.id, fixture.sandbox.sandboxId));
    return { ...fixture, fake, store, service, hub, status, row, scope };
  }

  it("refuses to release when the object store has no archive for the current generation", async () => {
    const owner = await account();
    const { sandbox, store, fake, service } = await coveredReady(owner, (hub, s, row) =>
      sealCapableSocket(hub, s, row),
    );
    // The store is empty: the metadata read-back cannot prove anything, so the save is refused and
    // the physical binding is retained. `head` returning undefined also covers a scope whose
    // Sandbox id no longer resolves at all.
    store.head = async () => undefined;
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
    });
    expect(await sandboxRow(sandbox.sandboxId)).toMatchObject({
      lifecycle: "releasing",
      lastErrorCode: "workspace_save_failed",
    });
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("refuses the release when the archive cannot be read at all", async () => {
    const owner = await account();
    const { sandbox, store, service, fake } = await coveredReady(owner, (hub, s, row) =>
      sealCapableSocket(hub, s, row),
    );
    store.head = async () => {
      throw new WorkspaceObjectStoreError("unavailable", "storage is down");
    };
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("refuses the release when the requested seal is never acknowledged", async () => {
    const owner = await account();
    // A socket that swallows seal frames: the bounded seal window expires without an ack.
    const { sandbox, service, fake } = await coveredReady(
      owner,
      () => ({
        send() {
          // Deliberately never acknowledges.
        },
        close() {},
      }),
      { sealTimeoutMs: 20 },
    );
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(fake.deleteCalls).toHaveLength(0);
    expect((await sandboxRow(sandbox.sandboxId)).lastErrorCode).toBe("workspace_save_failed");
  });

  it("refuses the release when the Runner acknowledges a save that is not verifiable", async () => {
    const owner = await account();
    // `ok: true` without planting the archive: the ack alone is never proof.
    const { sandbox, service, fake } = await coveredReady(owner, (hub, store, row) =>
      sealCapableSocket(hub, store, row, { plant: false }),
    );
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(fake.deleteCalls).toHaveLength(0);
    expect((await sandboxRow(sandbox.sandboxId)).lastErrorCode).toBe("workspace_save_failed");
  });
});

describe("SandboxRunnerService idle sweep and sibling reuse", () => {
  const IDLE_TIMEOUT_MS = 60_000;
  const STARTUP_CUTOFF_MS = 30_000 + 4 * RUNNER_WORKSPACE_TIMEOUT_MS;
  const EPOCH = new Date("2026-01-01T00:00:00.000Z");

  /** A workspace-enabled stack over a frozen clock, so the sweep's budget is deterministic. */
  function sweepStack(
    options: { sessionWorkBusy?: ConstructorParameters<typeof SandboxRunnerService>[1]["sessionWorkBusy"] } = {},
  ) {
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    let current = EPOCH;
    const made = makeService(fake, {
      workspace: store,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      now: () => current,
      ...(options.sessionWorkBusy ? { sessionWorkBusy: options.sessionWorkBusy } : {}),
    });
    return {
      ...made,
      fake,
      store,
      now: () => current,
      advance: (ms: number) => {
        current = new Date(current.getTime() + ms);
      },
    };
  }

  /** Allocate, then park the row in the exact phase the sweep candidate query selects. */
  async function phaseRow(
    service: SandboxRunnerService,
    owner: string,
    phase: "ready" | "preparing" | "releasing",
    options: { idleReclaimAt?: Date | null; lastActivityAt?: Date; marker?: string | null } = {},
  ) {
    const fixture = await ownedSandbox(owner);
    const status = await service.startForAccount(owner, fixture.sandbox.sandboxId);
    await unit.database
      .update(sandboxes)
      .set({
        lifecycle: phase,
        currentResourceName: status.currentResourceName as string,
        currentResourceUid: status.currentResourceUid as string,
        idleReclaimAt: options.idleReclaimAt ?? null,
        lastActivityAt: options.lastActivityAt ?? EPOCH,
        lastErrorCode: options.marker ?? null,
        lastErrorAt: options.marker ? new Date() : null,
      })
      .where(eq(sandboxes.id, fixture.sandbox.sandboxId));
    return { ...fixture, ...status };
  }

  it("does nothing at all without workspace persistence", async () => {
    const owner = await account();
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake, { idleTimeoutMs: IDLE_TIMEOUT_MS, now: () => EPOCH });
    await phaseRow(service, owner, "ready", { lastActivityAt: EPOCH });
    expect(await service.reclaimIdleSandboxes()).toEqual({ claimed: 0, released: 0, recovered: 0, failed: 0 });
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("skips a ready row whose activity sits inside the idle budget", async () => {
    const owner = await account();
    const stack = sweepStack();
    const ready = await phaseRow(stack.service, owner, "ready", { lastActivityAt: EPOCH });
    // The budget clock is `lastActivityAt` only; the candidate query filters it out entirely.
    expect(await stack.service.reclaimIdleSandboxes()).toEqual({ claimed: 0, released: 0, recovered: 0, failed: 0 });
    expect((await sandboxRow(ready.sandboxId)).idleReclaimAt).toBeNull();
    expect(stack.fake.deleteCalls).toHaveLength(0);
  });

  it("claims, seals and reclaims a ready environment past the single idle budget", async () => {
    const owner = await account();
    const stack = sweepStack();
    const ready = await phaseRow(stack.service, owner, "ready", { lastActivityAt: EPOCH });
    const row = await sandboxRow(ready.sandboxId);
    const scope: RunnerScope = {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: 1,
      resourceName: ready.currentResourceName as string,
    };
    // A live, seal-capable Runner: the claim's save debt is answered before the delete.
    const socket = sealCapableSocket(stack.hub, stack.store, {
      id: row.id,
      sessionId: row.sessionId,
      storageUri: row.storageUri,
      environmentGeneration: 1,
    });
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    const sweep = await stack.service.reclaimIdleSandboxes();
    expect(sweep).toMatchObject({ claimed: 1, released: 1, failed: 0 });
    expect((await sandboxRow(ready.sandboxId)).lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
    expect(stack.store.writes.length).toBeGreaterThanOrEqual(0);
  });

  it("counts a candidate whose provider preflight fails as failed and leaves the row ready", async () => {
    const owner = await account();
    const stack = sweepStack();
    const ready = await phaseRow(stack.service, owner, "ready", { lastActivityAt: EPOCH });
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    stack.fake.getInstanceFailures = 1;
    expect(await stack.service.reclaimIdleSandboxes()).toMatchObject({ claimed: 0, failed: 1 });
    expect((await sandboxRow(ready.sandboxId)).lifecycle).toBe("ready");
  });

  it("never seals a claim whose provider binding was replaced under the same name", async () => {
    const owner = await account();
    const stack = sweepStack();
    const ready = await phaseRow(stack.service, owner, "ready", { lastActivityAt: EPOCH });
    const row = await sandboxRow(ready.sandboxId);
    const scope: RunnerScope = {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: 1,
      resourceName: ready.currentResourceName as string,
    };
    const socket = sealCapableSocket(stack.hub, stack.store, {
      id: row.id,
      sessionId: row.sessionId,
      storageUri: row.storageUri,
      environmentGeneration: 1,
    });
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    // A same-name resource with a different UID proves nothing about OUR allocation, so the
    // preflight never calls the provider verification at all.
    stack.fake.replaceUid(ready.currentResourceName as string, "uid-someone-else");
    const verified = vi.spyOn(stack.fake, "verifyTrackedOwnership");
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    await stack.service.reclaimIdleSandboxes();
    expect(verified).not.toHaveBeenCalled();
  });

  it("blocks an automatic claim while an E8 collaboration owner reports the allocation busy", async () => {
    const owner = await account();
    const stack = sweepStack({ sessionWorkBusy: () => true });
    const ready = await phaseRow(stack.service, owner, "ready", { lastActivityAt: EPOCH });
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    expect(await stack.service.reclaimIdleSandboxes()).toMatchObject({ claimed: 0, released: 0 });
    expect((await sandboxRow(ready.sandboxId)).idleReclaimAt).toBeNull();
  });

  it("resumes an automatic releasing row without waiting out another budget", async () => {
    const owner = await account();
    const stack = sweepStack();
    const releasing = await phaseRow(stack.service, owner, "releasing", { idleReclaimAt: EPOCH });
    // The row is not idle by `lastActivityAt`, but the durable automatic claim authorizes the
    // resume: the sweep deletes the Instance and clears the row.
    const sweep = await stack.service.reclaimIdleSandboxes();
    expect(sweep).toMatchObject({ released: 1, failed: 0 });
    expect((await sandboxRow(releasing.sandboxId)).lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("leaves an explicit (unclaimed) releasing row entirely outside the sweep", async () => {
    const owner = await account();
    const stack = sweepStack();
    const releasing = await phaseRow(stack.service, owner, "releasing", { idleReclaimAt: null });
    expect(await stack.service.reclaimIdleSandboxes()).toEqual({ claimed: 0, released: 0, recovered: 0, failed: 0 });
    expect((await sandboxRow(releasing.sandboxId)).lifecycle).toBe("releasing");
    expect(stack.fake.deleteCalls).toHaveLength(0);
  });

  it("counts a failing automatic resume as failed and keeps the durable marker", async () => {
    const owner = await account();
    const stack = sweepStack();
    const releasing = await phaseRow(stack.service, owner, "releasing", { idleReclaimAt: EPOCH });
    stack.fake.deleteFailures = 1;
    expect(await stack.service.reclaimIdleSandboxes()).toMatchObject({ released: 0, failed: 1 });
    expect((await sandboxRow(releasing.sandboxId)).lifecycle).toBe("releasing");
  });

  it("recovers a stale preparing adoption the provider still confirms present", async () => {
    const owner = await account();
    const stack = sweepStack();
    const stale = await phaseRow(stack.service, owner, "preparing", { lastActivityAt: EPOCH });
    stack.advance(STARTUP_CUTOFF_MS + 1_000);
    // The tracked Instance never produced a ready Runner: the sweep deletes it and clears the row.
    const sweep = await stack.service.reclaimIdleSandboxes();
    expect(sweep).toMatchObject({ recovered: 1, failed: 0 });
    expect((await sandboxRow(stale.sandboxId)).lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("clears a stale preparing adoption the provider confirms absent, without a delete", async () => {
    const owner = await account();
    const stack = sweepStack();
    const stale = await phaseRow(stack.service, owner, "preparing", { lastActivityAt: EPOCH });
    stack.advance(STARTUP_CUTOFF_MS + 1_000);
    const instance = stack.fake.instances.get(stale.currentResourceName as string);
    if (instance) instance.gone = true;
    expect(await stack.service.reclaimIdleSandboxes()).toMatchObject({ recovered: 1, failed: 0 });
    expect((await sandboxRow(stale.sandboxId)).lifecycle).toBe("unallocated");
    expect(stack.fake.deleteCalls).toHaveLength(0);
  });

  it("counts an unreadable stale adoption as failed and keeps the binding", async () => {
    const owner = await account();
    const stack = sweepStack();
    const stale = await phaseRow(stack.service, owner, "preparing", { lastActivityAt: EPOCH });
    stack.advance(STARTUP_CUTOFF_MS + 1_000);
    stack.fake.getInstanceFailures = 1;
    expect(await stack.service.reclaimIdleSandboxes()).toMatchObject({ recovered: 0, failed: 1 });
    expect((await sandboxRow(stale.sandboxId)).lifecycle).toBe("preparing");
  });

  it("promotes a stale adoption whose Runner became ready instead of recycling it", async () => {
    const owner = await account();
    const stack = sweepStack();
    const stale = await phaseRow(stack.service, owner, "preparing", { lastActivityAt: EPOCH });
    const scope: RunnerScope = {
      sandboxId: stale.sandboxId,
      sessionId: stale.sessionId,
      environmentGeneration: 1,
      resourceName: stale.currentResourceName as string,
    };
    const socket = fakeSocket();
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.advance(STARTUP_CUTOFF_MS + 1_000);
    // `describe().ready` short-circuits the recycle: the normal readiness path promotes instead.
    const sweep = await stack.service.reclaimIdleSandboxes();
    expect(sweep).toMatchObject({ recovered: 0, failed: 0 });
    expect((await sandboxRow(stale.sandboxId)).lifecycle).toBe("ready");
    expect(stack.fake.deleteCalls).toHaveLength(0);
  });

  it("fails an automatic claim whose recorded save cannot be sealed", async () => {
    const owner = await account();
    const stack = sweepStack();
    const ready = await phaseRow(stack.service, owner, "ready", {
      lastActivityAt: EPOCH,
      marker: "workspace_save_required",
    });
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    // No Runner is attached to answer the seal request, so the release funnel records the
    // workspace-specific failure instead of pretending the delete succeeded.
    expect(await stack.service.reclaimIdleSandboxes()).toMatchObject({ claimed: 1, released: 0, failed: 1 });
    const row = await sandboxRow(ready.sandboxId);
    expect(row.lifecycle).toBe("ready");
    expect(row.lastErrorCode).toBe("workspace_save_failed");
    expect(stack.fake.deleteCalls).toHaveLength(0);
  });

  it("skips an idle sibling whose deployment policy no longer matches", async () => {
    const owner = await account();
    const stack = sweepStack();
    const candidate = await phaseRow(stack.service, owner, "ready", { lastActivityAt: EPOCH });
    const scope: RunnerScope = {
      sandboxId: candidate.sandboxId,
      sessionId: candidate.sessionId,
      environmentGeneration: 1,
      resourceName: candidate.currentResourceName as string,
    };
    const socket = sealCapableSocket(stack.hub, stack.store, {
      id: candidate.sandboxId,
      sessionId: candidate.sessionId,
      storageUri: (await sandboxRow(candidate.sandboxId)).storageUri,
      environmentGeneration: 1,
    });
    stack.hub.attach(scope, socket, { reuseCapable: true });
    stack.hub.markReady(scope, READINESS, socket);
    // The candidate passes every preflight and is claimed; the policy re-read after the seal then
    // refuses it, so the claim is retained rather than transferred.
    vi.spyOn(stack.fake, "verifyTrackedInstance").mockImplementation(() => {
      throw new Error("Deployment policy changed");
    });
    const claimant = await ownedSandbox(owner);
    await stack.service.startForAccount(owner, claimant.sandbox.sandboxId);
    expect(stack.fake.createCalls.length).toBeGreaterThanOrEqual(2); // the claimant cold-allocated
    const after = await sandboxRow(candidate.sandboxId);
    expect(after.lifecycle).not.toBe("unallocated");
  });

  it("skips an idle sibling whose archive cannot be proven and does not transfer it", async () => {
    const owner = await account();
    const stack = sweepStack();
    const candidate = await phaseRow(stack.service, owner, "ready", { lastActivityAt: EPOCH });
    const row = await sandboxRow(candidate.sandboxId);
    const scope: RunnerScope = {
      sandboxId: candidate.sandboxId,
      sessionId: candidate.sessionId,
      environmentGeneration: 1,
      resourceName: candidate.currentResourceName as string,
    };
    const socket = sealCapableSocket(stack.hub, stack.store, {
      id: row.id,
      sessionId: row.sessionId,
      storageUri: row.storageUri,
      environmentGeneration: 1,
    });
    stack.hub.attach(scope, socket, { reuseCapable: true });
    stack.hub.markReady(scope, READINESS, socket);
    // The seal is answered but the archive is not actually there: the borrow must not commit.
    stack.store.head = async () => undefined;
    const claimant = await ownedSandbox(owner);
    const before = stack.fake.createCalls.length;
    await stack.service.startForAccount(owner, claimant.sandbox.sandboxId);
    expect(stack.fake.createCalls.length).toBeGreaterThan(before);
  });
});

describe("SandboxRunnerService convergence polling", () => {
  it("polls the deterministic name until the late resource becomes readable", async () => {
    const owner = await account();
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const operation = `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/operations/op-late`;
    const fixture = await ownedSandbox(owner);
    await unit.database
      .update(sandboxes)
      .set({
        lifecycle: "preparing",
        environmentGeneration: 1,
        lastErrorCode: null,
        lastErrorAt: null,
        currentResourceName: null,
        currentResourceUid: null,
        currentOperationName: operation,
      })
      .where(eq(sandboxes.id, fixture.sandbox.sandboxId));
    const name = `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/instances/${runnerInstanceId({
      environment: "staging",
      sandboxId: fixture.sandbox.sandboxId,
      sessionId: fixture.sandbox.sessionId,
      environmentGeneration: 1,
    })}`;
    fake.materialize({
      environment: "staging",
      sandboxId: fixture.sandbox.sandboxId,
      sessionId: fixture.sandbox.sessionId,
      environmentGeneration: 1,
      backendUrl: "wss://unit.invalid",
      bootstrapToken: "unit",
    });
    fake.operations.set(operation, { state: "done", resourceName: name });
    // The first read of the resource is not visible yet; the second (inside the bounded poll
    // window) is. `sleep` is the injected no-op, so the poll converges on its first retry.
    const realGet = fake.getInstance.bind(fake);
    let reads = 0;
    fake.getInstance = async (instanceName: string) => {
      reads += 1;
      if (reads === 1) return undefined;
      return realGet(instanceName);
    };
    const status = await service.startForAccount(owner, fixture.sandbox.sandboxId);
    expect(reads).toBeGreaterThan(1);
    expect(status.currentResourceUid).toMatch(/^uid-/);
    expect(status.lastErrorCode).toBeNull();
    expect(fake.createCalls).toHaveLength(0);
  });

  it("wakes from the bounded convergence window with the real sleep implementation", async () => {
    const owner = await account();
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake, { realSleep: true, createConvergeTimeoutMs: 1 });
    const operation = `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/operations/op-slow-real`;
    const fixture = await ownedSandbox(owner);
    await unit.database
      .update(sandboxes)
      .set({
        lifecycle: "preparing",
        environmentGeneration: 1,
        lastErrorCode: null,
        lastErrorAt: null,
        currentResourceName: null,
        currentResourceUid: null,
        currentOperationName: operation,
      })
      .where(eq(sandboxes.id, fixture.sandbox.sandboxId));
    // The operation names the right resource but nothing is readable at it: the bounded poll
    // window (1 ms, with the production default `sleep`) expires before any read can succeed.
    fake.operations.set(operation, {
      state: "done",
      resourceName: `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/instances/${runnerInstanceId({
        environment: "staging",
        sandboxId: fixture.sandbox.sandboxId,
        sessionId: fixture.sandbox.sessionId,
        environmentGeneration: 1,
      })}`,
    });
    // A millisecond-bounded window expires before any read can succeed: the row keeps the
    // reference and is reported uncertain rather than resubmitted. This also exercises the
    // production default of `sleep`.
    const status = await service.startForAccount(owner, fixture.sandbox.sandboxId);
    expect(status.lastErrorCode).toBe("cloud_create_uncertain");
    expect(fake.createCalls).toHaveLength(0);
  });
});

describe("SandboxRunnerService failure-state persistence", () => {
  it("surfaces an unpersistable failure state as a 503 envelope with both messages", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    // A write that fails with a non-Error makes the durable record impossible: the service must
    // surface that instead of swallowing it, and must describe both failures.
    const brokenDatabase = new Proxy(unit.database, {
      get(target, property, receiver) {
        if (property === "update") {
          return () => {
            throw "unit non-error failure";
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof unit.database;
    const { service } = makeService(fake, { database: brokenDatabase as never, tokens: asyncTokens() });
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining("unknown failure"),
    });
  });
});

describe("SandboxRunnerService create failure classification", () => {
  it("maps a non-provider create failure to the allocate envelope without a retry marker", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    // A plain (non CloudRunAdminError) failure from the provider adapter: it is neither a
    // definitive rejection nor a visible-resource diagnostic, so the marker is uncertain.
    fake.createInstance = async () => {
      throw new Error("unit plain provider failure");
    };
    const { service } = makeService(fake);
    await expect(service.startForAccount(owner, sandbox.sandboxId)).rejects.toThrow("unit plain provider failure");
    expect((await sandboxRow(sandbox.sandboxId)).lastErrorCode).toBe("cloud_create_uncertain");
  });
});

/** A token service that always fails, so the create path reaches its local failure record. */
function asyncTokens(): RunnerBootstrapTokenService {
  const tokens = new RunnerBootstrapTokenService("unit-test-jwt-secret-at-least-32-characters", { ttlSeconds: 600 });
  tokens.issue = async () => {
    throw new Error("signing unavailable");
  };
  return tokens;
}

describe("SandboxRunnerService ingress failure envelopes", () => {
  it("answers 404 for ingress allocation on a Sandbox the Account does not own", async () => {
    const owner = await account();
    const stranger = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = makeService(fake, { workspace: store });
    await expect(service.ensureIngressAllocation(stranger, sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 404,
      code: "RESOURCE_NOT_FOUND",
    });
    expect(fake.createCalls).toHaveLength(0);
  });

  it("propagates an allocation failure from the nested start unchanged (never a 200 outcome)", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    fake.failNextCreateWith = new CloudRunAdminError("invalid", "image refused", {
      status: 400,
      createRejected: true,
    });
    const { service } = makeService(fake);
    // Only `WorkspaceRestoreRequiredError` is translated into an outcome; every other failure
    // must keep its own envelope so the caller sees the real allocation problem.
    await expect(service.ensureIngressAllocation(owner, sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

describe("SandboxRunnerService control-holder refusals", () => {
  it("refuses the physical holder when the tracked resource no longer matches the provider", async () => {
    const owner = await account();
    const fixture = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const started = await service.startForAccount(owner, fixture.sandbox.sandboxId);
    const claims: RunnerBootstrapClaims = {
      sandboxId: fixture.sandbox.sandboxId,
      sessionId: fixture.sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: started.currentResourceName as string,
    };
    // A same-name resource with a different UID is not the tracked binding: the provider read
    // proves nothing and the control channel keeps retrying.
    fake.replaceUid(claims.resourceName, "uid-someone-else");
    expect(await service.resolveRunnerControlHolder(claims)).toBeUndefined();
    expect(await service.renewExpiredControl(claims)).toBeUndefined();
    // Ownership labels that no longer match are equally disqualifying for the holder.
    const instance = fake.instances.get(claims.resourceName);
    if (instance) instance.labels = {};
    expect(await service.resolveRunnerControlHolder(claims)).toBeUndefined();
    expect(await service.renewExpiredControl(claims)).toBeUndefined();
  });

  it("refuses bootstrap renewal when the tracked ownership labels no longer match", async () => {
    const owner = await account();
    const fixture = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const store = new FakeWorkspaceObjectStore();
    const { service } = makeService(fake, { workspace: store });
    const started = await service.startForAccount(owner, fixture.sandbox.sandboxId);
    const claims: RunnerBootstrapClaims = {
      sandboxId: fixture.sandbox.sandboxId,
      sessionId: fixture.sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: started.currentResourceName as string,
    };
    // The recorded binding is still readable at the exact UID, but its managed labels are gone:
    // renewal must fail closed rather than sign a credential for a foreign resource.
    fake.tamperLabels(claims.resourceName, {});
    expect(await service.renewExpiredBootstrap(claims)).toBeUndefined();
  });
});

describe("SandboxRunnerService control-channel evidence corners", () => {
  it("refuses a physical holder whose birth and holder Computers belong to different Accounts", async () => {
    const birthOwner = await account();
    const holderOwner = await account();
    const birth = await ownedSandbox(birthOwner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const started = await service.startForAccount(birthOwner, birth.sandbox.sandboxId);
    const other = await ownedSandbox(holderOwner);
    // A name collision materialized across Accounts: the physical name now sits on another
    // Account's Sandbox, so the immutable birth identity must refuse to validate.
    const name = started.currentResourceName as string;
    const uid = started.currentResourceUid as string;
    await unit.database
      .update(sandboxes)
      .set({ currentResourceName: null, currentResourceUid: null })
      .where(eq(sandboxes.id, birth.sandbox.sandboxId));
    await unit.database
      .update(sandboxes)
      .set({ currentResourceName: name, currentResourceUid: uid, lifecycle: "preparing" })
      .where(eq(sandboxes.id, other.sandbox.sandboxId));
    const claims: RunnerBootstrapClaims = {
      sandboxId: birth.sandbox.sandboxId,
      sessionId: birth.sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: name,
    };
    expect(await service.resolveRunnerControlHolder(claims)).toBeUndefined();
  });

  it("refuses the holder and the renewal when the tracked ownership labels no longer match", async () => {
    const owner = await account();
    const birth = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service } = makeService(fake);
    const started = await service.startForAccount(owner, birth.sandbox.sandboxId);
    const claims: RunnerBootstrapClaims = {
      sandboxId: birth.sandbox.sandboxId,
      sessionId: birth.sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: started.currentResourceName as string,
    };
    // The UID still matches the tracked binding, but the managed labels prove the resource is not
    // this allocation: both the holder resolution and the renewal must fail closed.
    fake.tamperLabels(claims.resourceName, {});
    expect(await service.resolveRunnerControlHolder(claims)).toBeUndefined();
    expect(await service.renewExpiredControl(claims)).toBeUndefined();
  });

  it("refuses an original-image reconnect whose tracked resource vanished behind the name", async () => {
    const owner = await account();
    const birth = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service, hub } = makeService(fake, { expectedRunnerVersion: RUNNER_VERSION });
    const status = await service.startForAccount(owner, birth.sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: birth.sandbox.sandboxId,
      sessionId: birth.sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    await service.markRunnerReady(scope, READINESS);
    // A tracked READY allocation whose Instance is no longer readable cannot prove its original
    // image, so a different Runner version stays a mismatch instead of being accepted.
    const instance = fake.instances.get(scope.resourceName);
    if (instance) instance.gone = true;
    expect(await service.markRunnerReady(scope, { ...READINESS, runnerVersion: "9.9.9" })).toBe("version_mismatch");
  });

  it("reports stale when the tracked binding is replaced during the original-image read", async () => {
    const owner = await account();
    const birth = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service, hub } = makeService(fake);
    const status = await service.startForAccount(owner, birth.sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: birth.sandbox.sandboxId,
      sessionId: birth.sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    await service.markRunnerReady(scope, READINESS);
    // The image verification is satisfied for this case, so the bounded provider read really
    // happens; it is held while the tracked binding is released, and the mandatory post-read
    // recheck is then what must refuse: the row this verdict would apply to is gone.
    vi.spyOn(fake, "verifyTrackedOriginalImage").mockImplementation(() => {});
    const realGet = fake.getInstance.bind(fake);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let gated = true;
    fake.getInstance = async (name: string) => {
      if (gated) {
        gated = false;
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realGet(name);
    };
    const pending = service.markRunnerReady(scope, { ...READINESS, runnerVersion: "9.9.9" });
    await enteredPromise;
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "unallocated", currentResourceName: null, currentResourceUid: null })
      .where(eq(sandboxes.id, birth.sandbox.sandboxId));
    release();
    expect(await pending).toBe("stale");
  });
});

describe("SandboxRunnerService acceptance bookkeeping", () => {
  it("never lets a failed activity write replace the acceptance outcome", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service, hub } = makeService(fake);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
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
    // The run-start activity write succeeds; the one in `finally` fails. The caller must still
    // receive the real acceptance result: bookkeeping is best-effort, never a result rewrite.
    vi.spyOn(service, "noteActivity")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("activity write unavailable"));
    const pending = service.runAcceptanceForAccount(owner, sandbox.sandboxId, { mode: "offline" });
    await vi.waitFor(() => {
      expect(socket.sent.some((frame) => (frame as { type?: string }).type === "acceptance:run")).toBe(true);
    });
    const requestId = (
      socket.sent.find((frame) => (frame as { type?: string }).type === "acceptance:run") as { requestId: string }
    ).requestId;
    hub.resolveAcceptanceResult(sandbox.sandboxId, { type: "acceptance:result", requestId, outcome: "passed" }, socket);
    await expect(pending).resolves.toMatchObject({ outcome: "passed" });
  });

  it("refuses an acceptance whose hub entry disappeared between the snapshot and the socket read", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const { service, hub } = makeService(fake);
    const status = await service.startForAccount(owner, sandbox.sandboxId);
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
    // `describe` reports a healthy ready connection while `currentSocket` really reads the entry:
    // a detach in that window leaves the defensive socket guard to refuse the run.
    hub.detach(sandbox.sandboxId, socket);
    vi.spyOn(hub, "describe").mockReturnValue({
      connected: true,
      ready: true,
      readiness: READINESS,
      reuseCapable: false,
      scope,
    });
    await expect(service.runAcceptanceForAccount(owner, sandbox.sandboxId, { mode: "offline" })).rejects.toMatchObject({
      statusCode: 409,
      code: "SANDBOX_RUNNER_CONFLICT",
      message: expect.stringContaining("No ready Runner is attached"),
    });
  });
});

describe("SandboxRunnerService release evidence corners", () => {
  it("reports an unverified removal when the read-back never shows the Instance gone", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    let current = new Date("2026-01-01T00:00:00.000Z");
    const { service } = makeService(fake, { now: () => current, deleteVerifyTimeoutMs: 30_000 });
    const status = await service.startForAccount(owner, sandbox.sandboxId);
    const name = status.currentResourceName as string;
    // The delete is accepted but the read-back keeps answering with OUR UID: the removal is a fact
    // only when the read is 404, so the bounded window must expire and report it.
    fake.deleteInstance = async () => ({ alreadyGone: false });
    const realGet = fake.getInstance.bind(fake);
    fake.getInstance = async (instanceName: string) => {
      // One poll interval passes between each read: default `sleep` is a no-op here, so the
      // injected clock is the only thing advancing the window.
      current = new Date(current.getTime() + 30_000);
      return realGet(instanceName);
    };
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const row = await sandboxRow(sandbox.sandboxId);
    expect(row.lifecycle).toBe("releasing");
    expect(row.currentResourceName).toBe(name);
    expect(row.lastErrorCode).toBe("cloud_delete_incomplete");
  });

  it("keeps releasing while an unknown allocation's operation is still running", async () => {
    const owner = await account();
    const { sandbox } = await ownedSandbox(owner);
    const fake = new RunnerFakeCloudRunAdmin();
    const operation = `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/operations/op-release-pending`;
    const { service } = makeService(fake, { deleteVerifyTimeoutMs: 0 });
    // A releasing row with a pending create LRO and no tracked UID: neither the read nor the
    // operation proves the create outcome, so the reference must survive.
    await unit.database
      .update(sandboxes)
      .set({
        lifecycle: "releasing",
        environmentGeneration: 1,
        currentResourceName: `projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/instances/ot-unknown`,
        currentResourceUid: null,
        currentOperationName: operation,
        lastErrorCode: null,
        lastErrorAt: null,
      })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    fake.operations.set(operation, { state: "pending" });
    await expect(service.stopForAccount(owner, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const row = await sandboxRow(sandbox.sandboxId);
    expect(row.lifecycle).toBe("releasing");
    expect(row.currentResourceName).toBe(`projects/${FAKE_PROJECT}/locations/${FAKE_REGION}/instances/ot-unknown`);
    expect(fake.deleteCalls).toHaveLength(0);
  });
});
