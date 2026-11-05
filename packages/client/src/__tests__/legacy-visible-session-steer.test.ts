import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InputRejectReason,
  RuntimeImCredentialGrantRequest,
  RuntimeImCredentialGrantResult,
  RuntimeImOutboxContext,
  SessionMessageDeliveryRequest,
} from "@opentag/shared";
import { RuntimeImCredentialGrantRequestSchema } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSteerOutcome } from "../agent-runtime/types.js";
import { AdmissionController } from "../runtime/admission-controller.js";
import { ImCredentialEnvironmentManager } from "../runtime/im-credential-environment-manager.js";
import type { RuntimeBusinessFrame } from "../runtime/runtime-connection.js";
import { RuntimeCredentialEnvironmentManager } from "../runtime/runtime-credential-environment-manager.js";
import { MemoryRuntimeDurabilityStore } from "../runtime/runtime-durability.js";
import { SessionMessageInbox } from "../runtime/session-message-inbox.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("visible Session steer with default Local credentials", () => {
  it.each<RuntimeImOutboxContext>([
    { provider: "slack", sessionKind: "channel", channelId: "C-visible" },
    { provider: "slack", sessionKind: "thread", channelId: "C-visible", threadTs: "1710000000.000001" },
    { provider: "feishu", sessionKind: "channel", chatId: "oc_visible" },
    { provider: "feishu", sessionKind: "thread", chatId: "oc_visible", threadId: "omt_thread" },
  ])("steers into the running Turn with its authorized $provider $sessionKind context", async (outbox) => {
    const s = await system(outbox);
    const prepared = await s.credentials.prepare(s.subject);
    expect(s.credentials.mode).toBe("legacy");
    expect(prepared.outboxContext).toEqual(s.outbox);
    expect(await s.inbox.accept(s.message)).toMatchObject({ status: "accepted" });

    await vi.waitFor(() => expect(s.steer).toHaveBeenCalledOnce());
    expect(s.steer.mock.calls[0]?.[0]).toMatchObject({ expectedRunId: "im-turn" });
    const items = s.steer.mock.calls[0]?.[0].input.items ?? [];
    expect(items[0]?.text).toContain(JSON.stringify(s.outbox));
    expect(items.at(-1)?.text).toBe("child result");
    expect(s.prompt).not.toHaveBeenCalled();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toEqual({ type: "im:credential", requestId: expect.any(String), ...s.subject });
    expect(s.credentials.outboxContextForSession(randomUUID())).toBeUndefined();
    await vi.waitFor(() => expect(s.inbox.getState(s.message.messageId)?.status).toBe("running"));
    await expect(s.inbox.accept({ ...s.message, requestId: randomUUID() })).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(
      s.inbox.accept({ ...s.message, content: { kind: "text", text: "conflicting result" } }),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "input_conflict",
    });
    expect(s.steer).toHaveBeenCalledOnce();
    s.settle("processed");
    await s.inbox.settled();
    expect(s.inbox.getState(s.message.messageId)?.status).toBe("succeeded");
    await s.credentials.cleanup(s.subject.sessionId);
    expect(s.credentials.outboxContextForSession(s.subject.sessionId)).toBeUndefined();
  });

  it("settles a steered message with a failed or cancelled host without starting a callback Run", async () => {
    const s = await system();
    await s.credentials.prepare(s.subject);
    await s.inbox.accept(s.message);
    await vi.waitFor(() => expect(s.inbox.getState(s.message.messageId)?.status).toBe("running"));
    s.settle("interrupted");
    await s.inbox.settled();
    expect(s.inbox.getState(s.message.messageId)).toMatchObject({
      status: "failed",
      lastError: { code: "session_message_steer_interrupted" },
    });
    expect(s.prompt).not.toHaveBeenCalled();
  });

  it("keeps a legacy Turn without Server outbox context queued until admission is released", async () => {
    const s = await system();
    s.authority.version = 1;
    expect((await s.credentials.prepare(s.subject)).outboxContext).toBeUndefined();
    s.authority.version = 2;
    await s.inbox.accept(s.message);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(s.inbox.queuedCount).toBe(1);
    expect(s.steer).not.toHaveBeenCalled();
    s.release();
    await s.inbox.settled();
    expect(s.prompt).toHaveBeenCalledOnce();
    expect(s.inbox.getState(s.message.messageId)?.status).toBe("succeeded");
  });

  it.each(["old-server", "stale-placement"] as const)(
    "rechecks delivery authority with a cached outbox (%s)",
    async (race) => {
      const s = await system();
      await s.credentials.prepare(s.subject);
      if (race === "old-server") s.authority.version = 1;
      else s.authority.reason = "stale_generation";
      await expect(s.inbox.accept(s.message)).resolves.toMatchObject({
        status: "rejected",
        reason: race === "old-server" ? "session_not_ready" : "stale_generation",
      });
      expect(s.steer).not.toHaveBeenCalled();
      expect(s.inbox.queuedCount).toBe(0);
    },
  );

  it.each(["binding_inactive", "placement_stale", "agent_mismatch"] as const)(
    "drops prior context when a new grant is refused (%s)",
    async (code) => {
      const s = await system();
      await s.credentials.prepare(s.subject);
      s.authority.grantRejection = code;
      await expect(s.credentials.prepare({ ...s.subject, placementGeneration: 2 })).rejects.toMatchObject({ code });
      expect(s.credentials.outboxContextForSession(s.subject.sessionId)).toBeUndefined();
      await s.inbox.accept(s.message);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(s.steer).not.toHaveBeenCalled();
      expect(s.inbox.queuedCount).toBe(1);
    },
  );
});

async function system(
  outbox: RuntimeImOutboxContext = {
    provider: "slack",
    sessionKind: "thread",
    channelId: "C-visible",
    threadTs: "1710000000.000001",
  },
) {
  const home = await mkdtemp(join(tmpdir(), "opentag-legacy-steer-"));
  const subject = { sessionId: randomUUID(), agentId: randomUUID(), placementGeneration: 1 };
  const authority: {
    version: number;
    reason?: InputRejectReason;
    grantRejection?: Extract<RuntimeImCredentialGrantResult, { status: "rejected" }>["code"];
  } = {
    version: 2,
  };
  const requests: RuntimeImCredentialGrantRequest[] = [];
  let listener: ((frame: RuntimeBusinessFrame) => void) | undefined;
  const credentials = new RuntimeCredentialEnvironmentManager({
    home,
    ...(outbox.provider === "feishu"
      ? {
          legacy: (options: ConstructorParameters<typeof ImCredentialEnvironmentManager>[0]) =>
            new ImCredentialEnvironmentManager({
              ...options,
              exchangeFeishuToken: async () => "fixture-token",
            }),
        }
      : {}),
    connection: {
      capabilityVersion: () => authority.version,
      send: async (frame) => {
        const request = RuntimeImCredentialGrantRequestSchema.parse(frame);
        requests.push(request);
        const result: RuntimeImCredentialGrantResult = authority.grantRejection
          ? {
              type: "im:credential:result",
              requestId: request.requestId,
              status: "rejected",
              code: authority.grantRejection,
            }
          : {
              type: "im:credential:result",
              requestId: request.requestId,
              status: "succeeded",
              credentialGeneration: 1,
              grant:
                outbox.provider === "slack"
                  ? { provider: "slack", botAccessToken: "fixture-token" }
                  : { provider: "feishu", appId: "fixture-app", appSecret: "fixture-secret", teamBrand: "feishu" },
              ...(authority.version >= 2 ? { outboxContext: outbox } : {}),
            };
        queueMicrotask(() => listener?.(result));
      },
      subscribeBusinessFrames: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      subscribeState: () => () => undefined,
    },
  });
  const admission = new AdmissionController();
  const held = admission.reserve(subject.sessionId, subject.agentId);
  if (!held.accepted) throw new Error("Expected the test reservation");
  held.reservation.markActive();
  let settle!: (outcome: AgentSteerOutcome) => void;
  const outcome = new Promise<AgentSteerOutcome>((resolve) => {
    settle = resolve;
  });
  const steer = vi.fn(async (_input: { expectedRunId: string; input: { items: readonly { text: string }[] } }) => ({
    outcome,
  }));
  const prompt = vi.fn(async () => ({ runId: "callback", status: "completed", output: [] }));
  const runtime = {
    capabilities: { steer: "supported" },
    state: { phase: "running", activeRunId: "im-turn" },
    steer,
    prompt,
    waitForIdle: async () => undefined,
  };
  const inbox = new SessionMessageInbox({
    admission,
    credentialEnvironment: credentials,
    imCredentialGrantVersion: () => authority.version,
    sessionCollaborationVersion: () => 4,
    persistence: new MemoryRuntimeDurabilityStore(),
    reconciler: {
      checkSessionMessageDelivery: () => authority.reason,
      clearActivity: () => true,
      setActivity: () => undefined,
      withAgentLock: async <T>(_agentId: string, task: () => Promise<T>) => task(),
    },
    runtimeManager: {
      ensureRuntime: vi.fn(async () => runtime as never),
      runtime: () => runtime as never,
      sessionKind: () => "visible",
    },
    steerRetryMs: 5,
  });
  const message: SessionMessageDeliveryRequest = {
    type: "session:message:deliver",
    requestId: randomUUID(),
    messageId: randomUUID(),
    sourceSessionId: randomUUID(),
    targetSessionId: subject.sessionId,
    agentId: subject.agentId,
    placementGeneration: subject.placementGeneration,
    content: { kind: "text", text: "child result" },
    runtime: {
      contextTrees: [],
      revision: { agent: { sequence: 1, id: "a".repeat(64) }, session: { sequence: 1, id: "b".repeat(64) } },
      agentId: subject.agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: subject.agentId, mode: "empty_on_create", sharing: "agent" },
    },
  };
  cleanups.push(async () => {
    inbox.stop();
    settle("interrupted");
    held.reservation.release();
    await inbox.settled();
    await credentials.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    authority,
    credentials,
    inbox,
    message,
    outbox,
    prompt,
    release: () => held.reservation.release(),
    requests,
    settle,
    steer,
    subject,
  };
}
