import { randomUUID } from "node:crypto";
import {
  type DirectImMessageDeliveryRequest,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  RUNTIME_FINAL_TEXT_MAX_BYTES,
  type RuntimeImSteerRequest,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunResult, AgentRuntimeEventSink } from "../agent-runtime/types.js";
import { AgentRuntimeProviderUnavailableError } from "../runtime/agent-runtime-provider-registry.js";
import {
  AgentTurnRunner,
  buildAgentInput,
  completionForError,
  completionForResult,
  turnTimeoutMs,
} from "../runtime/agent-turn-runner.js";
import { ImCredentialEnvironmentError } from "../runtime/im-credential-environment-manager.js";
import type { ImResourceFetcher } from "../runtime/im-resource-fetcher.js";
import type { RecordedSteerInput, SessionBindingStore } from "../runtime/session-binding-store.js";
import { ClientRuntimeProviderStartError, type SessionRuntimeManager } from "../runtime/session-runtime-manager.js";
import type { LiveTurnOwner, TurnCustodyOwner } from "../runtime/turn-custody-owner.js";
import type { TurnReportOwner } from "../runtime/turn-report-owner.js";

describe("AgentTurnRunner", () => {
  it("compiles only dynamic Session, message, history, and resource context into AgentInput", () => {
    const request = delivery();
    request.runtime.instructions.session = "session instructions";
    request.content.history = [
      {
        imMessageId: "message-before",
        occurredAt: "2026-08-20T00:00:00.000Z",
        text: "before",
        providerRef: providerRef("1710000000.000000"),
      },
    ];
    request.content.historyTruncated = true;
    const input = buildAgentInput(request, "resource context");
    expect(input.items.map((item) => item.text)).toEqual([
      expect.stringContaining("Session instructions:\nsession instructions"),
      "hello",
      expect.stringContaining("Bounded prior IM history (truncated):"),
      "resource context",
    ]);
    expect(JSON.stringify(input)).not.toContain(request.runtime.instructions.platform);
    expect(JSON.stringify(input)).not.toContain(request.runtime.instructions.agent);
    expect(input.items[0]?.text).toContain("slack api");
    expect(input.items[0]?.text).toContain('the "user" your underlying agent addresses');
    expect(input.items[0]?.text).toContain("is the OpenTag runtime");
    expect(input.items[0]?.text).toContain("including the text that closes this Turn");
    expect(input.items[0]?.text).toContain("This is your runtime console");
    expect(input.items[0]?.text).toContain("ordinary output is not delivered to the IM participant");
    expect(input.items[0]?.text).not.toContain("as the Turn report");
    expect(input.items[0]?.text).toContain("The IM participant is a separate audience");
    expect(input.items[0]?.text).toContain("The official slack api CLI is your outbox and the only path");
    expect(input.items[0]?.text).toContain("only records it in OpenTag; it does not deliver it");
    expect(input.items[0]?.text).toContain("run the provider CLI command before ending this Turn");
    expect(input.items[0]?.text).toContain("Choosing to take no provider action remains valid");
    expect(input.items[0]?.text).not.toContain("Your final text is not sent to the IM provider automatically");
    expect(input.items[0]?.text).toContain("OpenTag has no message send, reply, or reaction interface");
    expect(input.items[0]?.text).toContain("query the provider before deciding whether to retry");
    expect(input.items[0]?.text).toContain("Attention: direct");
    expect(input.items[0]?.text).toContain(JSON.stringify(request.content.providerRef));
    expect(
      buildAgentInput({ ...request, runtime: { ...request.runtime, instructions: { platform: "p", agent: "a" } } })
        .items[0]?.text,
    ).toContain("No additional Session instructions.");
    expect(
      buildAgentInput({ ...request, content: { ...request.content, historyTruncated: false } }).items[2]?.text,
    ).toContain("Bounded prior IM history:\n");
    const feishuInput = buildAgentInput({
      ...request,
      content: {
        ...request.content,
        providerRef: {
          provider: "feishu",
          teamBrand: "feishu",
          appId: "app-1",
          botOpenId: "bot-1",
          chatId: "chat-1",
          messageId: "message-1",
        },
      },
    });
    expect(feishuInput.items[0]?.text).toContain("The official lark-cli CLI is your outbox and the only path");
    expect(feishuInput.items[0]?.text).toContain("official lark-cli CLI");
    expect(feishuInput.items[0]?.text).toContain("lark-cli im --help");
    expect(feishuInput.items[0]?.text).toContain("never write literal `\\n` sequences for layout");
    expect(feishuInput.items[0]?.text).toContain("two or more literal `\\n` sequences");
    expect(feishuInput.items[0]?.text).toContain(
      "IFS= read -r -d '' OPENTAG_LARK_BODY <<'EOF' || true\nfirst line\n\nsecond line",
    );
    expect(feishuInput.items[0]?.text).toContain("$OpenTagLarkBody = @'\nfirst line\n\nsecond line");
    expect(feishuInput.items[0]?.text).toContain('lark-cli ... --markdown "$OPENTAG_LARK_BODY"');
    expect(input.items[0]?.text).not.toContain("OPENTAG_LARK_BODY");
    expect(() => buildAgentInput(steerRequest())).toThrow("A steer input requires the root runtime snapshot");
  });

  it("preserves ambient attention beside the provider reference without disabling provider credentials", () => {
    const request = { ...delivery(), attention: "ambient" as const };
    const context = buildAgentInput(request).items[0]?.text;
    expect(context).toContain("Attention: ambient");
    expect(context).toContain(JSON.stringify(request.content.providerRef));
    expect(context).toContain("overheard the message");
    expect(context).toContain("avoid meaningless, duplicate, intrusive");
    expect(context).toContain("Attention does not change provider CLI or credential availability");
  });

  it("compiles observer role independently from attention without removing Session credentials", () => {
    const request = { ...delivery(), attention: "ambient" as const, replyRole: "observer" as const };
    const context = buildAgentInput(request).items[0]?.text;
    expect(context).toContain("Attention: ambient");
    expect(context).toContain("Reply role: observer");
    expect(context).toContain("A Thread Session owns the provider reply");
    expect(context).toContain("do not reply, react, or perform any other provider mutation");
    expect(context).toContain("The CLI and credentials remain available");
    expect(context).toContain("does not change this Session's authority or credential availability");

    const ownerContext = buildAgentInput(delivery()).items[0]?.text;
    expect(ownerContext).toContain("Reply role: owner");
    expect(ownerContext).toContain("may reply, react, send another provider message, or take no provider action");
    expect(ownerContext).not.toContain("must reply");
  });

  it("exposes provider-native thread facts without adding a provider reply policy", () => {
    const slackRequest = delivery();
    slackRequest.content.providerRef = {
      ...providerRef("1710000000.000002"),
      threadTs: "1710000000.000001",
    };
    const slackContext = buildAgentInput(slackRequest).items[0]?.text;
    expect(slackContext).toContain(JSON.stringify(slackRequest.content.providerRef));
    expect(slackContext).not.toMatch(/Slack.*(?:must|always|default).*(?:thread|reply)/i);

    const feishuRequest = delivery();
    feishuRequest.content.providerRef = {
      provider: "feishu",
      teamBrand: "feishu",
      appId: "cli_1",
      botOpenId: "ou_bot",
      chatId: "oc_1",
      messageId: "om_reply",
      threadId: "omt_1",
      rootId: "om_root",
      parentId: "om_parent",
    };
    const feishuContext = buildAgentInput(feishuRequest).items[0]?.text;
    expect(feishuContext).toContain(JSON.stringify(feishuRequest.content.providerRef));
    expect(feishuContext).not.toMatch(/Feishu.*(?:must|always|default).*(?:thread|reply)/i);
  });

  it("maps every typed Agent result and abort reason to the stable Turn taxonomy", () => {
    const result = (status: AgentRunResult["status"], overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
      runId: "turn-1",
      status,
      output: [],
      ...overrides,
    });
    expect(completionForResult(result("completed"), undefined)).toEqual({
      outcome: "completed",
      executionEffects: "completed",
    });
    expect(
      completionForResult(
        result("completed", { output: [{ type: "text", text: "answer" }], usage: { outputTokens: 1 } }),
        undefined,
      ),
    ).toEqual({ outcome: "completed", executionEffects: "completed", finalText: "answer", usage: { outputTokens: 1 } });
    expect(
      completionForResult(
        result("completed", { output: [{ type: "text", text: "x".repeat(RUNTIME_FINAL_TEXT_MAX_BYTES + 1) }] }),
        undefined,
      ),
    ).toMatchObject({ outcome: "failed", executionEffects: "completed", errorReason: "output_too_large" });
    for (const status of ["aborted", "cancelled"] as const) {
      expect(completionForResult(result(status, { usage: { inputTokens: 1 } }), undefined)).toMatchObject({
        outcome: "cancelled",
        executionEffects: "may_have_occurred",
        errorReason: "provider_failed",
        usage: { inputTokens: 1 },
      });
    }
    expect(completionForResult(result("aborted"), undefined)).toMatchObject({
      outcome: "cancelled",
      errorReason: "provider_failed",
    });
    expect(
      completionForResult(
        result("failed", { error: { code: "provider_protocol_error", message: "wire" }, usage: { outputTokens: 2 } }),
        undefined,
      ),
    ).toMatchObject({ outcome: "unknown", errorReason: "provider_protocol_error", usage: { outputTokens: 2 } });
    expect(completionForResult(result("failed"), undefined)).toMatchObject({
      outcome: "failed",
      errorReason: "provider_failed",
    });
    expect(
      completionForResult(
        result("failed", { error: { code: "provider_start_failed", message: "did not start" } }),
        undefined,
      ),
    ).toEqual({ outcome: "failed", executionEffects: "not_started", errorReason: "provider_start_failed" });
    for (const mapper of [
      completionForResult.bind(undefined, result("failed")),
      completionForError.bind(undefined, null),
    ]) {
      expect(mapper("client_shutdown")).toMatchObject({ outcome: "cancelled", errorReason: "client_shutdown" });
      expect(mapper("turn_timeout")).toMatchObject({ outcome: "failed", errorReason: "turn_timeout" });
    }
    expect(completionForError(new Error("unknown"), undefined)).toMatchObject({
      outcome: "unknown",
      errorReason: "turn_state_unknown",
    });
    expect(completionForError(new ImCredentialEnvironmentError("credential_stale"), undefined)).toEqual({
      outcome: "failed",
      executionEffects: "not_started",
      errorReason: "credential_unavailable",
    });
    expect(
      completionForError(
        new AgentRuntimeProviderUnavailableError("claude-code", {
          ready: false,
          issues: [{ code: "credential_missing", message: "sign in" }],
        }),
        undefined,
      ),
    ).toEqual({ outcome: "failed", executionEffects: "not_started", errorReason: "credential_unavailable" });
    expect(
      completionForError(
        new AgentRuntimeProviderUnavailableError("claude-code", {
          ready: false,
          issues: [{ code: "artifact_missing", message: "install" }],
        }),
        undefined,
      ),
    ).toEqual({ outcome: "failed", executionEffects: "not_started", errorReason: "provider_start_failed" });
    expect(completionForError(new ClientRuntimeProviderStartError("claude-code"), undefined)).toEqual({
      outcome: "failed",
      executionEffects: "not_started",
      errorReason: "provider_start_failed",
    });
    expect(new AgentRuntimeProviderUnavailableError("claude-code", { ready: false, issues: [] }).message).toContain(
      "not ready",
    );
  });

  it("applies budget/deadline limits and durably reports pre-provider failures", async () => {
    const request = delivery();
    request.runtime.budget = { maxDurationMs: 5_000 };
    request.deadlineAt = "2026-08-20T00:00:03.000Z";
    expect(turnTimeoutMs(request, Date.parse("2026-08-20T00:00:00.000Z"))).toBe(3_000);
    expect(
      turnTimeoutMs({ ...request, deadlineAt: "2026-08-19T00:00:00.000Z" }, Date.parse("2026-08-20T00:00:00.000Z")),
    ).toBe(1);
    expect(
      turnTimeoutMs({ ...request, deadlineAt: undefined, runtime: { ...request.runtime, budget: undefined } }, 0),
    ).toBe(RUNTIME_DEFAULT_MAX_DURATION_MS);

    const create = vi.fn((input) => ({
      ...input,
      type: "turn:report",
      requestId: randomUUID(),
      resultHash: "a".repeat(64),
    }));
    const submit = vi.fn(async () => undefined);
    const markReporting = vi.fn(async () => undefined);
    const runner = new AgentTurnRunner({
      bindingStore: {
        updateUnresolved: vi.fn(async () => {
          throw new Error("disk failed");
        }),
      } as unknown as SessionBindingStore,
      connection: { send: vi.fn(async () => undefined) },
      custody: { markReporting, recordResult: vi.fn() } as unknown as TurnCustodyOwner,
      reportOwner: { create, submit } as unknown as TurnReportOwner,
      runtimeManager: {} as SessionRuntimeManager,
      credentialEnvironment: credentialEnvironment(),
    });
    const owner = liveOwner(request);
    runner.start(owner);
    runner.start(owner);
    expect(runner.activeCount).toBe(1);
    await runner.settled();
    expect(runner.activeCount).toBe(0);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown", errorReason: "turn_state_unknown" }),
    );
    expect(markReporting).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    runner.stop();
    runner.stop();
    runner.start({ ...owner, turnId: "stopped" });
    expect(runner.activeCount).toBe(0);
  });

  it("keeps unresolved custody when the reporting transition fails", async () => {
    let observer: AgentRuntimeEventSink | undefined;
    const onRuntimeEvent = vi.fn(async () => undefined);
    const runner = new AgentTurnRunner({
      bindingStore: { updateUnresolved: vi.fn(async () => undefined) } as unknown as SessionBindingStore,
      connection: { send: vi.fn(async () => undefined) },
      custody: {
        markReporting: vi.fn(async () => {
          throw new Error("custody failed");
        }),
        recordResult: vi.fn(),
      } as unknown as TurnCustodyOwner,
      reportOwner: {
        create: vi.fn((input) => ({
          ...input,
          type: "turn:report",
          requestId: randomUUID(),
          resultHash: "b".repeat(64),
        })),
        submit: vi.fn(),
      } as unknown as TurnReportOwner,
      runtimeManager: {
        ensureRuntime: async () => ({
          prompt: async () => {
            await observer?.({ type: "run_started", runId: "turn-1" });
            await observer?.({
              type: "run_completed",
              runId: "turn-1",
              result: { runId: "turn-1", status: "completed", output: [] },
            });
            return { runId: "turn-1", status: "completed", output: [], usage: { inputTokens: 1 } };
          },
        }),
        cwd: () => "/workspace",
        observe: (_sessionId: string, sink: AgentRuntimeEventSink) => {
          observer = sink;
          return () => {
            observer = undefined;
          };
        },
      } as unknown as SessionRuntimeManager,
      credentialEnvironment: credentialEnvironment(),
      resourceFetcher: { fetchForTurn: vi.fn(async () => "resource") } as unknown as ImResourceFetcher,
      onRuntimeEvent,
    });
    runner.start(liveOwner(delivery()));
    await runner.settled();
    expect(onRuntimeEvent).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable credentials as a recoverable typed failure before Provider execution", async () => {
    const create = vi.fn((input) => ({
      ...input,
      type: "turn:report",
      requestId: randomUUID(),
      resultHash: "d".repeat(64),
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
        ensureRuntime: async () => {
          throw new AgentRuntimeProviderUnavailableError("claude-code", {
            ready: false,
            issues: [{ code: "credential_missing", message: "sign in" }],
          });
        },
      } as unknown as SessionRuntimeManager,
      credentialEnvironment: credentialEnvironment(),
    });

    const request = delivery();
    request.runtime.provider = "claude-code";
    request.runtime.execution.networkAccess = true;
    runner.start(liveOwner(request));
    await runner.settled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        executionEffects: "not_started",
        errorReason: "credential_unavailable",
      }),
    );
  });

  it("aborts an active Provider Run during shutdown", async () => {
    let resolvePrompt!: (result: AgentRunResult) => void;
    const prompt = vi.fn(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const runner = new AgentTurnRunner({
      bindingStore: { updateUnresolved: vi.fn(async () => undefined) } as unknown as SessionBindingStore,
      connection: { send: vi.fn(async () => undefined) },
      custody: {
        markReporting: vi.fn(async () => undefined),
        recordResult: vi.fn(),
      } as unknown as TurnCustodyOwner,
      reportOwner: {
        create: vi.fn((input) => ({
          ...input,
          type: "turn:report",
          requestId: randomUUID(),
          resultHash: "c".repeat(64),
        })),
        submit: vi.fn(async () => undefined),
      } as unknown as TurnReportOwner,
      runtimeManager: {
        ensureRuntime: async () => ({ prompt }),
        cwd: () => "/workspace",
        observe: () => () => undefined,
      } as unknown as SessionRuntimeManager,
      credentialEnvironment: credentialEnvironment(),
    });
    runner.start(liveOwner(delivery()));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    runner.stop();
    resolvePrompt({ runId: "turn-1", status: "aborted", output: [] });
    await runner.settled();
  });

  it("steers only a matching running root and reuses the durable receipt", async () => {
    let resolvePrompt!: (result: AgentRunResult) => void;
    let resolveReporting!: () => void;
    let observer: AgentRuntimeEventSink | undefined;
    let receipt: RecordedSteerInput | undefined;
    let invalidateAfterFetch = false;
    const runtimeState = { phase: "running" as const, activeRunId: "turn-1", queuedRunCount: 0 };
    const capabilities = { steer: "supported" as "supported" | "unsupported", interactions: "unsupported" as const };
    const steer = vi.fn().mockRejectedValueOnce(new Error("steer failed")).mockResolvedValue(undefined);
    const markReporting = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReporting = resolve;
        }),
    );
    const bindingStore = {
      updateUnresolved: vi.fn(async () => undefined),
      getSteerReceipt: vi.fn(async (request: RuntimeImSteerRequest) => {
        if (request.deliveryId === "delivery-conflict") throw new Error("input conflict");
        return receipt?.deliveryId === request.deliveryId ? receipt : undefined;
      }),
      recordSteer: vi.fn(async (request: RuntimeImSteerRequest, inputHash: string) => {
        if (request.deliveryId === "delivery-4") throw new Error("receipt write failed");
        receipt = {
          kind: "steer",
          deliveryId: request.deliveryId,
          inputHash,
          requestId: request.requestId,
          rootDeliveryId: request.rootDeliveryId,
          turnId: request.expectedTurnId,
        };
        return receipt;
      }),
    };
    const runner = new AgentTurnRunner({
      bindingStore: bindingStore as unknown as SessionBindingStore,
      connection: { send: vi.fn(async () => undefined) },
      custody: { markReporting, recordResult: vi.fn() } as unknown as TurnCustodyOwner,
      reportOwner: {
        create: vi.fn((input) => ({
          ...input,
          type: "turn:report",
          requestId: randomUUID(),
          resultHash: "e".repeat(64),
        })),
        submit: vi.fn(async () => undefined),
      } as unknown as TurnReportOwner,
      runtimeManager: {
        ensureRuntime: async () => ({
          capabilities,
          state: runtimeState,
          steer,
          prompt: async () => {
            await observer?.({ type: "run_started", runId: "turn-1" });
            return new Promise<AgentRunResult>((resolve) => {
              resolvePrompt = resolve;
            });
          },
        }),
        cwd: () => "/workspace",
        observe: (_sessionId: string, sink: AgentRuntimeEventSink) => {
          observer = sink;
          return () => {
            observer = undefined;
          };
        },
      } as unknown as SessionRuntimeManager,
      resourceFetcher: {
        fetchForTurn: vi.fn(async () => {
          if (invalidateAfterFetch) {
            invalidateAfterFetch = false;
            runtimeState.activeRunId = "turn-other";
          }
        }),
      } as unknown as ImResourceFetcher,
      credentialEnvironment: credentialEnvironment(),
    });
    const request = steerRequest();
    runner.start(liveOwner(delivery()));
    await expect(runner.steer(request)).resolves.toMatchObject({ status: "retry", reason: "turn_starting" });
    await vi.waitFor(() =>
      expect(bindingStore.updateUnresolved).toHaveBeenCalledWith("agent-1", "session-1", "turn-1", "running"),
    );
    await expect(
      runner.steer({ ...request, requestId: randomUUID(), deliveryId: "delivery-conflict" }),
    ).resolves.toMatchObject({ status: "rejected", reason: "input_conflict" });
    await expect(
      runner.steer({ ...request, requestId: randomUUID(), rootDeliveryId: "delivery-other" }),
    ).resolves.toMatchObject({ status: "rejected", reason: "target_mismatch" });
    capabilities.steer = "unsupported";
    await expect(runner.steer(request)).resolves.toMatchObject({ status: "deferred", reason: "steer_unsupported" });
    capabilities.steer = "supported";
    runtimeState.activeRunId = "turn-other";
    await expect(runner.steer(request)).resolves.toMatchObject({ status: "deferred", reason: "turn_not_running" });
    runtimeState.activeRunId = "turn-1";
    invalidateAfterFetch = true;
    await expect(
      runner.steer({ ...request, requestId: randomUUID(), deliveryId: "delivery-3" }),
    ).resolves.toMatchObject({ status: "deferred", reason: "turn_not_running" });
    runtimeState.activeRunId = "turn-1";
    await expect(runner.steer(request)).resolves.toMatchObject({ status: "deferred", reason: "steer_state_unknown" });
    await expect(
      runner.steer({ ...request, requestId: randomUUID(), deliveryId: "delivery-4" }),
    ).resolves.toMatchObject({ status: "deferred", reason: "steer_state_unknown" });
    const successfulRequest = { ...request, requestId: randomUUID(), deliveryId: "delivery-5" };
    await expect(runner.steer(successfulRequest)).resolves.toMatchObject({
      status: "steered",
      expectedTurnId: "turn-1",
    });
    await expect(runner.steer({ ...successfulRequest, requestId: randomUUID() })).resolves.toMatchObject({
      status: "steered",
    });
    expect(steer).toHaveBeenCalledTimes(3);
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ expectedRunId: "turn-1" }));
    expect(bindingStore.recordSteer).toHaveBeenCalledTimes(2);
    await expect(
      runner.steer({ ...request, requestId: randomUUID(), deliveryId: "delivery-6", expectedTurnId: "turn-other" }),
    ).resolves.toMatchObject({
      status: "deferred",
      reason: "turn_not_running",
    });
    resolvePrompt({ runId: "turn-1", status: "completed", output: [] });
    await vi.waitFor(() => expect(markReporting).toHaveBeenCalledOnce());
    await expect(
      runner.steer({ ...request, requestId: randomUUID(), deliveryId: "delivery-7" }),
    ).resolves.toMatchObject({
      status: "deferred",
      reason: "turn_not_running",
    });
    resolveReporting();
    await runner.settled();
  });
});

function liveOwner(request: DirectImMessageDeliveryRequest): LiveTurnOwner {
  return {
    inputHash: "a".repeat(64),
    request,
    reservation: {} as LiveTurnOwner["reservation"],
    turnId: "turn-1",
  };
}

function delivery(): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: "delivery-1",
    imMessageId: randomUUID(),
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: "hello", providerRef: providerRef("1710000000.000001") },
    runtime: {
      revision: {
        agent: { sequence: 1, id: "agent-revision" },
        session: { sequence: 1, id: "session-revision" },
      },
      agentId: "agent-1",
      provider: "codex",
      instructions: { platform: "platform secret", agent: "agent secret" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    },
  };
}

function providerRef(messageTs: string) {
  return {
    provider: "slack" as const,
    appId: "app-1",
    teamId: "workspace-1",
    botUserId: "bot-1",
    channelId: "channel-1",
    messageTs,
  };
}

function steerRequest(): RuntimeImSteerRequest {
  return {
    type: "im:steer",
    requestId: randomUUID(),
    deliveryId: "delivery-2",
    imMessageId: randomUUID(),
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    rootDeliveryId: "delivery-1",
    expectedTurnId: "turn-1",
    attention: "direct",
    content: { kind: "text", text: "updated direction", providerRef: providerRef("1710000000.000002") },
  };
}

function credentialEnvironment() {
  return {
    prepare: vi.fn(async () => ({ path: "/tmp/provider-env.sh", provider: "slack" as const })),
    cleanup: vi.fn(async () => undefined),
  };
}
