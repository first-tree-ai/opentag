import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { DirectImMessageDeliveryRequest, SessionMessageDeliveryRequest } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTurnRunner, readProviderCliTurnPlan } from "../index.js";
import { AdmissionController } from "../runtime/admission-controller.js";
import type { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionMessageInbox } from "../runtime/session-message-inbox.js";
import type { SessionRuntimeManager } from "../runtime/session-runtime-manager.js";
import type { LiveTurnOwner, TurnCustodyOwner } from "../runtime/turn-custody-owner.js";
import type { TurnReportOwner } from "../runtime/turn-report-owner.js";
import {
  installTurnTarget,
  makePrivateSlackConfigDir,
  makeTurnPlanHarness,
  writeExternalTurnSelection,
} from "./fixtures/provider-cli-turn-plan.js";

const tempHomes: string[] = [];

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("provider CLI product Turn gate", () => {
  it("prepares an exact native CLI plan before visible direct and collaboration Runtime input", async () => {
    const harness = await makeTurnPlanHarness();
    tempHomes.push(harness.accountHome, harness.openTagHome);
    const target = await installTurnTarget(join(harness.accountHome, "bin"), "slack");
    await writeExternalTurnSelection(harness.layout, "slack", target, "4.7.0");
    const configDir = await makePrivateSlackConfigDir(harness.accountHome);
    const order: string[] = [];
    const prompt = vi.fn(async (request: { runId: string }) => {
      order.push(`prompt:${request.runId}`);
      return { runId: request.runId, status: "completed" as const, output: [] };
    });
    const ensureRuntime = vi.fn(async (sessionId: string) => {
      order.push(`runtime:${sessionId}`);
      const plan = await readProviderCliTurnPlan(join(harness.manager.sessionDir(sessionId), "plan.json"));
      expect(plan).toMatchObject({
        command: "slack",
        provider: "slack",
        selectionKind: "external",
        selectionVersion: "4.7.0",
        sessionId,
        targetPath: target,
      });
      return {
        prompt,
        waitForIdle: async () => {
          order.push(`idle:${sessionId}`);
        },
      };
    });
    const credentials = {
      prepare: vi.fn(async () => {
        order.push("credentials");
        return {
          path: "/tmp/provider-env.sh",
          provider: "slack" as const,
          slackConfigDir: configDir,
          outboxContext: {
            provider: "slack" as const,
            sessionKind: "channel" as const,
            channelId: "C-visible",
          },
        };
      }),
      cleanup: vi.fn(async () => {
        order.push("credential-cleanup");
      }),
    };
    const create = vi.fn((input) => ({
      ...input,
      type: "turn:report",
      requestId: randomUUID(),
      resultHash: "e".repeat(64),
    }));
    const runner = new AgentTurnRunner({
      bindingStore: { updateUnresolved: vi.fn(async () => undefined) } as unknown as SessionBindingStore,
      connection: { send: vi.fn(async () => undefined) },
      custody: {
        markReporting: vi.fn(async () => undefined),
        recordResult: vi.fn(),
      } as unknown as TurnCustodyOwner,
      reportOwner: { create, submit: vi.fn(async () => undefined) } as unknown as TurnReportOwner,
      runtimeManager: {
        ensureRuntime,
        cwd: () => "/workspace",
        observe: () => () => undefined,
        sessionKind: () => "visible",
      } as unknown as SessionRuntimeManager,
      credentialEnvironment: credentials,
      turnPlan: harness.manager,
    });
    runner.start(liveOwner(directDelivery()));
    await runner.settled();
    expect(order).toEqual(["credentials", "runtime:session-1", "prompt:turn-1", "credential-cleanup"]);
    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(await readProviderCliTurnPlan(join(harness.manager.sessionDir("session-1"), "plan.json"))).toBeUndefined();

    order.length = 0;
    const collaborationSessionId = randomUUID();
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentials,
      imCredentialGrantVersion: () => 2,
      reconciler: inboxReconciler(),
      runtimeManager: {
        ensureRuntime: ensureRuntime as never,
        sessionKind: vi.fn(() => "visible" as const),
      },
      turnPlan: harness.manager,
    });
    expect((await inbox.accept(collaborationDelivery(collaborationSessionId))).status).toBe("accepted");
    await inbox.settled();
    expect(order).toEqual([
      "credentials",
      `runtime:${collaborationSessionId}`,
      `idle:${collaborationSessionId}`,
      `prompt:session-message-${collaborationMessageId}`,
      "credential-cleanup",
    ]);
    inbox.stop();
  });

  it("keeps Agent Runtime at 0 calls when plan prepare fails and never publishes an internal Session plan", async () => {
    const missing = await makeTurnPlanHarness();
    const internal = await makeTurnPlanHarness();
    tempHomes.push(missing.accountHome, missing.openTagHome, internal.accountHome, internal.openTagHome);
    const target = await installTurnTarget(join(internal.accountHome, "bin"), "slack");
    await writeExternalTurnSelection(internal.layout, "slack", target, "4.7.0");
    const configDir = await makePrivateSlackConfigDir(internal.accountHome);
    const ensureRuntime = vi.fn();
    const create = vi.fn((input) => ({
      ...input,
      type: "turn:report",
      requestId: randomUUID(),
      resultHash: "f".repeat(64),
    }));
    const failed = new AgentTurnRunner({
      bindingStore: { updateUnresolved: vi.fn(async () => undefined) } as unknown as SessionBindingStore,
      connection: { send: vi.fn(async () => undefined) },
      custody: {
        markReporting: vi.fn(async () => undefined),
        recordResult: vi.fn(),
      } as unknown as TurnCustodyOwner,
      reportOwner: { create, submit: vi.fn(async () => undefined) } as unknown as TurnReportOwner,
      runtimeManager: {
        ensureRuntime,
        cwd: () => "/workspace",
        observe: () => () => undefined,
        sessionKind: () => "visible",
      } as unknown as SessionRuntimeManager,
      credentialEnvironment: {
        prepare: vi.fn(async () => ({
          path: "/tmp/provider-env.sh",
          provider: "slack" as const,
          slackConfigDir: configDir,
        })),
        cleanup: vi.fn(async () => undefined),
      },
      turnPlan: missing.manager,
    });
    failed.start(liveOwner(directDelivery()));
    await failed.settled();
    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        executionEffects: "not_started",
        errorReason: "credential_unavailable",
      }),
    );

    const callbackEnsure = vi.fn();
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: {
        prepare: vi.fn(async () => ({
          path: "/tmp/provider-env.sh",
          provider: "slack" as const,
          slackConfigDir: configDir,
          outboxContext: {
            provider: "slack" as const,
            sessionKind: "channel" as const,
            channelId: "C-visible",
          },
        })),
        cleanup: vi.fn(async () => undefined),
      },
      imCredentialGrantVersion: () => 2,
      reconciler: inboxReconciler(),
      runtimeManager: {
        ensureRuntime: callbackEnsure,
        sessionKind: vi.fn(() => "visible" as const),
      },
      turnPlan: missing.manager,
    });
    expect((await inbox.accept(collaborationDelivery(randomUUID()))).status).toBe("accepted");
    await inbox.settled();
    expect(callbackEnsure).not.toHaveBeenCalled();
    inbox.stop();

    const internalEnsure = vi.fn(async () => ({
      prompt: vi.fn(async (request: { runId: string }) => ({
        runId: request.runId,
        status: "completed" as const,
        output: [],
      })),
      waitForIdle: async () => undefined,
    }));
    const internalInbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: {
        prepare: vi.fn(async () => {
          throw new Error("Internal Sessions must not prepare provider credentials");
        }),
        cleanup: vi.fn(async () => undefined),
      },
      imCredentialGrantVersion: () => 2,
      reconciler: inboxReconciler(),
      runtimeManager: {
        ensureRuntime: internalEnsure as never,
        sessionKind: vi.fn(() => "internal" as const),
      },
      turnPlan: internal.manager,
    });
    const internalSessionId = randomUUID();
    expect((await internalInbox.accept(collaborationDelivery(internalSessionId))).status).toBe("accepted");
    await internalInbox.settled();
    expect(internalEnsure).toHaveBeenCalledOnce();
    expect(
      await readProviderCliTurnPlan(join(internal.manager.sessionDir(internalSessionId), "plan.json")),
    ).toBeUndefined();
    internalInbox.stop();
  });
});

const collaborationMessageId = "33333333-3333-4333-8333-333333333333";

function liveOwner(request: DirectImMessageDeliveryRequest): LiveTurnOwner {
  return {
    inputHash: "a".repeat(64),
    request,
    reservation: {} as LiveTurnOwner["reservation"],
    turnId: "turn-1",
  };
}

function directDelivery(): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: "delivery-1",
    imMessageId: randomUUID(),
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: "hello", providerRef: providerRef() },
    runtime: {
      revision: {
        agent: { sequence: 1, id: "agent-revision" },
        session: { sequence: 1, id: "session-revision" },
      },
      agentId: "agent-1",
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    },
  };
}

function collaborationDelivery(targetSessionId: string): SessionMessageDeliveryRequest {
  const agentId = randomUUID();
  return {
    type: "session:message:deliver",
    requestId: randomUUID(),
    messageId: collaborationMessageId,
    sourceSessionId: randomUUID(),
    targetSessionId,
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

function providerRef() {
  return {
    provider: "slack" as const,
    appId: "app-1",
    teamId: "workspace-1",
    botUserId: "bot-1",
    channelId: "channel-1",
    messageTs: "1710000000.000001",
  };
}

function inboxReconciler() {
  return {
    checkSessionMessageDelivery: () => undefined,
    clearActivity: () => true,
    setActivity: () => undefined,
    withAgentLock: async <T>(_agentId: string, task: () => Promise<T>) => task(),
  };
}
