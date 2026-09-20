import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentRuntimeTestResultFrameSchema,
  AgentTraceBatchSchema,
  AgentTraceEventSchema,
  ClientRuntimeBusinessFrameSchema,
  computeDirectInputHash,
  computeReconcilePayloadHash,
  computeRuntimeImMessageSemanticHash,
  computeRuntimeImSteerInputHash,
  computeRuntimeSnapshotHashes,
  computeTurnResultHash,
  DirectImMessageDeliveryRequestSchema,
  type EffectiveRuntimeSnapshot,
  EffectiveRuntimeSnapshotSchema,
  ImMessageDeliveryResultSchema,
  ProviderCliPrewarmResultFrameSchema,
  ProviderCliValidationGrantFrameSchema,
  ProviderCliValidationRunFrameSchema,
  RUNTIME_DIRECT_TEXT_MAX_BYTES,
  RUNTIME_OUTGOING_REPLY_SNAPSHOT_MAX_BYTES,
  RUNTIME_TRACE_EVENT_MAX_BYTES,
  RuntimeImCredentialGrantResultSchema,
  RuntimeImSteerRequestSchema,
  RuntimeImSteerResultSchema,
  RuntimeProviderMessageRefSchema,
  runtimeUsageTotalTokens,
  ServerRuntimeBusinessFrameSchema,
  SessionMessageDeliveryRequestSchema,
  SessionMessageDeliveryResultSchema,
  SessionReconcileRequestSchema,
  SessionReconcileResultSchema,
  type TurnOutgoingReplySnapshot,
  TurnOutgoingReplySnapshotSchema,
  type TurnReportHashInput,
  type TurnReportRequest,
  TurnReportRequestSchema,
} from "../index.js";

describe("runtime domain contract", () => {
  it("B-01 validates every V0 domain request and result through the public schema surface", () => {
    const runtime = snapshot();
    expect(
      EffectiveRuntimeSnapshotSchema.parse({
        ...runtime,
        provider: "claude-code",
        execution: { approvalPolicy: "never", networkAccess: true },
      }),
    ).toMatchObject({ provider: "claude-code" });
    const reconcile = {
      type: "session:reconcile",
      requestId: randomUUID(),
      installationId: randomUUID(),
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 1,
      desired: "ready",
      runtime,
    } as const;
    expect(ServerRuntimeBusinessFrameSchema.parse(reconcile)).toEqual(reconcile);
    const report = turnReport();
    expect(
      ClientRuntimeBusinessFrameSchema.parse({
        type: "session:reconcile:result",
        requestId: reconcile.requestId,
        sessionId: reconcile.sessionId,
        placementGeneration: 1,
        status: "ready",
        retainedReports: [
          {
            dispatchRequestId: directDelivery(runtime).requestId,
            deliveryId: report.deliveryId,
            inputHash: computeDirectInputHash(directDelivery(runtime)),
            turnId: report.turnId,
            placementGeneration: report.placementGeneration,
            resultHash: report.resultHash,
          },
        ],
      }),
    ).toMatchObject({ status: "ready", retainedReports: [{ turnId: report.turnId }] });

    const delivery = directDelivery(runtime);
    expect(ServerRuntimeBusinessFrameSchema.parse(delivery)).toEqual(delivery);
    expect(
      ClientRuntimeBusinessFrameSchema.parse({
        type: "im:deliver:result",
        requestId: delivery.requestId,
        deliveryId: delivery.deliveryId,
        sessionId: delivery.sessionId,
        placementGeneration: 1,
        status: "accepted",
        turnId: "turn-1",
      }),
    ).toMatchObject({ status: "accepted" });

    expect(
      AgentTraceBatchSchema.parse({
        type: "agent:trace",
        batchId: "batch-1",
        sessionId: "session-1",
        turnId: "turn-1",
        placementGeneration: 1,
        events: [{ kind: "turn_started", sequence: 1, at: "2026-08-18T00:00:00.000Z" }],
      }),
    ).toMatchObject({ type: "agent:trace" });

    expect(ClientRuntimeBusinessFrameSchema.parse(report)).toEqual(report);
    expect(
      ServerRuntimeBusinessFrameSchema.parse({
        type: "turn:report:result",
        requestId: report.requestId,
        turnId: report.turnId,
        status: "recorded",
        resultHash: report.resultHash,
      }),
    ).toMatchObject({ status: "recorded" });
  });

  it("B-02 rejects contradictory discriminated fields", () => {
    const runtime = snapshot();
    expect(() =>
      SessionReconcileRequestSchema.parse({
        type: "session:reconcile",
        requestId: randomUUID(),
        installationId: randomUUID(),
        sessionId: "session-1",
        agentId: "agent-1",
        placementGeneration: 1,
        desired: "ready",
      }),
    ).toThrow();
    expect(() =>
      SessionReconcileRequestSchema.parse({
        type: "session:reconcile",
        requestId: randomUUID(),
        installationId: randomUUID(),
        sessionId: "session-1",
        agentId: "agent-1",
        placementGeneration: 1,
        desired: "stopped",
        runtime,
      }),
    ).toThrow();
    expect(() =>
      ImMessageDeliveryResultSchema.parse({
        type: "im:deliver:result",
        requestId: randomUUID(),
        deliveryId: "delivery-1",
        sessionId: "session-1",
        placementGeneration: 1,
        status: "accepted",
      }),
    ).toThrow();
    expect(() =>
      SessionReconcileResultSchema.parse({
        type: "session:reconcile:result",
        requestId: randomUUID(),
        sessionId: "session-1",
        placementGeneration: 1,
        status: "running",
      }),
    ).toThrow();
    const report = turnReport();
    expect(() =>
      SessionReconcileResultSchema.parse({
        type: "session:reconcile:result",
        requestId: randomUUID(),
        sessionId: report.sessionId,
        placementGeneration: report.placementGeneration,
        status: "rejected",
        reason: "configuration_conflict",
        retainedReports: [
          {
            dispatchRequestId: directDelivery(runtime).requestId,
            deliveryId: report.deliveryId,
            inputHash: computeDirectInputHash(directDelivery(runtime)),
            turnId: report.turnId,
            placementGeneration: report.placementGeneration,
            resultHash: report.resultHash,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      SessionReconcileResultSchema.parse({
        type: "session:reconcile:result",
        requestId: randomUUID(),
        sessionId: report.sessionId,
        placementGeneration: report.placementGeneration,
        status: "ready",
        retainedReports: [
          {
            dispatchRequestId: directDelivery(runtime).requestId,
            deliveryId: report.deliveryId,
            inputHash: computeDirectInputHash(directDelivery(runtime)),
            turnId: report.turnId,
            placementGeneration: report.placementGeneration + 1,
            resultHash: report.resultHash,
          },
        ],
      }),
    ).toThrow();
    expect(() => TurnReportRequestSchema.parse({ ...report, outcome: "failed", errorReason: undefined })).toThrow();
  });

  it("validates IM steer frames, absorbed convergence, and stable semantic identity", () => {
    const delivery = directDelivery(snapshot());
    const steer = {
      type: "im:steer" as const,
      requestId: "33333333-3333-4333-8333-333333333333",
      deliveryId: delivery.deliveryId,
      imMessageId: delivery.imMessageId,
      sessionId: delivery.sessionId,
      agentId: delivery.agentId,
      placementGeneration: delivery.placementGeneration,
      rootDeliveryId: "delivery-root",
      expectedTurnId: "turn-root",
      attention: delivery.attention,
      content: delivery.content,
      deadlineAt: delivery.deadlineAt,
    };
    expect(ServerRuntimeBusinessFrameSchema.parse(steer)).toEqual(steer);
    expect(RuntimeImSteerRequestSchema.parse(steer)).toEqual(steer);
    expect(computeRuntimeImMessageSemanticHash(steer)).toBe(computeRuntimeImMessageSemanticHash(delivery));
    expect(
      computeRuntimeImMessageSemanticHash({
        ...delivery,
        content: {
          ...delivery.content,
          history: [],
          historyTruncated: true,
          resources: [
            {
              imMessageId: delivery.imMessageId,
              ordinal: 0,
              kind: "file",
              availability: "too_large",
            },
          ],
        },
      }),
    ).toBe(computeRuntimeImMessageSemanticHash(steer));
    expect(computeRuntimeImSteerInputHash(steer)).toMatch(/^[a-f0-9]{64}$/);

    const observerDelivery = { ...delivery, replyRole: "observer" as const };
    const observerSteer = { ...steer, replyRole: "observer" as const };
    expect(DirectImMessageDeliveryRequestSchema.parse(observerDelivery)).toEqual(observerDelivery);
    expect(RuntimeImSteerRequestSchema.parse(observerSteer)).toEqual(observerSteer);
    expect(computeDirectInputHash(observerDelivery)).not.toBe(computeDirectInputHash(delivery));
    expect(computeRuntimeImMessageSemanticHash(observerDelivery)).toBe(
      computeRuntimeImMessageSemanticHash(observerSteer),
    );
    expect(computeRuntimeImMessageSemanticHash(observerDelivery)).not.toBe(
      computeRuntimeImMessageSemanticHash(delivery),
    );

    const steered = {
      type: "im:steer:result" as const,
      requestId: steer.requestId,
      deliveryId: steer.deliveryId,
      sessionId: steer.sessionId,
      placementGeneration: steer.placementGeneration,
      rootDeliveryId: steer.rootDeliveryId,
      expectedTurnId: steer.expectedTurnId,
      status: "steered" as const,
    };
    expect(ClientRuntimeBusinessFrameSchema.parse(steered)).toEqual(steered);
    expect(RuntimeImSteerResultSchema.parse({ ...steered, status: "retry", reason: "turn_starting" })).toMatchObject({
      status: "retry",
    });
    expect(() =>
      RuntimeImSteerResultSchema.parse({ ...steered, status: "steered", reason: "turn_starting" }),
    ).toThrow();
    expect(() =>
      RuntimeImSteerResultSchema.parse({ ...steered, status: "deferred", reason: "turn_starting" }),
    ).toThrow();

    expect(
      ImMessageDeliveryResultSchema.parse({
        type: "im:deliver:result",
        requestId: delivery.requestId,
        deliveryId: delivery.deliveryId,
        sessionId: delivery.sessionId,
        placementGeneration: delivery.placementGeneration,
        status: "absorbed",
        rootDeliveryId: steer.rootDeliveryId,
        turnId: steer.expectedTurnId,
      }),
    ).toMatchObject({ status: "absorbed", rootDeliveryId: "delivery-root", turnId: "turn-root" });
  });

  it("B-03 enforces field byte budgets independently from JavaScript string length", () => {
    const valid = directDelivery(snapshot());
    expect(
      DirectImMessageDeliveryRequestSchema.parse({
        ...valid,
        content: { ...valid.content, text: "你".repeat(Math.floor(RUNTIME_DIRECT_TEXT_MAX_BYTES / 3)) },
      }),
    ).toBeDefined();
    expect(() =>
      DirectImMessageDeliveryRequestSchema.parse({
        ...valid,
        content: { ...valid.content, text: `${"你".repeat(Math.floor(RUNTIME_DIRECT_TEXT_MAX_BYTES / 3))}你` },
      }),
    ).toThrow();
    expect(() =>
      EffectiveRuntimeSnapshotSchema.parse({
        ...snapshot(),
        instructions: { platform: "p".repeat(12 * 1024), agent: "a".repeat(12 * 1024), session: "x" },
      }),
    ).toThrow();
  });

  it("B-04/B-05 produces stable golden hashes from fixed tuples", () => {
    const runtime = snapshot();
    const hashes = computeRuntimeSnapshotHashes(runtime);
    expect(hashes).toEqual({
      agentConfigHash: "4ce41622fe0bc78df35784c1a6f409e392f12131075a95e5d15f7eed5f49db46",
      sessionConfigHash: "9b51b9872c3617a33b57b2068500c3c645be5f1ed4662e613101b8c20546eea6",
      effectiveSnapshotHash: "29bb3a2d86ea994d59d05826999f1d5cc722295ae8e8920eea8682adf9656088",
    });
    expect(computeDirectInputHash(directDelivery(runtime))).toBe(
      "20f225978ec879852c0a7ad0c3b401aa73ecef5b2520ce61724507339225733b",
    );
    expect(turnReport().resultHash).toBe("1531ebd9cb35b71727fd8913be9afad9f44e24fb3299ced53716085642e460c9");
    const withReplies = turnReport({
      outgoingReplies: {
        status: "complete",
        replies: [],
      },
    });
    expect(withReplies.resultHash).not.toBe(turnReport().resultHash);
    expect(TurnReportRequestSchema.parse(withReplies)).toEqual(withReplies);
    expect(TurnReportRequestSchema.parse(turnReport()).outgoingReplies).toBeUndefined();
  });

  it("distinguishes a complete zero-send snapshot from absent legacy outgoing replies", () => {
    const empty = TurnOutgoingReplySnapshotSchema.parse({ status: "complete", replies: [] });
    const unavailable = TurnOutgoingReplySnapshotSchema.parse({
      status: "unavailable",
      replies: [],
    });
    expect(empty).toEqual({ status: "complete", replies: [] });
    expect(unavailable.status).toBe("unavailable");
    expect(() =>
      TurnOutgoingReplySnapshotSchema.parse({
        status: "complete",
        replies: [],
        extra: true,
      }),
    ).toThrow();
  });

  it("keeps outgoing hashes stable across JSONB key order but detects changed messages", () => {
    const outgoingReplies: TurnOutgoingReplySnapshot = {
      status: "complete",
      replies: [
        {
          provider: "feishu",
          teamBrand: "lark",
          messageId: "om_1",
          chatId: "oc_1",
          content: {
            msgType: "post",
            post: {
              title: "Title",
              content: [
                [
                  { tag: "text", text: "First" },
                  { tag: "text", text: "Second" },
                ],
              ],
            },
          },
        },
      ],
    };
    const report = turnReport({ outgoingReplies });
    const reordered = JSON.parse(
      JSON.stringify(report, (_key, value: unknown) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
        return Object.fromEntries(Object.entries(value).reverse());
      }),
    );
    expect(TurnReportRequestSchema.parse(reordered).resultHash).toBe(report.resultHash);
    expect(computeTurnResultHash(reordered)).toBe(report.resultHash);
    reordered.outgoingReplies.replies[0].content.post.content[0].reverse();
    expect(computeTurnResultHash(reordered)).not.toBe(report.resultHash);
    expect(() => TurnReportRequestSchema.parse(reordered)).toThrow();
  });

  it("bounds the outgoing-reply snapshot and keeps a receipts-only report hashable", () => {
    const oversized = {
      status: "complete" as const,
      replies: [
        {
          provider: "feishu" as const,
          teamBrand: "lark" as const,
          messageId: "om_1",
          chatId: "oc_1",
          content: {
            msgType: "text" as const,
            text: "x".repeat(RUNTIME_OUTGOING_REPLY_SNAPSHOT_MAX_BYTES),
          },
        },
      ],
    };
    expect(() => TurnOutgoingReplySnapshotSchema.parse(oversized)).toThrow();
    const snapshot: TurnOutgoingReplySnapshot = {
      status: "complete",
      replies: [
        {
          provider: "feishu",
          teamBrand: "lark",
          messageId: "om_1",
          chatId: "oc_1",
          content: { msgType: "text", text: "hello\nworld 你好" },
        },
      ],
    };
    const report = turnReport({ outgoingReplies: snapshot, finalText: undefined });
    expect(TurnReportRequestSchema.parse(report)).toEqual(report);
  });

  it("hashes the reconcile payload from its complete identity tuple", () => {
    const request = {
      type: "session:reconcile" as const,
      requestId: "44444444-4444-4444-8444-444444444444",
      installationId: "55555555-5555-4555-8555-555555555555",
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 2,
      sessionKind: "internal" as const,
      creatorSessionId: "66666666-6666-4666-8666-666666666666",
      desired: "ready" as const,
      runtime: snapshot(),
    };
    expect(computeReconcilePayloadHash(request)).toBe(
      "33f67e7fc87143715afe6adabe52cc79c1dfa2f8f939284e622685e0d9eec310",
    );
    expect(
      computeReconcilePayloadHash({ ...request, installationId: "77777777-7777-4777-8777-777777777777" }),
    ).not.toBe(computeReconcilePayloadHash(request));
    expect(computeReconcilePayloadHash({ ...request, desired: "stopped", runtime: undefined })).toBe(
      "27e33a25c9891fad2b548720db65feb9a61d65655ed54015314995687db7c54f",
    );
  });

  it("B-06 rejects unsafe IDs and sequence boundaries without coercion", () => {
    const valid = directDelivery(snapshot());
    for (const sessionId of ["", "../session", "a/b", "a\\b", "a".repeat(129)]) {
      expect(() => DirectImMessageDeliveryRequestSchema.parse({ ...valid, sessionId })).toThrow();
    }
    for (const placementGeneration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => DirectImMessageDeliveryRequestSchema.parse({ ...valid, placementGeneration })).toThrow();
    }
  });

  it("B-07 counts Provider-native cached input exactly once", () => {
    const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 };
    expect(runtimeUsageTotalTokens("codex", usage)).toBe(14);
    expect(runtimeUsageTotalTokens("claude-code", usage)).toBe(16);
    expect(runtimeUsageTotalTokens("pi", usage)).toBe(16);
    expect(runtimeUsageTotalTokens("codex", {})).toBe(0);
    expect(() =>
      runtimeUsageTotalTokens("claude-code", {
        inputTokens: Number.MAX_SAFE_INTEGER,
        cachedInputTokens: 1,
      }),
    ).toThrow("safe integer range");
  });

  it("validates strict Session message delivery identity and byte bounds", () => {
    const agentId = randomUUID();
    const runtime = { ...snapshot(), agentId };
    const delivery = {
      type: "session:message:deliver" as const,
      requestId: randomUUID(),
      messageId: randomUUID(),
      sourceSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      agentId,
      placementGeneration: 1,
      content: { kind: "text" as const, text: "Done" },
      runtime,
    };
    expect(SessionMessageDeliveryRequestSchema.parse(delivery)).toEqual(delivery);
    expect(() => SessionMessageDeliveryRequestSchema.parse({ ...delivery, agentId: randomUUID() })).toThrow();
    expect(
      SessionMessageDeliveryResultSchema.parse({
        type: "session:message:deliver:result",
        requestId: delivery.requestId,
        messageId: delivery.messageId,
        targetSessionId: delivery.targetSessionId,
        placementGeneration: 1,
        status: "accepted",
      }),
    ).toMatchObject({ status: "accepted" });
    expect(() =>
      SessionMessageDeliveryRequestSchema.parse({
        ...delivery,
        content: { kind: "text", text: `${"你".repeat(Math.floor(RUNTIME_DIRECT_TEXT_MAX_BYTES / 3))}你` },
      }),
    ).toThrow();
  });

  it("accepts optional Slack authorUserId without treating it as required identity", () => {
    const slackRef = {
      provider: "slack" as const,
      appId: "app-1",
      teamId: "workspace-1",
      botUserId: "bot-1",
      channelId: "channel-1",
      messageTs: "1710000000.000001",
    };
    expect(RuntimeProviderMessageRefSchema.parse(slackRef)).toEqual(slackRef);
    expect(RuntimeProviderMessageRefSchema.parse({ ...slackRef, authorUserId: "U_HUMAN" })).toEqual({
      ...slackRef,
      authorUserId: "U_HUMAN",
    });
    expect(() => RuntimeProviderMessageRefSchema.parse({ ...slackRef, authorUserId: "" })).toThrow();
    expect(() =>
      RuntimeProviderMessageRefSchema.parse({
        provider: "feishu",
        teamBrand: "feishu",
        appId: "app-1",
        botOpenId: "bot-1",
        chatId: "chat-1",
        messageId: "message-1",
        authorUserId: "U_HUMAN",
      }),
    ).toThrow();
  });

  it("validates optional v2 outbox context without weakening v1 credential grants", () => {
    const requestId = randomUUID();
    const base = {
      type: "im:credential:result" as const,
      requestId,
      status: "succeeded" as const,
      credentialGeneration: 1,
      grant: { provider: "slack" as const, botAccessToken: "xoxb-secret" },
    };
    expect(RuntimeImCredentialGrantResultSchema.parse(base)).toEqual(base);
    expect(
      RuntimeImCredentialGrantResultSchema.parse({
        ...base,
        outboxContext: {
          provider: "slack",
          sessionKind: "thread",
          channelId: "C1",
          threadTs: "1710000000.000001",
        },
      }),
    ).toMatchObject({ outboxContext: { sessionKind: "thread", channelId: "C1" } });
    expect(() =>
      RuntimeImCredentialGrantResultSchema.parse({
        ...base,
        outboxContext: { provider: "slack", sessionKind: "thread", channelId: "C1" },
      }),
    ).toThrow();
    expect(() =>
      RuntimeImCredentialGrantResultSchema.parse({
        ...base,
        outboxContext: { provider: "feishu", sessionKind: "channel", chatId: "oc_1" },
      }),
    ).toThrow();
  });

  it("validates Agent Runtime test frames without a result or diagnostic payload", () => {
    const requestId = randomUUID();
    const computerId = randomUUID();
    const request = {
      type: "agent-runtime:test" as const,
      requestId,
      computerId,
      provider: "claude-code" as const,
    };
    expect(ServerRuntimeBusinessFrameSchema.parse(request)).toEqual(request);
    expect(
      ServerRuntimeBusinessFrameSchema.parse({
        type: "agent-runtime:test:cancel",
        requestId,
      }),
    ).toEqual({ type: "agent-runtime:test:cancel", requestId });
    expect(() =>
      ServerRuntimeBusinessFrameSchema.parse({
        type: "agent-runtime:test",
        requestId,
        computerId,
        provider: "codex",
        prompt: "override",
      }),
    ).toThrow();
    expect(() =>
      ClientRuntimeBusinessFrameSchema.parse({
        type: "agent-runtime:test:result",
        requestId,
        status: "passed",
      }),
    ).toThrow();
    expect(() =>
      AgentRuntimeTestResultFrameSchema.parse({
        type: "agent-runtime:test:result",
        requestId,
        status: "passed",
        code: "provider_failed",
      }),
    ).toThrow(/forbids a failure code/);
    expect(() =>
      AgentRuntimeTestResultFrameSchema.parse({
        type: "agent-runtime:test:result",
        requestId,
        status: "failed",
      }),
    ).toThrow(/requires a failure code/);
  });
});

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    contextTreeRepository: null,
    revision: {
      agent: { sequence: 3, id: "agent-revision-3" },
      session: { sequence: 7, id: "session-revision-7" },
    },
    agentId: "agent-1",
    provider: "codex",
    model: "gpt-5.6-codex",
    reasoningEffort: "high",
    instructions: { platform: "platform α", agent: "agent β", session: "session γ" },
    execution: { approvalPolicy: "never", networkAccess: true },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    budget: { maxDurationMs: 60_000 },
  };
}

function directDelivery(runtime: EffectiveRuntimeSnapshot) {
  return {
    type: "im:deliver" as const,
    requestId: "11111111-1111-4111-8111-111111111111",
    deliveryId: "delivery-1",
    imMessageId: "message-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct" as const,
    content: {
      kind: "text" as const,
      text: "你好 OpenTag",
      providerRef: {
        provider: "slack" as const,
        appId: "app-1",
        teamId: "workspace-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000001",
      },
    },
    runtime,
    deadlineAt: "2026-08-18T01:00:00.000Z",
  };
}

function turnReport(overrides: Partial<TurnReportHashInput> = {}): TurnReportRequest {
  const { finalText, outgoingReplies, ...rest } = overrides;
  const body: TurnReportHashInput = {
    deliveryId: "delivery-1",
    turnId: "turn-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    outcome: "completed",
    executionEffects: "completed",
    usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 },
    traceSummary: { lastSequence: 5, droppedEvents: 1 },
    ...rest,
    ...(finalText === undefined && "finalText" in overrides ? {} : { finalText: finalText ?? "done ✓" }),
    ...(outgoingReplies !== undefined ? { outgoingReplies } : {}),
  };
  return {
    type: "turn:report",
    requestId: "22222222-2222-4222-8222-222222222222",
    ...body,
    resultHash: computeTurnResultHash(body),
  };
}

it("requires an explicit nullable repository and hashes normalized identity", () => {
  const current = snapshot();
  const { contextTreeRepository: _, ...missing } = current;
  expect(EffectiveRuntimeSnapshotSchema.safeParse(missing).success).toBe(false);
  const off = computeRuntimeSnapshotHashes(current);
  const selected = computeRuntimeSnapshotHashes({ ...current, contextTreeRepository: "Acme/Memory" });
  expect(selected).not.toEqual(off);
  expect(selected).toEqual(computeRuntimeSnapshotHashes({ ...current, contextTreeRepository: "acme/memory" }));
});

/*
 * The remaining runtime-domain branches are all rejection paths of `superRefine` guards. Each case
 * below pins one guard: it builds the smallest frame that should be refused and asserts the specific
 * message, so a guard that stops firing fails here rather than silently accepting a contradictory frame.
 */
describe("runtime domain rejection paths", () => {
  const reconcileBase = () => ({
    type: "session:reconcile" as const,
    requestId: randomUUID(),
    installationId: randomUUID(),
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready" as const,
    runtime: snapshot(),
  });
  const reconcileResult = (overrides: Record<string, unknown>) => ({
    type: "session:reconcile:result" as const,
    requestId: randomUUID(),
    sessionId: "session-1",
    placementGeneration: 1,
    ...overrides,
  });
  const claimant = (report: TurnReportRequest) => ({
    dispatchRequestId: directDelivery(snapshot()).requestId,
    deliveryId: report.deliveryId,
    inputHash: computeDirectInputHash(directDelivery(snapshot())),
    turnId: report.turnId,
    placementGeneration: report.placementGeneration,
    resultHash: report.resultHash,
  });

  it("refuses a reconcile whose runtime belongs to another Agent", () => {
    const request = reconcileBase();
    expect(
      SessionReconcileRequestSchema.safeParse({
        ...request,
        runtime: { ...request.runtime, agentId: "agent-2" },
      }).error?.issues,
    ).toContainEqual(expect.objectContaining({ message: "Agent identity does not match" }));
  });

  it("refuses an internal Session without a creator and a visible one with a creator", () => {
    const request = reconcileBase();
    expect(
      SessionReconcileRequestSchema.safeParse({ ...request, sessionKind: "internal" }).error?.issues,
    ).toContainEqual(expect.objectContaining({ message: "An internal Session requires its creator" }));
    expect(
      SessionReconcileRequestSchema.safeParse({
        ...request,
        creatorSessionId: randomUUID(),
      }).error?.issues,
    ).toContainEqual(expect.objectContaining({ message: "A visible Session forbids a creator" }));
  });

  it("refuses a stopped reconcile that carries a Session CLI proof", () => {
    const request = reconcileBase();
    expect(
      SessionReconcileRequestSchema.safeParse({
        ...request,
        desired: "stopped",
        runtime: undefined,
        sessionCliProof: { proofId: randomUUID(), token: "x".repeat(32) },
      }).error?.issues,
    ).toContainEqual(expect.objectContaining({ message: "A stopped reconcile forbids a Session CLI proof" }));
  });

  it("refuses a reconcile result that reports a successful status with a reason", () => {
    for (const status of ["ready", "stopped"] as const) {
      expect(
        SessionReconcileResultSchema.safeParse(reconcileResult({ status, reason: "turn_in_flight" })).error?.issues,
      ).toContainEqual(expect.objectContaining({ message: "Successful reconcile results cannot include a reason" }));
    }
  });

  it("refuses retained Turn Report claims with duplicate Turn or delivery IDs", () => {
    const report = turnReport();
    const claim = claimant(report);
    const duplicateTurnIds = [claim, { ...claim, dispatchRequestId: randomUUID(), deliveryId: "delivery-2" }];
    expect(
      SessionReconcileResultSchema.safeParse(
        reconcileResult({
          status: "recovery_required",
          turn: { turnId: "turn-1", deliveryId: "delivery-1" },
          retainedReports: duplicateTurnIds,
        }),
      ).error?.issues,
    ).toContainEqual(expect.objectContaining({ message: "Retained Turn Report claims must have unique Turn IDs" }));

    const duplicateDeliveryIds = [claim, { ...claim, dispatchRequestId: randomUUID(), turnId: "turn-2" }];
    expect(
      SessionReconcileResultSchema.safeParse(
        reconcileResult({
          status: "recovery_required",
          turn: { turnId: "turn-1", deliveryId: "delivery-1" },
          retainedReports: duplicateDeliveryIds,
        }),
      ).error?.issues,
    ).toContainEqual(expect.objectContaining({ message: "Retained Turn Report claims must have unique delivery IDs" }));
  });

  it("refuses a trace event and a trace batch that exceed their bounds", () => {
    /*
     * Every field is at its own bound: a 512-byte relative path and a 2 KiB preview of control
     * characters (six JSON bytes each) plus a datetime whose fractional seconds are long but
     * RFC 3339-valid. Only the serialized-event budget is exceeded, which is exactly what this guard
     * is for, and it is reachable without any field breaking its own limit.
     */
    const maximal = {
      kind: "item_completed" as const,
      sequence: Number.MAX_SAFE_INTEGER,
      at: `2026-08-18T00:00:00.${"1".repeat(900)}+14:00`,
      itemType: "agent_message" as const,
      status: "completed" as const,
      path: "\u0001".repeat(512),
      preview: "\u0001".repeat(2_048),
    };
    expect(new TextEncoder().encode(JSON.stringify(maximal)).byteLength).toBeGreaterThan(RUNTIME_TRACE_EVENT_MAX_BYTES);
    expect(AgentTraceEventSchema.safeParse(maximal).error?.issues).toContainEqual(
      expect.objectContaining({ message: "Trace event exceeds the 16 KiB limit" }),
    );

    expect(
      AgentTraceBatchSchema.safeParse({
        type: "agent:trace",
        batchId: "batch-1",
        sessionId: "session-1",
        turnId: "turn-1",
        placementGeneration: 1,
        events: [
          { kind: "turn_started", sequence: 5, at: "2026-08-18T00:00:00.000Z" },
          { kind: "turn_completed", sequence: 5, outcome: "completed", at: "2026-08-18T00:00:01.000Z" },
        ],
      }).error?.issues,
    ).toContainEqual(expect.objectContaining({ message: "Trace sequences must increase" }));
  });

  it("refuses a completed report that carries an error reason", () => {
    const report = turnReport();
    expect(
      TurnReportRequestSchema.safeParse({ ...report, errorReason: "provider_failed" }).error?.issues,
    ).toContainEqual(expect.objectContaining({ message: "Completed reports cannot include an error" }));
  });

  it("refuses duplicate or out-of-order prewarm provider observations", () => {
    const base = {
      type: "provider-cli:prewarm:result" as const,
      requestId: randomUUID(),
      runtime: { provider: "codex" as const, status: "ready" as const },
    };
    expect(
      ProviderCliPrewarmResultFrameSchema.safeParse({
        ...base,
        providers: [
          { provider: "feishu", status: "ready" },
          { provider: "feishu", status: "install" },
        ],
      }).error?.issues,
    ).toContainEqual(expect.objectContaining({ message: "Preparation result providers must be unique" }));

    expect(
      ProviderCliPrewarmResultFrameSchema.safeParse({
        ...base,
        providers: [
          { provider: "slack", status: "ready" },
          { provider: "feishu", status: "ready" },
        ],
      }).error?.issues,
    ).toContainEqual(
      expect.objectContaining({ message: "Preparation result providers must use canonical Provider order" }),
    );
  });

  it("refuses a validation grant or run whose identity and provider disagree", () => {
    const uuid = randomUUID();
    const fence = {
      requestId: uuid,
      provider: "feishu" as const,
      agentId: uuid,
      integrationId: uuid,
      credentialGeneration: 1,
    };
    const slackIdentity = {
      provider: "slack" as const,
      teamId: "T1",
      botUserId: "U1",
      botId: "B1",
    };
    expect(
      ProviderCliValidationGrantFrameSchema.safeParse({
        type: "provider-cli:validation:grant",
        ...fence,
        requirementRequestId: uuid,
        expiresAt: "2026-08-18T01:00:00.000Z",
        expectedIdentity: slackIdentity,
        grant: { provider: "feishu", appId: "a", appSecret: "s", teamBrand: "feishu" },
      }).error?.issues,
    ).toContainEqual(
      expect.objectContaining({ message: "The expected identity provider must match the grant provider" }),
    );
    expect(
      ProviderCliValidationGrantFrameSchema.safeParse({
        type: "provider-cli:validation:grant",
        ...fence,
        requirementRequestId: uuid,
        expiresAt: "2026-08-18T01:00:00.000Z",
        expectedIdentity: { provider: "feishu", appId: "a", botOpenId: "b", teamBrand: "feishu" },
        grant: { provider: "slack", botAccessToken: "xoxb" },
      }).error?.issues,
    ).toContainEqual(expect.objectContaining({ message: "The grant provider must match the frame provider" }));
    expect(
      ProviderCliValidationRunFrameSchema.safeParse({
        type: "provider-cli:validation:run",
        ...fence,
        requirementRequestId: uuid,
        expiresAt: "2026-08-18T01:00:00.000Z",
        expectedIdentity: slackIdentity,
        validationRunId: uuid,
      }).error?.issues,
    ).toContainEqual(
      expect.objectContaining({ message: "The expected identity provider must match the run provider" }),
    );
  });

  it("refuses delivery and Session frames whose runtime names another Agent", () => {
    const delivery = directDelivery(snapshot());
    const mismatched = { ...delivery, runtime: { ...delivery.runtime, agentId: "agent-2" } };
    expect(DirectImMessageDeliveryRequestSchema.safeParse(mismatched).error?.issues).toContainEqual(
      expect.objectContaining({ message: "Agent identity does not match" }),
    );

    const agentId = randomUUID();
    const sessionMessage = {
      type: "session:message:deliver" as const,
      requestId: randomUUID(),
      messageId: randomUUID(),
      sourceSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      agentId,
      placementGeneration: 1,
      content: { kind: "text" as const, text: "Done" },
      runtime: { ...snapshot(), agentId: randomUUID() },
    };
    expect(SessionMessageDeliveryRequestSchema.safeParse(sessionMessage).error?.issues).toContainEqual(
      expect.objectContaining({ message: "Agent identity does not match" }),
    );
  });

  it("refuses an accepted Session delivery result that carries a reason", () => {
    const base = {
      type: "session:message:deliver:result" as const,
      requestId: randomUUID(),
      messageId: randomUUID(),
      targetSessionId: randomUUID(),
      placementGeneration: 1,
    };
    expect(
      SessionMessageDeliveryResultSchema.safeParse({ ...base, status: "accepted", reason: "invalid_input" }).error
        ?.issues,
    ).toContainEqual(expect.objectContaining({ message: "Accepted deliveries forbid a reason" }));
    expect(SessionMessageDeliveryResultSchema.safeParse({ ...base, status: "rejected" }).error?.issues).toContainEqual(
      expect.objectContaining({ message: "Rejected deliveries require a reason" }),
    );
    // The complementary arms stay valid: a bare acceptance and a rejected delivery with its reason.
    expect(SessionMessageDeliveryResultSchema.safeParse({ ...base, status: "accepted" }).success).toBe(true);
    expect(
      SessionMessageDeliveryResultSchema.safeParse({ ...base, status: "rejected", reason: "invalid_input" }).success,
    ).toBe(true);
  });

  it("accepts a validation run whose identity matches the frame provider", () => {
    const uuid = randomUUID();
    expect(
      ProviderCliValidationRunFrameSchema.safeParse({
        type: "provider-cli:validation:run",
        requestId: uuid,
        provider: "feishu",
        agentId: uuid,
        integrationId: uuid,
        credentialGeneration: 1,
        requirementRequestId: uuid,
        expiresAt: "2026-08-18T01:00:00.000Z",
        expectedIdentity: { provider: "feishu", appId: "a", botOpenId: "b", teamBrand: "feishu" },
        validationRunId: uuid,
      }).success,
    ).toBe(true);
  });

  it("refuses an IM history that exceeds its serialized budget", () => {
    const delivery = directDelivery(snapshot());
    const history = Array.from({ length: 3 }, (_, index) => ({
      imMessageId: `message-${index}`,
      occurredAt: "2026-08-18T00:00:00.000Z",
      // Each item is individually inside the 16 KiB direct-text bound.
      text: "x".repeat(RUNTIME_DIRECT_TEXT_MAX_BYTES),
      providerRef: delivery.content.providerRef,
    }));
    expect(new TextEncoder().encode(JSON.stringify(history)).byteLength).toBeGreaterThan(40 * 1024);
    expect(
      DirectImMessageDeliveryRequestSchema.safeParse({ ...delivery, content: { ...delivery.content, history } }).error
        ?.issues,
    ).toContainEqual(expect.objectContaining({ message: "IM history exceeds 40 KiB" }));
  });

  it("hashes an optional reconcile identity that carries no proof and no runtime", () => {
    // The `?? null` arms of the reconcile payload tuple: no session kind, no creator, no proof.
    const bare = {
      type: "session:reconcile" as const,
      requestId: randomUUID(),
      installationId: randomUUID(),
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 1,
      desired: "stopped" as const,
    };
    expect(computeReconcilePayloadHash(bare)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeReconcilePayloadHash({ ...bare, sessionKind: "internal", creatorSessionId: randomUUID() })).not.toBe(
      computeReconcilePayloadHash(bare),
    );
  });

  it("hashes a Turn report with no usage and an IM frame with no deadline", () => {
    const report = turnReport();
    const { usage: _usage, ...withoutUsage } = report;
    expect(computeTurnResultHash(withoutUsage)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeTurnResultHash(withoutUsage)).not.toBe(computeTurnResultHash(report));

    const delivery = directDelivery(snapshot());
    const { deadlineAt: _deadline, ...withoutDeadline } = delivery;
    expect(computeDirectInputHash(withoutDeadline)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeRuntimeImMessageSemanticHash(withoutDeadline)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes a snapshot with no optional session-scoped fields", () => {
    const minimal = {
      ...snapshot(),
      contextTreeRepository: null,
      model: undefined,
      reasoningEffort: undefined,
      instructions: { platform: "platform", agent: "agent" },
      budget: undefined,
    };
    expect(computeRuntimeSnapshotHashes(minimal)).toEqual(computeRuntimeSnapshotHashes(minimal));
    expect(computeRuntimeSnapshotHashes(minimal)).not.toEqual(computeRuntimeSnapshotHashes(snapshot()));
  });
});
