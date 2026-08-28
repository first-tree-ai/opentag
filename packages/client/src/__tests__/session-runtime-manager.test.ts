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
import { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";
import {
  SessionRuntimeManager as ProductionSessionRuntimeManager,
  type SessionRuntimeManagerOptions,
} from "../runtime/session-runtime-manager.js";

class SessionRuntimeManager extends ProductionSessionRuntimeManager {
  constructor(options: Omit<SessionRuntimeManagerOptions, "ensureProviderReady">) {
    super({
      ...options,
      ensureProviderReady: (providerId, signal) => options.providers.ensureReady(providerId, signal),
    });
  }
}

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

describe("SessionRuntimeManager", () => {
  it("materializes a runtime-managed proof for internal Sessions without exposing IM credentials", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-internal-runtime-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const factory = new FakeFactory();
    const proofManager = {
      materialize: vi.fn(async () => "/tmp/session-proof.json"),
      cleanup: vi.fn(async () => undefined),
    };
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      cliCommand: "opentag-dev",
      home,
      proofManager,
      providers: await providerRegistry(factory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const computerId = randomUUID();
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    const request = {
      ...reconcile(computerId, snapshot(1)),
      sessionKind: "internal" as const,
      creatorSessionId: randomUUID(),
      sessionCliProof: { proofId: randomUUID(), token: "p".repeat(32) },
    };

    expect(manager.requiresSessionPreparation(request)).toBe(false);
    await expect(reconciler.reconcile(request)).resolves.toMatchObject({ status: "ready" });
    await manager.ensureRuntime(request.sessionId);

    expect(proofManager.materialize).toHaveBeenCalledWith(request.sessionId, request.sessionCliProof);
    expect(factory.created[0]?.workspace.environment).toEqual({
      OPENTAG_HOME: home,
      OPENTAG_SESSION_PROOF_FILE: "/tmp/session-proof.json",
    });
    expect(factory.created[0]?.hostedTools).toBeUndefined();
    expect(factory.created[0]?.systemPrompt).toContain("opentag-dev session send");
    expect(factory.created[0]?.systemPrompt).toContain(request.creatorSessionId);
    expect(manager.requiresSessionPreparation(request)).toBe(false);
    const rotated = {
      ...request,
      requestId: randomUUID(),
      sessionCliProof: { proofId: randomUUID(), token: "q".repeat(32) },
    };
    expect(manager.requiresSessionPreparation(rotated)).toBe(true);
    await expect(reconciler.reconcile(rotated)).resolves.toMatchObject({ status: "ready" });
    expect(manager.requiresSessionPreparation(rotated)).toBe(false);
    expect(proofManager.materialize).toHaveBeenLastCalledWith(rotated.sessionId, rotated.sessionCliProof);
    await manager.close();
  });

  it("fails closed when a reconcile carries a proof but no proof manager is configured", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-missing-proof-manager-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(new FakeFactory()),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const computerId = randomUUID();
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    const request = {
      ...reconcile(computerId, snapshot(1)),
      sessionCliProof: { proofId: randomUUID(), token: "p".repeat(32) },
    };

    await expect(reconciler.reconcile(request)).rejects.toThrow("Session CLI proof manager is unavailable");
    await manager.close();
  });

  it("durably creates, reuses, upgrades, resumes, and stops Session-scoped runtimes", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const factory = new FakeFactory();
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    const first = reconcile(computerId, snapshot(1));

    await expect(reconciler.reconcile(first)).resolves.toMatchObject({ status: "ready" });
    await manager.ensureRuntime("session-1");
    await manager.ensureRuntime("session-1", new AbortController().signal);
    expect(manager.runtime("session-1")).toBe(factory.runtimes[0]);
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
    await factory.runtimes[0]?.emit({ type: "binding_changed", binding: binding("thread-1") });
    expect(observed).toEqual(["provider_warning", "binding_changed"]);
    releaseObserver();
    releaseObserver();
    await expect(reconciler.reconcile({ ...first, requestId: randomUUID() })).resolves.toMatchObject({
      status: "ready",
    });
    expect(factory.created).toHaveLength(1);

    const upgraded = reconcile(computerId, snapshot(2));
    await expect(reconciler.reconcile(upgraded)).resolves.toMatchObject({ status: "ready" });
    await manager.ensureRuntime("session-1");
    expect(factory.created).toHaveLength(2);
    expect(factory.runtimes[0]?.closed).toBe(true);
    expect((await store.read("agent-1", "session-1"))?.runtimeBinding).toEqual(binding("thread-2"));
    await factory.runtimes[1]?.close();
    await manager.prepareSession(upgraded, computeRuntimeSnapshotHashes(upgraded.runtime as never));
    await manager.ensureRuntime("session-1");
    expect(factory.resumed).toEqual([binding("thread-2")]);

    await manager.close();
    const restartedFactory = new FakeFactory();
    const restartedManager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(restartedFactory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
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
    await restartedManager.ensureRuntime("session-1");
    expect(restartedFactory.resumed).toEqual([binding("thread-2")]);

    await expect(
      restarted.reconcile({ ...upgraded, requestId: randomUUID(), desired: "stopped", runtime: undefined }),
    ).resolves.toMatchObject({ status: "stopped" });
    expect(restartedFactory.runtimes[0]?.closed).toBe(true);
  });

  it("validates durable configuration without treating transient readiness as placement policy", async () => {
    const manager = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace: {} as AgentWorkspaceManager,
    });
    expect(manager.validate(snapshot(1))).toBe("configuration_unsupported");
    const factory = new FakeFactory() as AgentRuntimeFactory;
    const providerUnavailable = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(factory, false),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace: {} as AgentWorkspaceManager,
    });
    expect(providerUnavailable.validate(snapshot(1))).toBeUndefined();
    const registered = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(factory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace: {} as AgentWorkspaceManager,
    });
    expect(registered.validate({ ...snapshot(1), execution: { approvalPolicy: "never", networkAccess: false } })).toBe(
      "configuration_unsupported",
    );
    expect(() => registered.runtime("missing")).toThrow("not ready");
    await expect(registered.ensureRuntime("missing")).rejects.toThrow("not been prepared");
    expect(() => registered.cwd("missing")).toThrow("not been prepared");
    expect(() => registered.observe("missing", () => undefined)).toThrow("not ready");
    const stopSession = vi.fn(async () => undefined);
    const cleanupProviderEnvironment = vi.fn(async () => undefined);
    const stoppable = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      cleanupProviderEnvironment,
      providers: await providerRegistry(factory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace: { stopSession } as unknown as AgentWorkspaceManager,
    });
    await expect(stoppable.stopSession("missing", 1)).resolves.toBeUndefined();
    expect(stopSession).toHaveBeenCalledWith("missing", 1);
    expect(cleanupProviderEnvironment).toHaveBeenCalledWith("missing");
  });

  it("closes a runtime that cannot produce a durable binding", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-failure-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const factory = new FakeFactory(true);
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await expect(reconciler.reconcile(reconcile(computerId, snapshot(1)))).resolves.toMatchObject({ status: "ready" });
    await expect(manager.ensureRuntime("session-1")).rejects.toThrow("durable binding");
    expect(factory.runtimes[0]?.closed).toBe(true);
  });

  it("preserves both creation and cleanup failures before manager shutdown", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-double-failure-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const factory = new FakeFactory(true, undefined, undefined, undefined, new Error("cleanup failed"));
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });

    await expect(reconciler.reconcile(reconcile(computerId, snapshot(1)))).resolves.toMatchObject({ status: "ready" });
    await expect(manager.ensureRuntime("session-1")).rejects.toThrow("creation and cleanup both failed");
    expect(factory.runtimes[0]?.closeCalls).toBe(1);
  });

  it("returns one joinable close operation while Provider shutdown is in flight", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-close-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolveClose) => {
      releaseClose = resolveClose;
    });
    const factory = new FakeFactory(false, closeGate);
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await reconciler.reconcile(reconcile(computerId, snapshot(1)));
    await manager.ensureRuntime("session-1");

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
  });

  it("waits for in-flight preparation and closes a late Provider runtime exactly once", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-prepare-close-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
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
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    const request = reconcile(computerId, snapshot(1));
    await reconciler.reconcile(request);
    const starting = manager.ensureRuntime("session-1");
    await createStart;
    const cancelledWaiter = new AbortController();
    const joined = manager.ensureRuntime("session-1", cancelledWaiter.signal);
    await Promise.resolve();
    cancelledWaiter.abort(new Error("stop joined start"));
    await expect(joined).rejects.toThrow("stop joined start");

    const closing = manager.close();
    let settled = false;
    void closing.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(factory.runtimes[0]?.closeCalls).toBe(0);

    releaseCreate();
    await expect(starting).rejects.toThrow("manager is closing");
    await expect(closing).resolves.toBeUndefined();
    expect(factory.runtimes[0]?.closeCalls).toBe(1);
    expect(factory.runtimes[0]?.closed).toBe(true);
    expect(() => manager.runtime("session-1")).toThrow("manager is closing");
    expect(() => manager.prepareSession(request, computeRuntimeSnapshotHashes(request.runtime as never))).toThrow(
      "manager is closing",
    );
  });

  it("waits for an in-flight Provider start before applying a snapshot upgrade", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-start-upgrade-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
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
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await reconciler.reconcile(reconcile(computerId, snapshot(1)));
    const starting = manager.ensureRuntime("session-1");
    await createStart;

    const upgrading = reconciler.reconcile(reconcile(computerId, snapshot(2)));
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    releaseCreate();
    await expect(starting).resolves.toBe(factory.runtimes[0]);
    await expect(upgrading).resolves.toMatchObject({ status: "ready" });
    expect(factory.runtimes[0]?.closed).toBe(true);
    expect(() => manager.runtime("session-1")).toThrow("not ready");
    await manager.close();
  });

  it("continues a snapshot upgrade after an in-flight Provider start fails", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolveCreate) => {
      releaseCreate = resolveCreate;
    });
    let createStarted!: () => void;
    const createStart = new Promise<void>((resolveStarted) => {
      createStarted = resolveStarted;
    });
    const base = new FakeFactory();
    const factory = {
      manifest: base.manifest,
      probe: () => base.probe(),
      create: async () => {
        createStarted();
        await createGate;
        throw new Error("start failed");
      },
      resume: async () => {
        throw new Error("resume failed");
      },
    } satisfies AgentRuntimeFactory;
    const computerId = randomUUID();
    const first = reconcile(computerId, snapshot(1));
    const upgraded = reconcile(computerId, snapshot(2));
    const prepared = { binding: { sessionId: "session-1", runtimeBinding: undefined } as never };
    const manager = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(factory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace: {
        prepareSession: async () => prepared,
        cwd: async () => "/workspace",
      } as unknown as AgentWorkspaceManager,
    });
    await manager.prepareSession(first, computeRuntimeSnapshotHashes(first.runtime as never));
    const starting = manager.ensureRuntime("session-1");
    await createStart;

    const upgrading = manager.prepareSession(upgraded, computeRuntimeSnapshotHashes(upgraded.runtime as never));
    await Promise.resolve();
    releaseCreate();
    await expect(starting).rejects.toThrow("start failed");
    await expect(upgrading).resolves.toBe(prepared);
    await manager.close();
  });

  it("surfaces failure while closing a runtime created after shutdown starts", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-late-close-failure-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
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
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await reconciler.reconcile(reconcile(computerId, snapshot(1)));
    const starting = manager.ensureRuntime("session-1");
    await createStart;

    const closing = manager.close();
    releaseCreate();
    await expect(starting).rejects.toThrow("manager is closing");
    await expect(closing).rejects.toThrow("failed to close");
    expect(factory.runtimes[0]?.closeCalls).toBe(1);
  });

  it("does not publish ready after shutdown starts during final binding persistence", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-binding-close-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
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
        if (saveCalls === 1) {
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
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await reconciler.reconcile(reconcile(computerId, snapshot(1)));
    const starting = manager.ensureRuntime("session-1");
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

    await expect(starting).rejects.toThrow("manager is closing");
    await expect(closing).resolves.toBeUndefined();
    expect(factory.runtimes).toHaveLength(0);
    expect(() => manager.runtime("session-1")).toThrow("manager is closing");
  });

  it("surfaces an upgrade close failure that races manager shutdown", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-upgrade-close-failure-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    let rejectClose!: (error: Error) => void;
    const closeGate = new Promise<void>((_resolveClose, reject) => {
      rejectClose = reject;
    });
    const factory = new FakeFactory(false, closeGate);
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await reconciler.reconcile(reconcile(computerId, snapshot(1)));
    await manager.ensureRuntime("session-1");

    const upgrading = reconciler.reconcile(reconcile(computerId, snapshot(2)));
    await vi.waitFor(() => expect(factory.runtimes[0]?.closeCalls).toBe(1));
    const closing = manager.close();
    rejectClose(new Error("upgrade close failed"));

    await expect(upgrading).rejects.toThrow("upgrade close failed");
    await expect(closing).rejects.toThrow("failed to close");
  });

  it("aggregates failures while closing registered Provider runtimes", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-session-runtime-close-failure-"));
    homes.push(home);
    const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
    const factory = new FakeFactory(false, undefined, undefined, undefined, new Error("close failed"));
    const computerId = randomUUID();
    const manager = new SessionRuntimeManager({
      bindingStore: store,
      providers: await providerRegistry(factory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace,
    });
    const reconciler = new SessionReconciler({ computerId, preparation: manager, localPolicy: manager });
    await reconciler.reconcile(reconcile(computerId, snapshot(1)));
    await manager.ensureRuntime("session-1");

    await expect(manager.close()).rejects.toThrow("failed to close");
    expect(factory.runtimes[0]?.closeCalls).toBe(1);
  });

  it("fences unresolved custody and fails closed when direct preparation loses authority", async () => {
    const prepared = { binding: { runtimeBinding: undefined } as never };
    const request = reconcile(randomUUID(), snapshot(1));
    const hashes = computeRuntimeSnapshotHashes(request.runtime as never);
    const unresolved = new SessionRuntimeManager({
      bindingStore: {} as SessionBindingStore,
      providers: await providerRegistry(),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
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
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace: {
        prepareSession: async () => prepared,
      } as unknown as AgentWorkspaceManager,
    });
    await expect(unavailable.prepareSession({ ...request, runtime: undefined }, hashes)).rejects.toThrow(
      "runtime snapshot",
    );
    await expect(unavailable.prepareSession(request, hashes)).rejects.toThrow("provider is not registered");

    const factory = new FakeFactory();
    const captured: CreateAgentRuntimeRequest[] = [];
    const policyFactory = {
      manifest: factory.manifest,
      probe: () => factory.probe(),
      create: async (input: CreateAgentRuntimeRequest) => {
        captured.push(input);
        const runtime = new FakeRuntime(binding("thread-missing"), input.eventSink);
        factory.runtimes.push(runtime);
        return runtime;
      },
      resume: (input: ResumeAgentRuntimeRequest) => factory.resume(input),
    } satisfies AgentRuntimeFactory;
    const emittingFactory = {
      ...policyFactory,
      create: async (input: CreateAgentRuntimeRequest) => {
        captured.push(input);
        return factory.create(input);
      },
    } satisfies AgentRuntimeFactory;
    const missingBinding = new SessionRuntimeManager({
      bindingStore: {
        saveRuntimeBinding: async () => undefined,
        read: async () => undefined,
      } as unknown as SessionBindingStore,
      providers: await providerRegistry(emittingFactory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
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
    await expect(missingBinding.prepareSession({ ...request, runtime: policySnapshot }, hashes)).resolves.toBeDefined();
    await expect(missingBinding.ensureRuntime("session-1")).rejects.toThrow("binding disappeared");
    expect(captured[0]).toMatchObject({
      configuration: { reasoningEffort: "high" },
      policy: { approvals: "never", network: "enabled" },
      systemPrompt: expect.stringContaining("## Platform\n\nplatform"),
    });
    expect(factory.runtimes).toHaveLength(0);

    const missingFinalBinding = new SessionRuntimeManager({
      bindingStore: {
        saveRuntimeBinding: async () => undefined,
      } as unknown as SessionBindingStore,
      providers: await providerRegistry(policyFactory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace: {
        prepareSession: async () => prepared,
        cwd: async () => "/workspace",
      } as unknown as AgentWorkspaceManager,
    });
    await missingFinalBinding.prepareSession({ ...request, runtime: policySnapshot }, hashes);
    await expect(missingFinalBinding.ensureRuntime("session-1")).rejects.toThrow("binding disappeared");
    expect(factory.runtimes[0]?.closed).toBe(true);
    await missingFinalBinding.close();

    const savedBinding = { runtimeBinding: binding("thread-saved") } as never;
    const saved = new SessionRuntimeManager({
      bindingStore: {
        saveRuntimeBinding: async () => savedBinding,
      } as unknown as SessionBindingStore,
      providers: await providerRegistry(policyFactory),
      providerEnvironmentPath: () => "/tmp/provider-env.sh",
      workspace: {
        prepareSession: async () => prepared,
        cwd: async () => "/workspace",
      } as unknown as AgentWorkspaceManager,
    });
    await saved.prepareSession({ ...request, runtime: policySnapshot }, hashes);
    await expect(saved.ensureRuntime("session-1")).resolves.toMatchObject({ binding: binding("thread-missing") });
    await saved.close();
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
            requiresBindingReplacement: (runtimeBinding, hostedTools) =>
              (runtimeBinding.payload as { hostedToolsHash?: string }).hostedToolsHash !==
              (hostedTools ? "b".repeat(64) : undefined),
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
    contractVersion: 2 as const,
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
    return this.#open(request, binding(`thread-${this.runtimes.length + 1}`, request.hostedTools !== undefined));
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
    contractVersion: 2 as const,
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

function binding(threadId: string, hostedTools = false): AgentRuntimeBinding {
  return {
    providerId: "codex",
    schemaVersion: 1,
    payload: { threadId, ...(hostedTools ? { hostedToolsHash: "b".repeat(64) } : {}) },
  };
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
    execution: { approvalPolicy: "never", networkAccess: true },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}
