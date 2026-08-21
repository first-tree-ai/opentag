import { randomUUID } from "node:crypto";
import {
  type DirectImMessageDeliveryRequest,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  RUNTIME_FINAL_TEXT_MAX_BYTES,
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
import type { SessionBindingStore } from "../runtime/session-binding-store.js";
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
    expect(feishuInput.items[0]?.text).toContain("official lark-cli CLI");
    expect(feishuInput.items[0]?.text).toContain("lark-cli im --help");
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
    teamId: "team-1",
    botUserId: "bot-1",
    channelId: "channel-1",
    messageTs,
  };
}

function credentialEnvironment() {
  return {
    prepare: vi.fn(async () => "/tmp/provider-env.sh"),
    cleanup: vi.fn(async () => undefined),
  };
}
