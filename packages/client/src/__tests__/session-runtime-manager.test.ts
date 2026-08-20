import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  computeRuntimeSnapshotHashes,
  type EffectiveRuntimeSnapshot,
  type SessionReconcileRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAbortRequest,
  AgentInteractionResponse,
  AgentPromptRequest,
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeBinding,
  AgentRuntimeEventSink,
  AgentRuntimeFactory,
  AgentSteerRequest,
  CreateAgentRuntimeRequest,
  ResumeAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import { codexRuntimePolicy, validateCodexRuntimePolicy } from "../providers/codex/runtime-policy.js";
import { AgentRuntimeProviderRegistry } from "../runtime/agent-runtime-provider-registry.js";
import { AgentWorkspaceManager } from "../runtime/agent-workspace.js";
import { RuntimeToolHost } from "../runtime/runtime-tool-host.js";
import { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";
import { SessionRuntimeManager } from "../runtime/session-runtime-manager.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

describe("SessionRuntimeManager", () => {
  it("durably creates, reuses, upgrades, resumes, and stops Session-scoped runtimes", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const toolHost = new RuntimeToolHost(connection());
    const factory = new FakeFactory();
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      toolHost,
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    const first = reconcile(computerId, snapshot(1));

    await expect(reconciler.reconcile(first)).resolves.toMatchObject({ status: "ready" });
    expect(factory.created).toHaveLength(1);
    expect((await store.read("agent-1", "session-1"))?.runtimeBinding).toEqual(binding("thread-1"));
    await expect(
      manager.prepareSession(first, computeRuntimeSnapshotHashes(first.runtime as never)),
    ).resolves.toBeDefined();
    const observed: string[] = [];
    const releaseObserver = manager.observe("session-1", (event) => {
      observed.push(event.type);
    });
    expect(() => manager.observe("session-1", () => undefined)).toThrow("active observer");
    await factory.runtimes[0]?.emit({ type: "provider_warning", runId: "run", code: "warning", message: "warn" });
    expect(observed).toEqual(["provider_warning"]);
    releaseObserver();
    releaseObserver();
    await expect(reconciler.reconcile({ ...first, requestId: randomUUID() })).resolves.toMatchObject({
      status: "ready",
    });
    expect(factory.created).toHaveLength(1);

    const upgraded = reconcile(computerId, snapshot(2));
    await expect(reconciler.reconcile(upgraded)).resolves.toMatchObject({ status: "ready" });
    expect(factory.created).toHaveLength(2);
    expect(factory.runtimes[0]?.closed).toBe(true);
    expect((await store.read("agent-1", "session-1"))?.runtimeBinding).toEqual(binding("thread-2"));

    await manager.close();
    const restartedFactory = new FakeFactory();
    const restartedManager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(restartedFactory),
      toolHost,
      workspace,
    });
    const restarted = new SessionReconciler({
      computerId,
      preparation: restartedManager,
      localPolicy: restartedManager,
    });
    await expect(restarted.reconcile({ ...upgraded, requestId: randomUUID() })).resolves.toMatchObject({
      status: "ready",
    });
    expect(restartedFactory.resumed).toEqual([binding("thread-2")]);

    await expect(
      restarted.reconcile({ ...upgraded, requestId: randomUUID(), desired: "stopped", runtime: undefined }),
    ).resolves.toMatchObject({ status: "stopped" });
    expect(restartedFactory.runtimes[0]?.closed).toBe(true);
    toolHost.close();
  });

  it("fails closed for unregistered providers and unsupported execution policy", async () => {
    const manager = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(),
      toolHost: {} as RuntimeToolHost,
      workspace: {} as AgentWorkspaceManager,
    });
    expect(manager.validate(snapshot(1))).toBe("configuration_unsupported");
    const factory = new FakeFactory() as AgentRuntimeFactory;
    const providerUnavailable = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(factory, false),
      toolHost: {} as RuntimeToolHost,
      workspace: {} as AgentWorkspaceManager,
    });
    expect(providerUnavailable.validate(snapshot(1))).toBe("provider_unavailable");
    const registered = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(factory),
      toolHost: {} as RuntimeToolHost,
      workspace: {} as AgentWorkspaceManager,
    });
    expect(registered.validate({ ...snapshot(1), execution: { approvalPolicy: "never", networkAccess: true } })).toBe(
      "configuration_unsupported",
    );
    expect(registered.validate({ ...snapshot(1), allowedTools: ["unknown"] })).toBe("configuration_unsupported");
    expect(() => registered.runtime("missing")).toThrow("not ready");
    expect(() => registered.cwd("missing")).toThrow("not ready");
    expect(() => registered.observe("missing", () => undefined)).toThrow("not ready");
    const stopSession = vi.fn(async () => undefined);
    const stoppable = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(factory),
      toolHost: {} as RuntimeToolHost,
      workspace: { stopSession } as unknown as AgentWorkspaceManager,
    });
    await expect(stoppable.stopSession("missing", 1)).resolves.toBeUndefined();
    expect(stopSession).toHaveBeenCalledWith("missing", 1);
  });

  it("closes a runtime that cannot produce a durable binding", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-failure-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const toolHost = new RuntimeToolHost(connection());
    const factory = new FakeFactory(true);
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      toolHost,
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await expect(reconciler.reconcile(reconcile(computerId, snapshot(1)))).rejects.toThrow("durable binding");
    expect(factory.runtimes[0]?.closed).toBe(true);
    toolHost.close();
  });

  it("preserves both creation and cleanup failures before manager shutdown", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-double-failure-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const toolHost = new RuntimeToolHost(connection());
    const factory = new FakeFactory(true, undefined, undefined, undefined, new Error("cleanup failed"));
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      toolHost,
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });

    await expect(reconciler.reconcile(reconcile(computerId, snapshot(1)))).rejects.toThrow(
      "creation and cleanup both failed",
    );
    expect(factory.runtimes[0]?.closeCalls).toBe(1);
    toolHost.close();
  });

  it("returns one joinable close operation while Provider shutdown is in flight", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-close-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const toolHost = new RuntimeToolHost(connection());
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolveClose) => {
      releaseClose = resolveClose;
    });
    const factory = new FakeFactory(false, closeGate);
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      toolHost,
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await reconciler.reconcile(reconcile(computerId, snapshot(1)));

    const first = manager.close();
    const second = manager.close();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(factory.runtimes[0]?.closeCalls).toBe(1));
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseClose();
    await Promise.all([first, second]);
    expect(factory.runtimes[0]?.closeCalls).toBe(1);
    toolHost.close();
  });

  it("waits for in-flight preparation and closes a late Provider runtime exactly once", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-prepare-close-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const toolHost = new RuntimeToolHost(connection());
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolveCreate) => {
      releaseCreate = resolveCreate;
    });
    let createStarted!: () => void;
    const createStart = new Promise<void>((resolveStarted) => {
      createStarted = resolveStarted;
    });
    const factory = new FakeFactory(false, undefined, createGate, createStarted);
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      toolHost,
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    const request = reconcile(computerId, snapshot(1));
    const preparing = reconciler.reconcile(request);
    await createStart;

    const closing = manager.close();
    let settled = false;
    void closing.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(factory.runtimes[0]?.closeCalls).toBe(0);

    releaseCreate();
    await expect(preparing).rejects.toThrow("manager is closing");
    await expect(closing).resolves.toBeUndefined();
    expect(factory.runtimes[0]?.closeCalls).toBe(1);
    expect(factory.runtimes[0]?.closed).toBe(true);
    expect(() => manager.runtime("session-1")).toThrow("manager is closing");
    expect(() => manager.prepareSession(request, computeRuntimeSnapshotHashes(request.runtime as never))).toThrow(
      "manager is closing",
    );
    toolHost.close();
  });

  it("surfaces failure while closing a runtime created after shutdown starts", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-late-close-failure-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const toolHost = new RuntimeToolHost(connection());
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolveCreate) => {
      releaseCreate = resolveCreate;
    });
    let createStarted!: () => void;
    const createStart = new Promise<void>((resolveStarted) => {
      createStarted = resolveStarted;
    });
    const factory = new FakeFactory(false, undefined, createGate, createStarted, new Error("late close failed"));
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      toolHost,
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    const preparing = reconciler.reconcile(reconcile(computerId, snapshot(1)));
    await createStart;

    const closing = manager.close();
    releaseCreate();
    await expect(preparing).rejects.toThrow("manager is closing");
    await expect(closing).rejects.toThrow("failed to close");
    expect(factory.runtimes[0]?.closeCalls).toBe(1);
    toolHost.close();
  });

  it("does not publish ready after shutdown starts during final binding persistence", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-binding-close-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const toolHost = new RuntimeToolHost(connection());
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolvePersist) => {
      releasePersist = resolvePersist;
    });
    let persistStarted!: () => void;
    const persistStart = new Promise<void>((resolveStarted) => {
      persistStarted = resolveStarted;
    });
    let saveCalls = 0;
    const bindingStore = {
      saveRuntimeBinding: async (...args: Parameters<SessionBindingStore["saveRuntimeBinding"]>) => {
        const binding = await store.saveRuntimeBinding(...args);
        saveCalls += 1;
        if (saveCalls === 2) {
          persistStarted();
          await persistGate;
        }
        return binding;
      },
    } as SessionBindingStore;
    const factory = new FakeFactory(false, undefined, undefined, undefined, new Error("cleanup failed"));
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore,
      providers: await providerRegistry(factory),
      toolHost,
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    const preparing = reconciler.reconcile(reconcile(computerId, snapshot(1)));
    await persistStart;

    const closing = manager.close();
    let closeSettled = false;
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releasePersist();

    await expect(preparing).rejects.toThrow("manager is closing");
    await expect(closing).rejects.toThrow("failed to close");
    expect(factory.runtimes[0]?.closeCalls).toBe(1);
    expect(() => manager.runtime("session-1")).toThrow("manager is closing");
    toolHost.close();
  });

  it("surfaces an upgrade close failure that races manager shutdown", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-upgrade-close-failure-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const toolHost = new RuntimeToolHost(connection());
    let rejectClose!: (error: Error) => void;
    const closeGate = new Promise<void>((_resolveClose, reject) => {
      rejectClose = reject;
    });
    const factory = new FakeFactory(false, closeGate);
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      toolHost,
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await reconciler.reconcile(reconcile(computerId, snapshot(1)));

    const upgrading = reconciler.reconcile(reconcile(computerId, snapshot(2)));
    await vi.waitFor(() => expect(factory.runtimes[0]?.closeCalls).toBe(1));
    const closing = manager.close();
    rejectClose(new Error("upgrade close failed"));

    await expect(upgrading).rejects.toThrow("upgrade close failed");
    await expect(closing).rejects.toThrow("failed to close");
    toolHost.close();
  });

  it("aggregates failures while closing registered Provider runtimes", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-close-failure-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const toolHost = new RuntimeToolHost(connection());
    const factory = new FakeFactory(false, undefined, undefined, undefined, new Error("close failed"));
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      toolHost,
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await reconciler.reconcile(reconcile(computerId, snapshot(1)));

    await expect(manager.close()).rejects.toThrow("failed to close");
    expect(factory.runtimes[0]?.closeCalls).toBe(1);
    toolHost.close();
  });

  it("fences unresolved custody and fails closed when direct preparation loses authority", async () => {
    const prepared = { binding: { runtimeBinding: undefined } as never };
    const request = reconcile(randomUUID(), snapshot(1));
    const hashes = computeRuntimeSnapshotHashes(request.runtime as never);
    const unresolved = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(),
      toolHost: {} as RuntimeToolHost,
      workspace: {
        prepareSession: async () => ({
          ...prepared,
          unresolvedTurn: {
            requestId: "request",
            deliveryId: "delivery",
            inputHash: "a".repeat(64),
            turnId: "turn",
            phase: "accepted",
          },
        }),
      } as unknown as AgentWorkspaceManager,
    });
    await expect(unresolved.prepareSession({ ...request, runtime: undefined }, hashes)).resolves.toMatchObject({
      unresolvedTurn: { turnId: "turn" },
    });

    const unavailable = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(),
      toolHost: {} as RuntimeToolHost,
      workspace: {
        prepareSession: async () => prepared,
      } as unknown as AgentWorkspaceManager,
    });
    await expect(unavailable.prepareSession({ ...request, runtime: undefined }, hashes)).rejects.toThrow(
      "runtime snapshot",
    );
    await expect(unavailable.prepareSession(request, hashes)).rejects.toThrow("provider is unavailable");

    const factory = new FakeFactory();
    const captured: CreateAgentRuntimeRequest[] = [];
    const policyFactory = {
      manifest: factory.manifest,
      probe: () => factory.probe(),
      create: async (input: CreateAgentRuntimeRequest) => {
        captured.push(input);
        return factory.create(input);
      },
      resume: (input: ResumeAgentRuntimeRequest) => factory.resume(input),
    } satisfies AgentRuntimeFactory;
    const missingBinding = new SessionRuntimeManager({
      bindingStore: {
        saveRuntimeBinding: async () => undefined,
        read: async () => undefined,
      } as unknown as SessionBindingStore,
      providers: await providerRegistry(policyFactory),
      toolHost: {
        hostedTools: () => ({ definitions: [], handler: async () => ({ success: true, content: [] }) }),
      } as unknown as RuntimeToolHost,
      workspace: {
        prepareSession: async () => prepared,
        cwd: async () => "/workspace",
      } as unknown as AgentWorkspaceManager,
    });
    const policySnapshot = {
      ...snapshot(1),
      model: undefined,
      reasoningEffort: "high",
      execution: { approvalPolicy: "never", networkAccess: true },
    } as unknown as EffectiveRuntimeSnapshot;
    await expect(missingBinding.prepareSession({ ...request, runtime: policySnapshot }, hashes)).rejects.toThrow(
      "binding disappeared",
    );
    expect(captured[0]).toMatchObject({
      configuration: { reasoningEffort: "high" },
      policy: { approvals: "never", network: "enabled" },
    });
    expect(factory.runtimes[0]?.closed).toBe(true);
  });
});

async function providerRegistry(factory?: AgentRuntimeFactory, ready = true): Promise<AgentRuntimeProviderRegistry> {
  const providers = new AgentRuntimeProviderRegistry(
    factory
      ? [
          {
            artifactIdentity: "a".repeat(64),
            factory,
            policy: codexRuntimePolicy,
            validate: validateCodexRuntimePolicy,
          },
        ]
      : [],
  );
  if (factory && ready) await providers.refresh(factory.manifest.providerId);
  return providers;
}

class FakeFactory implements AgentRuntimeFactory {
  readonly manifest = {
    providerId: "codex",
    displayName: "Codex",
    contractVersion: 1 as const,
    bindingSchemaVersion: 1,
  };
  readonly created: CreateAgentRuntimeRequest[] = [];
  readonly resumed: AgentRuntimeBinding[] = [];
  readonly runtimes: FakeRuntime[] = [];
  readonly #withoutBinding: boolean;
  readonly #closeGate?: Promise<void>;
  readonly #closeError?: Error;
  readonly #createGate?: Promise<void>;
  readonly #createStarted?: () => void;

  constructor(
    withoutBinding = false,
    closeGate?: Promise<void>,
    createGate?: Promise<void>,
    createStarted?: () => void,
    closeError?: Error,
  ) {
    this.#withoutBinding = withoutBinding;
    this.#closeGate = closeGate;
    this.#createGate = createGate;
    this.#createStarted = createStarted;
    this.#closeError = closeError;
  }

  async probe() {
    return { ready: true, version: "test", issues: [] };
  }

  async create(request: CreateAgentRuntimeRequest): Promise<AgentRuntime> {
    this.created.push(request);
    return this.#open(request, binding(`thread-${this.runtimes.length + 1}`));
  }

  async resume(request: ResumeAgentRuntimeRequest): Promise<AgentRuntime> {
    this.resumed.push(request.binding);
    return this.#open(request, request.binding);
  }

  async #open(request: CreateAgentRuntimeRequest, runtimeBinding: AgentRuntimeBinding): Promise<AgentRuntime> {
    await request.eventSink({ type: "binding_changed", binding: runtimeBinding });
    const runtime = new FakeRuntime(
      this.#withoutBinding ? undefined : runtimeBinding,
      request.eventSink,
      this.#closeGate,
      this.#closeError,
    );
    this.runtimes.push(runtime);
    this.#createStarted?.();
    await this.#createGate;
    return runtime;
  }
}

class FakeRuntime implements AgentRuntime {
  readonly manifest = {
    providerId: "codex",
    displayName: "Codex",
    contractVersion: 1 as const,
    bindingSchemaVersion: 1,
  };
  readonly capabilities = { steer: "unsupported" as const, interactions: "unsupported" as const };
  readonly state: { phase: "idle" | "closed"; queuedRunCount: number } = { phase: "idle", queuedRunCount: 0 };
  readonly binding: AgentRuntimeBinding | undefined;
  readonly #sink: AgentRuntimeEventSink;
  readonly #closeGate?: Promise<void>;
  readonly #closeError?: Error;
  closed = false;
  closeCalls = 0;

  constructor(
    runtimeBinding: AgentRuntimeBinding | undefined,
    sink: AgentRuntimeEventSink,
    closeGate?: Promise<void>,
    closeError?: Error,
  ) {
    this.binding = runtimeBinding;
    this.#sink = sink;
    this.#closeGate = closeGate;
    this.#closeError = closeError;
  }

  async prompt(request: AgentPromptRequest): Promise<AgentRunResult> {
    await this.#sink({ type: "run_started", runId: request.runId });
    return { runId: request.runId, status: "completed", output: [] };
  }

  emit(event: Parameters<AgentRuntimeEventSink>[0]): Promise<void> {
    return Promise.resolve(this.#sink(event));
  }

  followUp(request: AgentPromptRequest): Promise<AgentRunResult> {
    return this.prompt(request);
  }

  async steer(_request: AgentSteerRequest): Promise<void> {}
  async respond(_response: AgentInteractionResponse): Promise<void> {}
  async abort(_request: AgentAbortRequest): Promise<void> {}
  async waitForIdle(): Promise<void> {}

  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.#closeGate;
    if (this.#closeError) throw this.#closeError;
    this.closed = true;
    (this.state as { phase: "idle" | "closed" }).phase = "closed";
  }
}

function connection() {
  return {
    send: async () => undefined,
    subscribeBusinessFrames: () => () => undefined,
  } as never;
}

function binding(threadId: string): AgentRuntimeBinding {
  return { providerId: "codex", schemaVersion: 1, payload: { threadId } };
}

function reconcile(computerId: string, runtime: EffectiveRuntimeSnapshot): SessionReconcileRequest {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready",
    runtime,
  };
}

function snapshot(revision: number): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: revision, id: `agent-revision-${revision}` },
      session: { sequence: revision, id: `session-revision-${revision}` },
    },
    agentId: "agent-1",
    provider: "codex",
    model: `model-${revision}`,
    instructions: { platform: "platform", agent: "agent" },
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}
