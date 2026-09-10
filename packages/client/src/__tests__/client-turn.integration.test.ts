import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  computeDirectInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type SessionReconcileRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeFactory } from "../agent-runtime/types.js";
import { ClaudeCodeAgentRuntimeFactory } from "../providers/claude-code/agent-runtime.js";
import {
  type ClaudeCodeProcessClient,
  ClaudeCodeProcessError,
  type ClaudeCodeProcessResult,
} from "../providers/claude-code/process-wire.js";
import { claudeCodeRuntimePolicy, validateClaudeCodeRuntimePolicy } from "../providers/claude-code/runtime-policy.js";
import { CodexAgentRuntimeFactory } from "../providers/codex/agent-runtime.js";
import type {
  CodexAppServerMessage,
  CodexAppServerRequest,
  CodexDynamicToolHandler,
  InteractiveCodexAppServerClient,
} from "../providers/codex/app-server-wire.js";
import { codexRuntimePolicy, validateCodexRuntimePolicy } from "../providers/codex/runtime-policy.js";
import { AgentRuntimeProviderRegistry } from "../runtime/agent-runtime-provider-registry.js";
import { AgentTurnRunner } from "../runtime/agent-turn-runner.js";
import { AgentWorkspaceManager } from "../runtime/agent-workspace.js";
import { MvpTurnReportRecovery } from "../runtime/mvp-turn-report-recovery.js";
import type { RuntimeBusinessFrame, RuntimeConnectionState } from "../runtime/runtime-connection.js";
import { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";
import { SessionRuntimeManager } from "../runtime/session-runtime-manager.js";
import { TurnCustodyOwner } from "../runtime/turn-custody-owner.js";
import { TurnReportOwner } from "../runtime/turn-report-owner.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agent Runtime Client Turn vertical", () => {
  it("maps the rejected disabled-network Codex snapshot without silently enabling it", () => {
    const disabled = { ...snapshot(), execution: { approvalPolicy: "never" as const, networkAccess: false } };
    expect(codexRuntimePolicy(disabled).network).toBe("disabled");
    expect(validateCodexRuntimePolicy(disabled)).toBe("configuration_unsupported");
  });

  it("E-01/E-02 completes sequential Turns on one Session-scoped Provider runtime", async () => {
    const fixture = await runtimeFixture();
    const first = await fixture.custody.accept(delivery(fixture.runtime, "delivery-1", "first"));
    await first.onAcceptedSent?.();
    const firstReport = await fixture.waitForReport(0);

    expect(fixture.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fields: expect.objectContaining({
            agentId: "agent-1",
            computerId: expect.any(String),
            instanceId: "instance-1",
            sessionId: "session-1",
            turnId: expect.any(String),
          }),
          level: "info",
          message: "Turn started",
        }),
        expect.objectContaining({ level: "info", message: "Turn completed" }),
      ]),
    );
    const started = fixture.logs.find((entry) => entry.message === "Turn started");
    expect(started?.fields.instanceId).not.toBe(started?.fields.agentId);
    expect(firstReport.errorReason).toBeUndefined();
    expect(firstReport).toMatchObject({
      deliveryId: "delivery-1",
      outcome: "completed",
      executionEffects: "completed",
      finalText: "answer-1",
    });
    expect(fixture.clients).toHaveLength(1);
    expect(await realpath(fixture.clients[0]?.cwd ?? "")).toBe(
      await realpath(fixture.workspace.paths("agent-1").workspaceRoot),
    );
    await expect(stat(resolve(fixture.clients[0]?.cwd ?? "", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.clients[0]?.developerInstructions).toContain("# OpenTag managed instructions");
    expect(fixture.clients[0]?.developerInstructions).toContain("## Platform\n\nplatform");
    expect(fixture.clients[0]?.developerInstructions).toContain("## Agent\n\nagent");
    expect(fixture.clients[0]?.developerInstructions).toContain("## Session");
    expect(fixture.clients[0]?.developerInstructions).toContain("Session kind: visible");
    expect(fixture.clients[0]?.methods).toContain("thread/start");
    expect(fixture.clients[0]?.methods).not.toContain("thread/resume");
    expect(await fixture.store.read("agent-1", "session-1")).toMatchObject({
      runtimeBinding: { providerId: "codex", schemaVersion: 1, payload: { threadId: "thread-1" } },
      unresolvedTurn: { phase: "reporting", report: firstReport, resultHash: firstReport.resultHash },
    });
    expect(fixture.custody.admission.snapshot().client).toBe(1);

    await fixture.record(firstReport);
    await vi.waitFor(() => expect(fixture.custody.admission.snapshot().client).toBe(0));
    const firstRecorded = await fixture.store.read("agent-1", "session-1");
    expect(firstRecorded?.unresolvedTurn).toBeUndefined();
    expect(firstRecorded?.recentRecordedInputs.at(-1)?.report).toEqual(firstReport);

    const second = await fixture.custody.accept(delivery(fixture.runtime, "delivery-2", "second"));
    await second.onAcceptedSent?.();
    const secondReport = await fixture.waitForReport(1);
    expect(secondReport.finalText).toBe("answer-2");
    expect(fixture.clients).toHaveLength(1);
    expect(fixture.clients[0]?.methods.filter((method) => method === "turn/start")).toHaveLength(2);

    await fixture.record(secondReport);
    await vi.waitFor(() => expect(fixture.custody.admission.snapshot().client).toBe(0));
    const recorded = (await fixture.store.read("agent-1", "session-1"))?.recentRecordedInputs;
    expect(recorded).toHaveLength(2);
    expect(recorded?.at(-1)?.report).toEqual(secondReport);
    await fixture.runtimeManager.close();
  });

  it("D-19/D-26 keeps the Provider alive across a mid-turn socket outage and reports after reconnect", async () => {
    let releaseTerminal: (() => void) | undefined;
    const terminalGate = new Promise<void>((resolveGate) => {
      releaseTerminal = resolveGate;
    });
    const fixture = await runtimeFixture(terminalGate);
    const accepted = await fixture.custody.accept(delivery(fixture.runtime, "delivery-1", "offline"));
    await accepted.onAcceptedSent?.();
    await vi.waitFor(async () => {
      expect((await fixture.store.read("agent-1", "session-1"))?.unresolvedTurn?.phase).toBe("running");
    });

    fixture.connection.setState("stopped");
    releaseTerminal?.();
    await vi.waitFor(() => expect(fixture.reportOwner.pendingCount).toBe(1));
    expect(fixture.connection.reports()).toHaveLength(0);
    expect(fixture.clients[0]?.interrupts).toBe(0);
    expect(fixture.clients[0]?.closed).toBe(false);

    fixture.connection.setState("registered");
    const report = await fixture.waitForReport(0);
    expect(report.finalText).toBe("answer-1");
    await fixture.record(report);
    await vi.waitFor(() => expect(fixture.custody.admission.snapshot().client).toBe(0));
    await fixture.runtimeManager.close();
  });

  it("runs a Claude Code Agent through exact Provider selection and the IM Turn path", async () => {
    const fixture = await runtimeFixture(Promise.resolve(), Promise.resolve(), "claude-code");
    const accepted = await fixture.custody.accept(delivery(fixture.runtime, "delivery-claude", "use Claude"));
    await accepted.onAcceptedSent?.();
    const report = await fixture.waitForReport(0);

    expect(report).toMatchObject({
      outcome: "completed",
      executionEffects: "completed",
      finalText: "claude-answer",
    });
    expect(fixture.claudeProcesses).toHaveLength(1);
    expect(fixture.claudeProcesses[0]?.args).toContain("--strict-mcp-config");
    expect(await fixture.store.read("agent-1", "session-1")).toMatchObject({
      provider: "claude-code",
      runtimeBinding: { providerId: "claude-code", schemaVersion: 1 },
    });
    await fixture.record(report);
    await fixture.runtimeManager.close();
  });

  it.each([
    ["bridge", 0],
    ["process", 0],
    ["spawn", 1],
  ] as const)("reports Claude Code %s setup failure as not started", async (failure, processCount) => {
    const fixture = await runtimeFixture(Promise.resolve(), Promise.resolve(), "claude-code", failure);
    const accepted = await fixture.custody.accept(delivery(fixture.runtime, `delivery-${failure}`, "use Claude"));
    await accepted.onAcceptedSent?.();
    const report = await fixture.waitForReport(0);

    expect(report).toMatchObject({
      outcome: "failed",
      executionEffects: "not_started",
      errorReason: "provider_start_failed",
    });
    expect(fixture.claudeProcesses).toHaveLength(processCount);
    await fixture.record(report);
    await fixture.runtimeManager.close();
  });

  it("does not synthesize recovery Reports while the exact accepted, starting, or running Turn is live", async () => {
    let releaseStarting!: () => void;
    const startingGate = new Promise<void>((resolveStarting) => {
      releaseStarting = resolveStarting;
    });
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolveTerminal) => {
      releaseTerminal = resolveTerminal;
    });
    const fixture = await runtimeFixture(terminalGate, startingGate);
    const accepted = await fixture.custody.accept(delivery(fixture.runtime, "delivery-live", "live"));

    const assertLivePhaseIsUntouched = async (phase: "accepted" | "starting" | "running") => {
      const requests: SessionReconcileRequest[] = [
        { ...fixture.reconcileRequest, requestId: randomUUID() },
        {
          ...fixture.reconcileRequest,
          requestId: randomUUID(),
          runtime: snapshot(2),
        },
        {
          ...fixture.reconcileRequest,
          requestId: randomUUID(),
          desired: "stopped",
          runtime: undefined,
        },
      ];
      for (const request of requests) {
        const reconciled = await fixture.reconciler.reconcile(request);
        const prepared = await fixture.recovery.prepare(request, reconciled);
        expect(prepared.retainedReports).toBeUndefined();
      }
      const unresolved = (await fixture.store.read("agent-1", "session-1"))?.unresolvedTurn;
      expect(unresolved).toMatchObject({ phase });
      expect(unresolved).not.toHaveProperty("report");
      expect(fixture.connection.reports()).toHaveLength(0);
      expect(fixture.reportOwner.pendingCount).toBe(0);
    };

    await assertLivePhaseIsUntouched("accepted");
    await accepted.onAcceptedSent?.();
    await vi.waitFor(async () => {
      expect((await fixture.store.read("agent-1", "session-1"))?.unresolvedTurn?.phase).toBe("starting");
    });
    await assertLivePhaseIsUntouched("starting");
    releaseStarting();
    await vi.waitFor(async () => {
      expect((await fixture.store.read("agent-1", "session-1"))?.unresolvedTurn?.phase).toBe("running");
    });
    await assertLivePhaseIsUntouched("running");

    releaseTerminal();
    const report = await fixture.waitForReport(0);
    expect(report).toMatchObject({ outcome: "completed", finalText: "answer-1" });
    expect((await fixture.store.read("agent-1", "session-1"))?.unresolvedTurn).toMatchObject({
      phase: "reporting",
      report,
    });
    await fixture.record(report);
    await fixture.runtimeManager.close();
  });

  it.each(["accepted", "starting", "running", "reporting"] as const)(
    "reprepares the missing Session Runtime after a replayed %s Turn report",
    async (phase) => {
      const fixture = await recoveryFixture(phase);

      // Cold start: the durable unresolved Turn fences the Session for report recovery.
      const coldRequest = fixture.reconcile();
      const cold = await fixture.reconciler.reconcile(coldRequest);
      expect(cold).toMatchObject({
        status: "recovery_required",
        reason: "unresolved_turn",
        turn: { deliveryId: "delivery-1", turnId: "turn-1" },
      });
      expect(fixture.prepareSpy).toHaveBeenCalledTimes(1);

      const prepared = await fixture.recovery.prepare(coldRequest, cold);
      expect(prepared.retainedReports).toHaveLength(1);
      if (phase !== "reporting") {
        expect((await fixture.store.read("agent-1", "session-1"))?.unresolvedTurn).toMatchObject({
          phase: "reporting",
          report: fixture.expectedRecoveryReport,
        });
      }
      fixture.recovery.afterReconciled(coldRequest, prepared);
      await vi.waitFor(() => expect(fixture.connection.reports()).toHaveLength(1));
      const replayed = fixture.connection.reports()[0];
      expect(replayed).toMatchObject({
        deliveryId: "delivery-1",
        turnId: "turn-1",
        ...fixture.expectedRecoveryReport,
      });
      if (!replayed) throw new Error("Expected a replayed Turn Report");

      // While the replayed report awaits its ACK the fence holds: repeated reconciles keep
      // demanding recovery, new deliveries are rejected, and no provider is ever started.
      await expect(fixture.reconciler.reconcile(fixture.reconcile())).resolves.toMatchObject({
        status: "recovery_required",
        turn: { deliveryId: "delivery-1", turnId: "turn-1" },
      });
      const held = delivery(fixture.runtime, "delivery-2", "held behind the fence");
      expect(fixture.reconciler.checkDelivery(held)).toBe("session_recovery_required");
      await expect(fixture.custody.accept(held)).resolves.toMatchObject({
        result: { status: "rejected", reason: "session_recovery_required" },
      });
      expect(fixture.clients).toHaveLength(0);
      expect(fixture.providerReadyCalls()).toBe(0);

      // The ACK records the replayed report and lifts the recovery fence.
      await fixture.reportOwner.handleResult({
        type: "turn:report:result",
        requestId: replayed.requestId,
        turnId: replayed.turnId,
        status: "recorded",
        resultHash: replayed.resultHash,
      });
      await vi.waitFor(() => expect(fixture.reconciler.protectedWorkSnapshot().recoveries).toHaveLength(0));
      expect((await fixture.store.read("agent-1", "session-1"))?.unresolvedTurn).toBeUndefined();

      // An unchanged reconcile must re-prepare the missing runtime entry without starting the provider.
      await expect(fixture.reconciler.reconcile(fixture.reconcile())).resolves.toMatchObject({ status: "ready" });
      expect(fixture.prepareSpy).toHaveBeenCalledTimes(2);
      expect(fixture.runtimeManager.requiresSessionPreparation(fixture.reconcile())).toBe(false);
      expect(fixture.clients).toHaveLength(0);

      // Repeated unchanged reconciles stay ready without redundant preparation.
      await expect(fixture.reconciler.reconcile(fixture.reconcile())).resolves.toMatchObject({ status: "ready" });
      expect(fixture.prepareSpy).toHaveBeenCalledTimes(2);

      // The next Turn resumes the retained provider thread and runs to completion.
      const decision = await fixture.custody.accept(delivery(fixture.runtime, "delivery-3", "after recovery"));
      expect(decision.result).toMatchObject({ status: "accepted" });
      await decision.onAcceptedSent?.();
      await vi.waitFor(() => expect(fixture.connection.reports().length).toBeGreaterThan(1));
      const report = fixture.connection.reports()[1];
      expect(report).toMatchObject({
        deliveryId: "delivery-3",
        outcome: "completed",
        executionEffects: "completed",
        finalText: "answer-1",
      });
      expect(fixture.clients).toHaveLength(1);
      expect(fixture.clients[0]?.threadId).toBe("retained-thread-before-restart");
      expect(fixture.clients[0]?.methods).toContain("thread/resume");
      expect(fixture.clients[0]?.methods).not.toContain("thread/start");
      if (!report) throw new Error("Expected the post-recovery Turn Report");
      await fixture.reportOwner.handleResult({
        type: "turn:report:result",
        requestId: report.requestId,
        turnId: report.turnId,
        status: "recorded",
        resultHash: report.resultHash,
      });
      await vi.waitFor(() => expect(fixture.custody.admission.snapshot().client).toBe(0));
      const recorded = await fixture.store.read("agent-1", "session-1");
      expect(recorded?.unresolvedTurn).toBeUndefined();
      expect(recorded?.runtimeBinding).toEqual(fixture.retainedBinding);
      expect(recorded?.recentRecordedInputs.at(-1)?.report).toEqual(report);
      await expect(fixture.reconciler.reconcile(fixture.reconcile())).resolves.toMatchObject({ status: "ready" });
      await fixture.runtimeManager.ensureRuntime("session-1");
      expect(fixture.prepareSpy).toHaveBeenCalledTimes(2);
      expect(fixture.clients).toHaveLength(1);
      await fixture.runtimeManager.close();
    },
  );

  it("keeps a healthy Session Runtime ready without redundant preparation or provider rebuild", async () => {
    const fixture = await runtimeFixture();
    await fixture.runtimeManager.ensureRuntime("session-1");
    const prepareSpy = vi.spyOn(fixture.runtimeManager, "prepareSession");

    await expect(
      fixture.reconciler.reconcile({ ...fixture.reconcileRequest, requestId: randomUUID() }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      fixture.reconciler.reconcile({ ...fixture.reconcileRequest, requestId: randomUUID() }),
    ).resolves.toMatchObject({ status: "ready" });

    expect(prepareSpy).not.toHaveBeenCalled();
    expect(fixture.runtimeManager.requiresSessionPreparation(fixture.reconcileRequest)).toBe(false);
    await fixture.runtimeManager.ensureRuntime("session-1");
    expect(fixture.clients).toHaveLength(1);
    expect(fixture.clients[0]?.methods).toContain("thread/start");
    expect(fixture.clients[0]?.methods).not.toContain("thread/resume");
    await fixture.runtimeManager.close();
  });
});

async function runtimeFixture(
  terminalGate: Promise<void> = Promise.resolve(),
  startingGate: Promise<void> = Promise.resolve(),
  provider: "codex" | "claude-code" = "codex",
  claudeFailure?: "bridge" | "process" | "spawn",
) {
  const home = await mkdtemp(resolve(tmpdir(), "opentag-turn-integration-"));
  directories.push(home);
  const computerId = randomUUID();
  const runtime = snapshot(1, provider);
  const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
  const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
  const connection = new FakeConnection();
  const reportOwner = new TurnReportOwner({ connection });
  const clients: ScriptedTurnClient[] = [];
  const claudeProcesses: ScriptedClaudeCodeProcess[] = [];
  const logs: RecordedLog[] = [];
  const factory: AgentRuntimeFactory =
    provider === "codex"
      ? codexFactory(clients, terminalGate)
      : new ClaudeCodeAgentRuntimeFactory({
          createSessionId: () => "11111111-1111-4111-8111-111111111111",
          createProcess: (_cwd, args) => {
            if (claudeFailure === "process") throw 42;
            const process = new ScriptedClaudeCodeProcess(args, terminalGate, claudeFailure === "spawn");
            claudeProcesses.push(process);
            return process;
          },
          probeRunner: async () => ({ credential: true, streamJson: true, version: "test" }),
          ...(claudeFailure === "bridge"
            ? {
                startHostedToolBridge: async () => {
                  throw new Error("bridge setup failed");
                },
              }
            : {}),
        });
  const providers = await providerRegistry(factory);
  const runtimeManager = new SessionRuntimeManager({
    home,
    bindingStore: store,
    ensureProviderReady: (providerId, signal) => providers.ensureReady(providerId, signal),
    providers,
    providerEnvironmentPath: () => "/tmp/provider-env.sh",
    workspace,
  });
  const reconciler = new SessionReconciler({
    installationId: computerId,
    preparation: runtimeManager,
    localPolicy: runtimeManager,
  });
  let runner: AgentTurnRunner;
  const custody = new TurnCustodyOwner({
    bindingStore: store,
    reconciler,
    id: (() => {
      let next = 0;
      return () => {
        next += 1;
        return `turn-${next}`;
      };
    })(),
    start: (owner) => runner.start(owner),
  });
  runner = new AgentTurnRunner({
    bindingStore: store,
    connection,
    custody,
    reportOwner,
    resourceFetcher: {
      fetchForTurn: async () => {
        await startingGate;
        return undefined;
      },
    } as never,
    runtimeManager,
    credentialEnvironment: {
      prepare: async () => ({ path: "/tmp/provider-env.sh", provider: "slack" }),
      cleanup: async () => undefined,
    },
    logger: recordingLogger(logs, { computerId, instanceId: "instance-1" }),
  });
  const reconcile: SessionReconcileRequest = {
    type: "session:reconcile",
    requestId: randomUUID(),
    installationId: computerId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready",
    runtime,
  };
  await reconciler.reconcile(reconcile);
  const recovery = new MvpTurnReportRecovery({ bindingStore: store, reconciler, reportOwner });

  const waitForReport = async (index: number): Promise<TurnReportRequest> => {
    await vi.waitFor(() => expect(connection.reports().length).toBeGreaterThan(index));
    const report = connection.reports()[index];
    if (!report) throw new Error("Expected a Turn Report");
    return report;
  };
  const record = (report: TurnReportRequest) =>
    reportOwner.handleResult({
      type: "turn:report:result",
      requestId: report.requestId,
      turnId: report.turnId,
      status: "recorded",
      resultHash: report.resultHash,
    });
  return {
    clients,
    claudeProcesses,
    connection,
    custody,
    logs,
    record,
    reconciler,
    reconcileRequest: reconcile,
    recovery,
    reportOwner,
    runner,
    runtimeManager,
    runtime,
    store,
    waitForReport,
    workspace,
  };
}

function codexFactory(
  clients: ScriptedTurnClient[],
  terminalGate: Promise<void>,
  newThreadId = "thread-1",
): AgentRuntimeFactory {
  return new CodexAgentRuntimeFactory({
    clientVersion: "0.0.1",
    createClient: (cwd) => {
      const client = new ScriptedTurnClient(cwd, terminalGate, newThreadId);
      clients.push(client);
      return client;
    },
    probeRunner: async () => ({ appServer: true, credential: true, experimentalTools: true, version: "test" }),
  });
}

/**
 * Two daemon lifetimes over one durable home: the first prepares the Session and persists a
 * provider thread binding, then survives only as durable state; the second rebuilds every
 * in-memory component the way a cold start does, with the interrupted Turn still unresolved.
 */
async function recoveryFixture(phase: "accepted" | "starting" | "running" | "reporting") {
  const home = await mkdtemp(resolve(tmpdir(), "opentag-runtime-recovery-"));
  directories.push(home);
  const computerId = randomUUID();
  const runtime = snapshot(1, "codex");
  const reconcile = (): SessionReconcileRequest => ({
    type: "session:reconcile",
    requestId: randomUUID(),
    installationId: computerId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready",
    runtime,
  });

  // Previous daemon lifetime: prepare the Session and persist the provider thread binding.
  const seedStore = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
  const seedWorkspace = new AgentWorkspaceManager({ home, bindingStore: seedStore });
  const seedClients: ScriptedTurnClient[] = [];
  const seedProviders = await providerRegistry(
    codexFactory(seedClients, Promise.resolve(), "retained-thread-before-restart"),
  );
  const seedManager = new SessionRuntimeManager({
    home,
    bindingStore: seedStore,
    ensureProviderReady: (providerId, signal) => seedProviders.ensureReady(providerId, signal),
    providers: seedProviders,
    providerEnvironmentPath: () => "/tmp/provider-env.sh",
    workspace: seedWorkspace,
  });
  const seedReconciler = new SessionReconciler({
    installationId: computerId,
    preparation: seedManager,
    localPolicy: seedManager,
  });
  await seedReconciler.reconcile(reconcile());
  await seedManager.ensureRuntime("session-1");
  await seedManager.close();
  expect(seedClients[0]?.threadId).toBe("retained-thread-before-restart");
  const retainedBinding = (await seedStore.read("agent-1", "session-1"))?.runtimeBinding;
  expect(retainedBinding).toBeDefined();

  // The interrupted Turn survives only as durable custody in the Session binding.
  const interrupted = delivery(runtime, "delivery-1", "interrupted");
  await seedStore.recordAccepted(interrupted, computeDirectInputHash(interrupted), "turn-1");
  if (phase !== "accepted") await seedStore.updateUnresolved("agent-1", "session-1", "turn-1", "starting");
  if (phase === "running" || phase === "reporting") {
    await seedStore.updateUnresolved("agent-1", "session-1", "turn-1", "running");
  }
  if (phase === "reporting") {
    const reportInput = {
      deliveryId: "delivery-1",
      turnId: "turn-1",
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 1,
      outcome: "completed" as const,
      executionEffects: "completed" as const,
      finalText: "interrupted answer",
      traceSummary: { lastSequence: 0, droppedEvents: 0 },
    };
    const report: TurnReportRequest = {
      type: "turn:report",
      requestId: randomUUID(),
      ...reportInput,
      resultHash: computeTurnResultHash(reportInput),
    };
    await seedStore.updateUnresolved("agent-1", "session-1", "turn-1", "reporting", {
      report,
      resultHash: report.resultHash,
    });
  }
  const expectedRecoveryReport =
    phase === "accepted"
      ? { outcome: "failed", executionEffects: "not_started", errorReason: "provider_start_failed" }
      : phase === "reporting"
        ? { outcome: "completed", executionEffects: "completed", finalText: "interrupted answer" }
        : { outcome: "unknown", executionEffects: "may_have_occurred", errorReason: "turn_state_unknown" };

  // Restart: every in-memory component is rebuilt over the same durable home.
  const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
  const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
  const connection = new FakeConnection();
  const reportOwner = new TurnReportOwner({ connection });
  const clients: ScriptedTurnClient[] = [];
  const providers = await providerRegistry(codexFactory(clients, Promise.resolve()));
  let providerReadyCalls = 0;
  const runtimeManager = new SessionRuntimeManager({
    home,
    bindingStore: store,
    ensureProviderReady: (providerId, signal) => {
      providerReadyCalls += 1;
      return providers.ensureReady(providerId, signal);
    },
    providers,
    providerEnvironmentPath: () => "/tmp/provider-env.sh",
    workspace,
  });
  const reconciler = new SessionReconciler({
    installationId: computerId,
    preparation: runtimeManager,
    localPolicy: runtimeManager,
  });
  const logs: RecordedLog[] = [];
  let runner: AgentTurnRunner;
  const custody = new TurnCustodyOwner({
    bindingStore: store,
    reconciler,
    id: (() => {
      let next = 1;
      return () => {
        next += 1;
        return `turn-${next}`;
      };
    })(),
    start: (owner) => runner.start(owner),
  });
  runner = new AgentTurnRunner({
    bindingStore: store,
    connection,
    custody,
    reportOwner,
    runtimeManager,
    credentialEnvironment: {
      prepare: async () => ({ path: "/tmp/provider-env.sh", provider: "slack" }),
      cleanup: async () => undefined,
    },
    logger: recordingLogger(logs),
  });
  const recovery = new MvpTurnReportRecovery({ bindingStore: store, reconciler, reportOwner });
  const prepareSpy = vi.spyOn(runtimeManager, "prepareSession");
  return {
    clients,
    connection,
    custody,
    expectedRecoveryReport,
    retainedBinding,
    logs,
    prepareSpy,
    providerReadyCalls: () => providerReadyCalls,
    reconcile,
    reconciler,
    recovery,
    reportOwner,
    runner,
    runtime,
    runtimeManager,
    store,
  };
}

async function providerRegistry(factory: AgentRuntimeFactory): Promise<AgentRuntimeProviderRegistry> {
  const providers = new AgentRuntimeProviderRegistry([
    {
      artifactIdentity: "a".repeat(64),
      factory,
      policy: factory.manifest.providerId === "codex" ? codexRuntimePolicy : claudeCodeRuntimePolicy,
      validate: factory.manifest.providerId === "codex" ? validateCodexRuntimePolicy : validateClaudeCodeRuntimePolicy,
    },
  ]);
  await providers.refresh(factory.manifest.providerId);
  return providers;
}

class FakeConnection {
  readonly sent: unknown[] = [];
  readonly #listeners = new Set<(state: RuntimeConnectionState) => void>();
  readonly #businessListeners = new Set<(frame: RuntimeBusinessFrame) => void | Promise<void>>();
  state: RuntimeConnectionState = "registered";

  subscribeState(listener: (state: RuntimeConnectionState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  subscribeBusinessFrames(listener: (frame: RuntimeBusinessFrame) => void | Promise<void>): () => void {
    this.#businessListeners.add(listener);
    return () => this.#businessListeners.delete(listener);
  }

  async send(frame: unknown): Promise<void> {
    if (this.state !== "registered") throw new Error("socket unavailable");
    this.sent.push(frame);
  }

  setState(state: RuntimeConnectionState): void {
    this.state = state;
    for (const listener of this.#listeners) listener(state);
  }

  reports(): TurnReportRequest[] {
    return this.sent.filter(
      (frame): frame is TurnReportRequest => (frame as { type?: unknown }).type === "turn:report",
    );
  }
}

class ScriptedTurnClient implements InteractiveCodexAppServerClient {
  readonly cwd: string;
  readonly methods: string[] = [];
  readonly #terminalGate: Promise<void>;
  readonly #newThreadId: string;
  #listener?: (message: CodexAppServerMessage) => void;
  #turn = 0;
  closed = false;
  interrupts = 0;
  threadId?: string;
  developerInstructions?: string;

  constructor(cwd: string, terminalGate: Promise<void>, newThreadId: string) {
    this.cwd = cwd;
    this.#terminalGate = terminalGate;
    this.#newThreadId = newThreadId;
  }

  async initialize(): Promise<void> {
    this.methods.push("initialize", "initialized");
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.methods.push(method);
    if (method === "thread/start" || method === "thread/resume") {
      const input = params as { cwd: string; developerInstructions: string; threadId?: string };
      this.threadId = input.threadId ?? this.#newThreadId;
      this.developerInstructions = input.developerInstructions;
      return {
        thread: { id: this.threadId, ephemeral: false },
        cwd: input.cwd,
        approvalPolicy: "never",
        sandbox: { type: "workspaceWrite", networkAccess: true },
        model: "default-model",
      };
    }
    if (method === "turn/start") {
      this.#turn += 1;
      const turnId = `provider-turn-${this.#turn}`;
      const answer = `answer-${this.#turn}`;
      void this.#terminalGate.then(() => {
        this.#listener?.({
          method: "turn/completed",
          params: {
            threadId: this.threadId,
            turn: {
              id: turnId,
              status: "completed",
              items: [
                {
                  id: answer,
                  type: "agentMessage",
                  phase: "final_answer",
                  text: answer,
                },
              ],
            },
          },
        });
      });
      return { turn: { id: turnId, status: "inProgress", items: [] } };
    }
    throw new Error(`Unexpected method ${method}`);
  }

  async notify(): Promise<void> {}

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  subscribeServerRequests(_listener: (request: CodexAppServerRequest) => void): () => void {
    return () => undefined;
  }

  setDynamicToolHandler(_handler: CodexDynamicToolHandler | undefined): void {}

  async respondServerRequest(): Promise<void> {}

  async rejectServerRequest(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class ScriptedClaudeCodeProcess implements ClaudeCodeProcessClient {
  readonly args: readonly string[];
  readonly #failSpawn: boolean;
  readonly #terminalGate: Promise<void>;

  constructor(args: readonly string[], terminalGate: Promise<void>, failSpawn = false) {
    this.args = args;
    this.#failSpawn = failSpawn;
    this.#terminalGate = terminalGate;
  }

  async execute(
    _input: Readonly<Record<string, unknown>>,
    onMessage: (message: Readonly<Record<string, unknown>>) => void,
  ): Promise<ClaudeCodeProcessResult> {
    if (this.#failSpawn) throw new ClaudeCodeProcessError("spawn", "asynchronous spawn failed");
    await this.#terminalGate;
    onMessage({
      type: "system",
      subtype: "init",
      session_id: "11111111-1111-4111-8111-111111111111",
    });
    onMessage({
      type: "result",
      subtype: "success",
      session_id: "11111111-1111-4111-8111-111111111111",
      is_error: false,
      result: "claude-answer",
      permission_denials: [],
      usage: {},
    });
    return { stderr: "" };
  }

  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

function snapshot(revision = 1, provider: "codex" | "claude-code" = "codex"): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: revision, id: `agent-revision-${revision}` },
      session: { sequence: revision, id: `session-revision-${revision}` },
    },
    agentId: "agent-1",
    provider,
    model: `model-${revision}`,
    instructions: { platform: "platform", agent: "agent", session: "session" },
    execution: { approvalPolicy: "never", networkAccess: true },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}

function delivery(runtime: EffectiveRuntimeSnapshot, deliveryId: string, text: string): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId,
    imMessageId: `message-${deliveryId}`,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text,
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "workspace-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000001",
      },
    },
    runtime,
  };
}
