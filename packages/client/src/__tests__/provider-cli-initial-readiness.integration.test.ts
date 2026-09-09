import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DirectImMessageDeliveryRequest, SessionMessageDeliveryRequest } from "@opentag/shared";
import { RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import {
  AgentTurnRunner,
  computeFileIdentity,
  computeTargetFingerprint,
  ImCredentialEnvironmentManager,
  ProviderCliManager,
  ProviderCliReconciler,
  ProviderCliTurnPlanManager,
  readProviderCliSelection,
  readProviderCliTurnPlan,
  writeProviderCliSelection,
} from "../index.js";
import { AdmissionController } from "../runtime/admission-controller.js";
import type { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionMessageInbox } from "../runtime/session-message-inbox.js";
import type { SessionRuntimeManager } from "../runtime/session-runtime-manager.js";
import type { LiveTurnOwner, TurnCustodyOwner } from "../runtime/turn-custody-owner.js";
import type { TurnReportOwner } from "../runtime/turn-report-owner.js";
import { makeTempDir, writeFakeCli } from "./fixtures/provider-cli.js";
import { providerCliTurnRunnerInvocation } from "./fixtures/provider-cli-turn-plan.js";

const tempDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

describe("provider CLI initial readiness", () => {
  it.each(["feishu", "slack"] as const)(
    "admits concurrent first %s Turns after the pending initial inspection",
    async (provider) => {
      const harness = await createHarness(provider);
      harness.pauseNextInspection();
      const refreshing = harness.emitRequirement();
      await harness.inspectionEntered.promise;
      const first = harness.owner();
      const second = harness.owner();
      harness.runner.start(first);
      harness.runner.start(second);
      await vi.waitFor(() => expect(harness.inspectCalls).toBeGreaterThanOrEqual(3));
      expect(harness.modelStarts).toBe(0);
      expect(harness.reports).toHaveLength(0);
      harness.releaseInspection();
      await refreshing;
      await harness.runner.settled();
      expect(harness.modelStarts).toBe(2);
      expect(harness.reports).toHaveLength(2);
      expect(harness.reports.every((report) => report.outcome === "completed")).toBe(true);
      expect(harness.ensure).not.toHaveBeenCalled();

      harness.runner.start(harness.owner(first.request.sessionId));
      await harness.runner.settled();
      expect(harness.reports.at(-1)?.outcome).toBe("completed");
      expect(harness.modelStarts).toBe(3);
    },
  );

  it.each(["feishu", "slack"] as const)(
    "keeps concurrent %s Turns on the accepted selection during a reconnect inspection",
    async (provider) => {
      const harness = await createHarness(provider);
      await harness.emitRequirement();
      harness.pauseNextInspection();
      const refreshing = harness.emitRequirement();
      await harness.inspectionEntered.promise;
      harness.runner.start(harness.owner());
      harness.runner.start(harness.owner());
      await vi.waitFor(() =>
        expect(harness.reports.filter((report) => report.outcome === "completed")).toHaveLength(2),
      );
      expect(harness.modelStarts).toBe(2);
      harness.releaseInspection();
      await refreshing;
      await harness.runner.settled();
    },
  );

  it("refuses a Run that discovers a replacement and admits the next Run on the new selection", async () => {
    const harness = await createHarness("slack");
    await harness.emitRequirement();
    const before = await readProviderCliSelection(harness.manager.layout, "slack");
    expect(before).toBeTruthy();
    if (!before) throw new Error("Expected an installed Slack selection");
    await writeProviderCliSelection(harness.manager.layout, "slack", before.selection, before);

    harness.runner.start(harness.owner());
    await harness.runner.settled();
    expect(harness.modelStarts).toBe(0);
    expect(harness.reports[0]).toMatchObject({
      outcome: "failed",
      errorReason: "credential_unavailable",
      executionEffects: "not_started",
    });
    expect(harness.logs.some((log) => log.fields.errorCode === "selection_invalid")).toBe(true);

    harness.runner.start(harness.owner());
    await harness.runner.settled();
    expect(harness.modelStarts).toBe(1);
    expect(harness.reports.at(-1)?.outcome).toBe("completed");
  });

  it("rejects first Turns when selection generation changes during the initial wait", async () => {
    const harness = await createHarness("slack");
    harness.pauseNextInspection();
    const refreshing = harness.emitRequirement();
    await harness.inspectionEntered.promise;
    harness.runner.start(harness.owner());
    harness.runner.start(harness.owner());
    await vi.waitFor(() => expect(harness.inspectCalls).toBeGreaterThanOrEqual(3));
    const before = await readProviderCliSelection(harness.manager.layout, "slack");
    const replacement = join(dirname(harness.target), "slack-rotated");
    await writeFile(replacement, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const identity = await computeFileIdentity(replacement);
    await writeProviderCliSelection(
      harness.manager.layout,
      "slack",
      {
        kind: "external",
        executablePath: identity.path,
        fingerprint: computeTargetFingerprint(identity, "4.7.0"),
        trust: "catalog-verified",
        version: "4.7.0",
      },
      before ?? undefined,
    );
    harness.releaseInspection();
    await refreshing;
    await harness.runner.settled();
    expect(harness.modelStarts).toBe(0);
    expect(harness.reports).toHaveLength(2);
    expect(
      harness.reports.every((report) => report.outcome === "failed" && report.errorReason === "credential_unavailable"),
    ).toBe(true);
    expect(harness.logs.every((log) => log.fields.errorCode === "selection_invalid")).toBe(true);
  });

  it("lets one timed-out waiter fail without blocking the other first Turn", async () => {
    const harness = await createHarness("feishu");
    harness.pauseNextInspection();
    const refreshing = harness.emitRequirement();
    await harness.inspectionEntered.promise;
    const timedOut = harness.owner();
    timedOut.request.deadlineAt = new Date(Date.now() - 1_000).toISOString();
    harness.runner.start(timedOut);
    harness.runner.start(harness.owner());
    await vi.waitFor(() => expect(harness.inspectCalls).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(harness.reports.some((report) => report.errorReason === "turn_timeout")).toBe(true));
    expect(harness.modelStarts).toBe(0);
    harness.releaseInspection();
    await refreshing;
    await harness.runner.settled();
    expect(harness.modelStarts).toBe(1);
    expect(harness.reports.some((report) => report.outcome === "completed")).toBe(true);
    expect(harness.reports.some((report) => report.errorReason === "turn_timeout")).toBe(true);
  });

  it("stops a waiting Turn before model execution when the runner closes", async () => {
    const harness = await createHarness("slack");
    harness.pauseNextInspection();
    const refreshing = harness.emitRequirement();
    await harness.inspectionEntered.promise;
    harness.runner.start(harness.owner());
    await vi.waitFor(() => expect(harness.inspectCalls).toBeGreaterThanOrEqual(2));
    harness.runner.stop();
    await harness.runner.settled();
    expect(harness.modelStarts).toBe(0);
    expect(harness.reports[0]).toMatchObject({
      outcome: "cancelled",
      errorReason: "client_shutdown",
    });
    harness.releaseInspection();
    await refreshing;
  });

  it("does not publish a collaboration plan after the Run timeout fires during readiness", async () => {
    const harness = await createHarness("feishu");
    let fireTimeout: () => void = () => undefined;
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: harness.credentials,
      imCredentialGrantVersion: () => 2,
      reconciler: {
        checkSessionMessageDelivery: () => undefined,
        clearActivity: () => true,
        setActivity: () => undefined,
        withAgentLock: async <T>(_agentId: string, task: () => Promise<T>) => task(),
      },
      runtimeManager: {
        ensureRuntime: harness.ensureRuntime as never,
        sessionKind: vi.fn(() => "visible" as const),
      },
      timeoutScheduler: {
        schedule(_delay, task) {
          fireTimeout = task;
          return {
            cancel() {
              fireTimeout = () => undefined;
            },
          };
        },
      },
      turnPlan: harness.plans,
    });
    closers.push(async () => {
      inbox.stop();
      await inbox.settled();
    });
    harness.pauseNextInspection();
    const refreshing = harness.emitRequirement();
    await harness.inspectionEntered.promise;
    const request = collaborationDelivery();
    expect((await inbox.accept(request)).status).toBe("accepted");
    await vi.waitFor(() => expect(harness.inspectCalls).toBeGreaterThanOrEqual(2));
    fireTimeout();
    await inbox.settled();
    expect(harness.modelStarts).toBe(0);
    expect(
      await readProviderCliTurnPlan(join(harness.plans.sessionDir(request.targetSessionId), "plan.json")),
    ).toBeUndefined();
    harness.releaseInspection();
    await refreshing;
    expect(
      await readProviderCliTurnPlan(join(harness.plans.sessionDir(request.targetSessionId), "plan.json")),
    ).toBeUndefined();
  });
});

async function createHarness(provider: "feishu" | "slack") {
  const accountHome = await makeTempDir("opentag-470-account-");
  const openTagHome = await makeTempDir("opentag-470-home-");
  tempDirs.push(accountHome, openTagHome);
  await mkdir(openTagHome, { recursive: true, mode: 0o700 });
  const bin = join(accountHome, "bin");
  const target = await writeFakeCli(bin, provider, { version: provider === "slack" ? "4.7.0" : "1.0.92" });
  const manager = new ProviderCliManager({
    accountHome,
    env: { PATH: bin },
    fetcher: async () => {
      throw new Error("Public network disabled in readiness regression");
    },
  });
  const installed = await manager.ensure(provider, { mode: "auto" });
  expect(installed.ok).toBe(true);
  const ensure = vi.spyOn(manager, "ensure");
  const inspectionEntered = deferred();
  const release = deferred();
  let pauseNextInspection = false;
  let inspectCalls = 0;
  const inspect = async (name: "feishu" | "slack") => {
    inspectCalls += 1;
    const actual = await manager.inspect(name);
    if (pauseNextInspection) {
      pauseNextInspection = false;
      inspectionEntered.resolve();
      await release.promise;
    }
    return actual;
  };
  const frames: Array<{ type: string; status?: string }> = [];
  const listeners = new Set<(frame: Record<string, unknown>) => void | Promise<void>>();
  const emit = async (frame: Record<string, unknown>) => {
    await Promise.all([...listeners].map((listener) => listener(frame)));
  };
  const connection = {
    subscribeBusinessFrames(listener: (frame: never) => void | Promise<void>) {
      listeners.add(listener as (frame: Record<string, unknown>) => void | Promise<void>);
      return () => listeners.delete(listener as (frame: Record<string, unknown>) => void | Promise<void>);
    },
    capabilityVersion: () => 1,
    setImCliReadiness() {},
    async send(frame: { type: string; requestId?: string; status?: string }) {
      frames.push(frame);
      if (frame.type === "im:credential") {
        queueMicrotask(() => {
          void emit({
            type: "im:credential:result",
            requestId: frame.requestId,
            status: "succeeded",
            credentialGeneration: 1,
            grant:
              provider === "slack"
                ? { provider, botAccessToken: "synthetic-test-only" }
                : { provider, appId: "A1", appSecret: "synthetic-test-only", teamBrand: "feishu" },
            outboxContext:
              provider === "slack"
                ? { provider, sessionKind: "channel", channelId: "C1" }
                : { provider, sessionKind: "channel", chatId: "C1" },
          });
        });
      }
    },
  };
  const reconciler = new ProviderCliReconciler({
    connection,
    manager: { layout: manager.layout, inspect, ensure: manager.ensure.bind(manager) },
    validation: {
      async run() {
        throw new Error("No remote validation expected");
      },
      async cleanupAll() {},
    },
    logger: quiet,
  });
  const credentials = new ImCredentialEnvironmentManager({
    connection,
    home: openTagHome,
    logger: quiet,
    exchangeFeishuToken: async () => "synthetic-test-token",
  });
  const plans = new ProviderCliTurnPlanManager({
    accountHome,
    openTagHome,
    readySelection: reconciler.readySelectionForRun.bind(reconciler),
    runnerInvocation: providerCliTurnRunnerInvocation(),
  });
  const reports: Array<{
    outcome?: string;
    errorReason?: string;
    executionEffects?: string;
  }> = [];
  const logs: Array<{ fields: { errorCode?: string }; message: string }> = [];
  let modelStarts = 0;
  const ensureRuntime = vi.fn(async (_sessionId: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    modelStarts += 1;
    return {
      async prompt(input: { runId: string }) {
        return { runId: input.runId, status: "completed" as const, output: [] };
      },
      waitForIdle: async () => undefined,
    };
  });
  const runner = new AgentTurnRunner({
    bindingStore: { updateUnresolved: async () => undefined } as unknown as SessionBindingStore,
    connection,
    custody: { markReporting: async () => undefined, recordResult() {} } as unknown as TurnCustodyOwner,
    reportOwner: {
      create: (report: { outcome?: string; errorReason?: string; executionEffects?: string }) => {
        reports.push(report);
        return { ...report, type: "turn:report", requestId: randomUUID(), resultHash: "a".repeat(64) };
      },
      async submit() {},
    } as unknown as TurnReportOwner,
    runtimeManager: {
      ensureRuntime,
      cwd: () => accountHome,
      sessionKind: () => "visible",
      observe: () => () => undefined,
    } as unknown as SessionRuntimeManager,
    credentialEnvironment: credentials,
    turnPlan: plans,
    logger: {
      ...quiet,
      warn: (fields: { errorCode?: string }, message: string) => logs.push({ fields, message }),
    } as never,
  });
  closers.push(async () => {
    release.resolve();
    runner.stop();
    await runner.settled();
    await credentials.close();
    await reconciler.close();
  });
  const agentId = randomUUID();
  const integrationId = randomUUID();
  return {
    credentials,
    ensure,
    ensureRuntime,
    get inspectCalls() {
      return inspectCalls;
    },
    inspectionEntered,
    logs,
    manager,
    get modelStarts() {
      return modelStarts;
    },
    owner(sessionId: string = randomUUID()): LiveTurnOwner {
      return liveOwner(provider, sessionId, agentId);
    },
    pauseNextInspection() {
      pauseNextInspection = true;
    },
    plans,
    releaseInspection() {
      release.resolve();
    },
    reports,
    runner,
    target,
    emitRequirement() {
      return emit({
        type: "provider-cli:requirement",
        operation: RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
        requestId: randomUUID(),
        provider,
        agentId,
        integrationId,
        credentialGeneration: 1,
        expectedIdentity:
          provider === "slack"
            ? { provider, teamId: "T1", botUserId: "U1", botId: "B1" }
            : { provider, appId: "A1", botOpenId: "B1", teamBrand: "feishu" },
      });
    },
  };
}

function liveOwner(provider: "feishu" | "slack", sessionId: string, agentId: string): LiveTurnOwner {
  const request: DirectImMessageDeliveryRequest = {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: randomUUID(),
    imMessageId: randomUUID(),
    sessionId,
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef:
        provider === "slack"
          ? {
              provider,
              appId: "A1",
              teamId: "T1",
              botUserId: "U1",
              channelId: "C1",
              messageTs: "1710000000.000001",
            }
          : {
              provider,
              teamBrand: "feishu",
              appId: "A1",
              botOpenId: "B1",
              chatId: "C1",
              messageId: "M1",
            },
    },
    runtime: {
      revision: { agent: { sequence: 1, id: "agent-revision" }, session: { sequence: 1, id: "session-revision" } },
      agentId,
      provider: "codex",
      instructions: { platform: "test", agent: "test" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: agentId, mode: "empty_on_create", sharing: "agent" },
    },
  };
  return {
    inputHash: "a".repeat(64),
    request,
    reservation: {} as LiveTurnOwner["reservation"],
    turnId: randomUUID(),
  };
}

function collaborationDelivery(): SessionMessageDeliveryRequest {
  const agentId = randomUUID();
  return {
    type: "session:message:deliver",
    requestId: randomUUID(),
    messageId: randomUUID(),
    sourceSessionId: randomUUID(),
    targetSessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    runtime: {
      revision: { agent: { sequence: 1, id: "a".repeat(64) }, session: { sequence: 1, id: "b".repeat(64) } },
      agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: agentId, mode: "empty_on_create", sharing: "agent" },
    },
    content: { kind: "text", text: "callback" },
  };
}

function deferred() {
  let resolve!: () => void;
  let settled = false;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolve() {
      if (settled) return;
      settled = true;
      resolve();
    },
  };
}
