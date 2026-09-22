import { describe, expect, it } from "vitest";
import {
  AccountSandboxRunnerAcceptanceRequestSchema,
  RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES,
  RUNNER_CLOUD_TURN_WORKER_STDIN_MAX_BYTES,
  RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES,
  RUNNER_SESSION_COLLABORATION_VERSION,
  RUNNER_WS_MAX_FRAME_BYTES,
  RunnerAcceptanceRunFrameSchema,
  RunnerAuthFrameSchema,
  RunnerClientFrameSchema,
  type RunnerCloudModelGrant,
  RunnerCloudModelGrantSchema,
  RunnerCloudSessionMessageRunFrameSchema,
  RunnerCloudSessionWorkerRequestSchema,
  RunnerCloudTurnWorkerRequestSchema,
  RunnerCloudWorkerRequestSchema,
  RunnerPiConfigInputSchema,
  RunnerServerFrameSchema,
  serializeRunnerAcceptanceWorkerStdin,
  serializeRunnerCloudSessionWorkerStdin,
  serializeRunnerCloudTurnWorkerStdin,
} from "../cloud-runner.js";

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** The frame shape the Server dispatches after the HTTP request was accepted. */
function runFrame(piConfig: { authJson: string; modelsJson?: string; settingsJson?: string }) {
  return {
    type: "acceptance:run" as const,
    requestId: "f".repeat(36),
    mode: "real" as const,
    deadlineAtMs: 1_800_000_000_000,
    piConfig,
  };
}

describe("Runner Pi config wire bounds", () => {
  it("bounds each document by UTF-8 bytes even when the character limit would pass", () => {
    const ascii = JSON.stringify({ token: "a".repeat(30_000) });
    expect(utf8Bytes(ascii)).toBeLessThanOrEqual(RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES);
    expect(RunnerPiConfigInputSchema.safeParse({ authJson: ascii }).success).toBe(true);

    // 11,012 characters (under the 32K character bound) but 33,012 UTF-8 bytes.
    const nonAscii = JSON.stringify({ token: "密钥".repeat(5_500) });
    expect(nonAscii.length).toBeLessThan(32 * 1024);
    expect(utf8Bytes(nonAscii)).toBeGreaterThan(RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES);
    expect(RunnerPiConfigInputSchema.safeParse({ authJson: nonAscii }).success).toBe(false);
  });

  it("bounds the JSON-serialized aggregate including escaping overhead before dispatch", () => {
    // Valid JSON strings: every backslash doubles when the worker stdin document is serialized,
    // so each document passes the per-document bounds while the aggregate does not.
    const escapeHeavy = JSON.stringify("\\".repeat(16_000));
    expect(escapeHeavy.length).toBeLessThanOrEqual(RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES);
    expect(JSON.parse(escapeHeavy)).toHaveLength(16_000);
    const piConfig = { authJson: escapeHeavy, modelsJson: escapeHeavy, settingsJson: escapeHeavy };
    expect(RunnerPiConfigInputSchema.safeParse(piConfig).success).toBe(true);
    const serialized = serializeRunnerAcceptanceWorkerStdin({ mode: "real", piConfig });
    expect(utf8Bytes(serialized)).toBeGreaterThan(RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES);
    expect(AccountSandboxRunnerAcceptanceRequestSchema.safeParse({ mode: "real", piConfig }).success).toBe(false);
    expect(RunnerAcceptanceRunFrameSchema.safeParse(runFrame(piConfig)).success).toBe(false);
  });

  it("accepts non-ASCII and escape-heavy documents that fit every bound", () => {
    const valid = {
      authJson: JSON.stringify({ token: "密钥".repeat(5_000), path: "\\tmp\\\\config" }),
      modelsJson: JSON.stringify({ providers: { deepseek: { models: ["deepseek-chat"] } } }),
      settingsJson: JSON.stringify({ defaultProvider: "deepseek" }),
    };
    expect(utf8Bytes(valid.authJson)).toBeLessThanOrEqual(RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES);
    const serialized = serializeRunnerAcceptanceWorkerStdin({ mode: "real", piConfig: valid });
    expect(utf8Bytes(serialized)).toBeLessThanOrEqual(RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES);
    expect(AccountSandboxRunnerAcceptanceRequestSchema.safeParse({ mode: "real", piConfig: valid }).success).toBe(true);
    const frame = RunnerAcceptanceRunFrameSchema.safeParse(runFrame(valid));
    expect(frame.success).toBe(true);
    expect(frame.success && frame.data.piConfig?.authJson).toBe(valid.authJson);
  });

  it("serializes exactly the worker stdin document shape", () => {
    const piConfig = { authJson: JSON.stringify({ deepseek: { token: "unit" } }) };
    expect(JSON.parse(serializeRunnerAcceptanceWorkerStdin({ mode: "real", piConfig }))).toEqual({
      kind: "acceptance",
      mode: "real",
      piConfig,
    });
    expect(JSON.parse(serializeRunnerAcceptanceWorkerStdin({ mode: "offline" }))).toEqual({
      kind: "acceptance",
      mode: "offline",
    });
  });
});

describe("E4 Cloud delivery protocol", () => {
  it("parses a worst-case issued model grant token inside the 4096-byte wire budget", () => {
    // Worst supported claim lengths: 128-char model, 256-char execution id, two UUIDs + jti.
    const model = "m".repeat(128);
    const executionId = "e".repeat(256);
    const uuid = "12345678-1234-4123-8123-123456789abc";
    const payload = Buffer.from(
      JSON.stringify({
        aud: "opentag-cloud-model",
        exec: executionId,
        exp: 1_900_000_000,
        iat: 1_800_000_000,
        iss: "opentag",
        jti: uuid,
        model,
        sandboxId: uuid,
        sessionId: uuid,
      }),
      "utf8",
    ).toString("base64url");
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
    // HS256 signature is exactly 32 bytes -> 43 base64url characters.
    const worstCaseToken = `${header}.${payload}.${"s".repeat(43)}`;
    expect(Buffer.byteLength(worstCaseToken, "utf8")).toBeLessThan(4096);
    const frame = {
      type: "delivery:verified" as const,
      requestId: "0b12b3c0-0000-4000-8000-000000000001",
      status: "verified" as const,
      model: {
        baseUrl: "https://server.example.com/api/v1/cloud-model",
        expiresAt: new Date(1_900_000_000_000).toISOString(),
        model,
        token: worstCaseToken,
        contextWindow: 258_000 as const,
        maxTokens: 8_192,
      },
    };
    expect(RunnerServerFrameSchema.safeParse(frame).success).toBe(true);
    // The bound is inclusive at 4096 and rejects a single byte more.
    expect(RunnerCloudModelGrantSchema.safeParse({ ...frame.model, token: "t".repeat(4096) }).success).toBe(true);
    expect(RunnerCloudModelGrantSchema.safeParse({ ...frame.model, token: "t".repeat(4097) }).success).toBe(false);
  });

  it("admits only the two Server-selected context windows and a bounded issued output budget", () => {
    const grant = {
      baseUrl: "https://server.example.com/api/v1/cloud-model",
      expiresAt: new Date(1_900_000_000_000).toISOString(),
      model: "model-a",
      token: "t".repeat(64),
      contextWindow: 258_000 as const,
      maxTokens: 8_192,
    };
    expect(RunnerCloudModelGrantSchema.safeParse(grant).success).toBe(true);
    expect(RunnerCloudModelGrantSchema.safeParse({ ...grant, contextWindow: 64_000 }).success).toBe(true);
    // A Runner never re-derives or invents a window: off-tier values are rejected on the wire.
    for (const contextWindow of [63_999, 128_000, 256_000, 262_144, 0, -1, 64_000.5]) {
      expect(RunnerCloudModelGrantSchema.safeParse({ ...grant, contextWindow }).success).toBe(false);
    }
    for (const maxTokens of [8_193, 65_536, 0, -1, 1.5]) {
      expect(RunnerCloudModelGrantSchema.safeParse({ ...grant, maxTokens }).success).toBe(false);
    }
    // A grant without the Server-selected window/budget is not executable.
    const { contextWindow: _contextWindow, ...noWindow } = grant;
    expect(RunnerCloudModelGrantSchema.safeParse(noWindow).success).toBe(false);
    const { maxTokens: _maxTokens, ...noBudget } = grant;
    expect(RunnerCloudModelGrantSchema.safeParse(noBudget).success).toBe(false);
  });

  it("negotiates the Cloud capability as an optional additive auth/welcome field", () => {
    const auth = {
      cloudDeliveryVersion: 1,
      requestId: "0b12b3c0-0000-4000-8000-000000000002",
      token: "bootstrap-token",
      type: "auth" as const,
    };
    expect(RunnerAuthFrameSchema.safeParse(auth).success).toBe(true);
    expect(RunnerClientFrameSchema.safeParse(auth).success).toBe(true);
    // Legacy E3 auth shape stays parseable without the capability.
    expect(
      RunnerAuthFrameSchema.safeParse({
        requestId: auth.requestId,
        token: auth.token,
        type: "auth",
      }).success,
    ).toBe(true);
    const welcome = {
      cloudDeliveryVersion: 1,
      environmentGeneration: 1,
      heartbeatIntervalMs: 15_000,
      heartbeatTimeoutMs: 45_000,
      protocolVersion: 1,
      resourceName: "projects/p/locations/r/instances/ots-s-x",
      resourceUid: "uid-1",
      sandboxId: "0b12b3c0-0000-4000-8000-000000000003",
      sessionId: "0b12b3c0-0000-4000-8000-000000000004",
      type: "server:welcome" as const,
    };
    expect(RunnerServerFrameSchema.safeParse(welcome).success).toBe(true);
    expect(RunnerServerFrameSchema.safeParse({ ...welcome, resourceUid: null }).success).toBe(true);
    // Legacy E3 welcome keeps the exact old shape (no capability/resourceUid).
    const { cloudDeliveryVersion: _capability, resourceUid: _uid, ...legacy } = welcome;
    expect(RunnerServerFrameSchema.safeParse(legacy).success).toBe(true);
  });

  it("carries the allocation-stable Pi continuity directory in the Turn worker document", () => {
    const request = {
      delivery: {
        agentId: "0b12b3c0-0000-4000-8000-000000000005",
        attention: "direct",
        content: {
          kind: "text",
          providerRef: {
            appId: "app",
            botOpenId: "bot",
            chatId: "chat",
            messageId: "msg",
            provider: "feishu",
            teamBrand: "feishu",
          },
          text: "hello",
        },
        deliveryId: "0b12b3c0-0000-4000-8000-000000000006",
        imMessageId: "0b12b3c0-0000-4000-8000-000000000007",
        placementGeneration: 1,
        requestId: "0b12b3c0-0000-4000-8000-000000000008",
        runtime: {
          agentId: "0b12b3c0-0000-4000-8000-000000000005",
          contextTrees: [],
          execution: { approvalPolicy: "never", networkAccess: true },
          instructions: { agent: "Agent.", platform: "Platform." },
          model: "deepseek-v4.1-flash-expires-on-0910",
          provider: "pi",
          revision: {
            agent: { id: "0b12b3c0-0000-4000-8000-000000000009", sequence: 1 },
            session: { id: "0b12b3c0-0000-4000-8000-00000000000a", sequence: 1 },
          },
          workspace: { mode: "empty_on_create", sharing: "agent", workspaceId: "0b12b3c0-0000-4000-8000-00000000000b" },
        },
        sessionId: "0b12b3c0-0000-4000-8000-00000000000c",
        type: "im:deliver" as const,
      },
      executionDir: "/run/opentag-execution/turn-1",
      kind: "turn" as const,
      model: {
        baseUrl: "https://server.example.com/api/v1/cloud-model",
        expiresAt: new Date(1_900_000_000_000).toISOString(),
        model: "deepseek-v4.1-flash-expires-on-0910",
        token: "unit-execution-token-0123456789abcdef",
        contextWindow: 258_000 as const,
        maxTokens: 8_192,
      },
      piSessionDirectory: "/tmp/opentag-cloud-turn/pi-session",
    };
    expect(RunnerCloudTurnWorkerRequestSchema.safeParse(request).success).toBe(true);
    const { piSessionDirectory: _continuity, ...withoutContinuity } = request;
    expect(RunnerCloudTurnWorkerRequestSchema.safeParse(withoutContinuity).success).toBe(true);
  });
});

describe("E8 Session collaboration protocol", () => {
  const uuid = "0b12b3c0-0000-4000-8000-000000000001";
  const sessionMessage = {
    type: "session:message:deliver",
    requestId: uuid,
    messageId: uuid,
    sourceSessionId: "0b12b3c0-0000-4000-8000-000000000002",
    targetSessionId: "0b12b3c0-0000-4000-8000-000000000003",
    agentId: "0b12b3c0-0000-4000-8000-000000000004",
    placementGeneration: 1,
    content: { kind: "text", text: "continue the task" },
    runtime: {
      agentId: "0b12b3c0-0000-4000-8000-000000000004",
      contextTrees: [],
      execution: { approvalPolicy: "never", networkAccess: true },
      instructions: { agent: "Agent.", platform: "Platform." },
      model: "deepseek-v4.1-flash-expires-on-0910",
      provider: "pi",
      revision: {
        agent: { id: "0b12b3c0-0000-4000-8000-000000000005", sequence: 1 },
        session: { id: "0b12b3c0-0000-4000-8000-000000000006", sequence: 1 },
      },
      workspace: { mode: "empty_on_create", sharing: "agent", workspaceId: "0b12b3c0-0000-4000-8000-000000000007" },
    },
  };
  const runFrame = {
    type: "session:message:run" as const,
    requestId: sessionMessage.requestId,
    message: sessionMessage,
  };
  const feishuOutbox = {
    provider: "feishu" as const,
    sessionKind: "channel" as const,
    chatId: "oc_channel",
  };

  it("negotiates Session collaboration as an optional additive auth/welcome field", () => {
    const auth = {
      cloudDeliveryVersion: 1,
      requestId: uuid,
      sessionCollaborationVersion: RUNNER_SESSION_COLLABORATION_VERSION,
      token: "bootstrap-token",
      type: "auth" as const,
    };
    expect(RunnerAuthFrameSchema.safeParse(auth).success).toBe(true);
    expect(RunnerClientFrameSchema.safeParse(auth).success).toBe(true);
    // Legacy E7 auth (no E8 field) keeps parsing unchanged, and a bogus version is rejected.
    const { sessionCollaborationVersion: _capability, ...legacy } = auth;
    expect(RunnerAuthFrameSchema.safeParse(legacy).success).toBe(true);
    expect(RunnerAuthFrameSchema.safeParse({ ...auth, sessionCollaborationVersion: 2 }).success).toBe(false);
    const welcome = {
      cloudDeliveryVersion: 1,
      environmentGeneration: 1,
      heartbeatIntervalMs: 15_000,
      heartbeatTimeoutMs: 45_000,
      protocolVersion: 1,
      resourceName: "projects/p/locations/r/instances/ots-s-x",
      resourceUid: "uid-1",
      sandboxId: "0b12b3c0-0000-4000-8000-000000000008",
      sessionCollaborationVersion: RUNNER_SESSION_COLLABORATION_VERSION,
      sessionId: "0b12b3c0-0000-4000-8000-000000000009",
      type: "server:welcome" as const,
    };
    expect(RunnerServerFrameSchema.safeParse(welcome).success).toBe(true);
    // The E7 welcome shape (no E8 echo) stays parseable; the field is not required.
    const { sessionCollaborationVersion: _echo, ...e7Welcome } = welcome;
    expect(RunnerServerFrameSchema.safeParse(e7Welcome).success).toBe(true);
  });

  it("carries the target role and strictly requires outbox context only for visible Sessions", () => {
    expect(RunnerCloudSessionMessageRunFrameSchema.safeParse({ ...runFrame, sessionKind: "internal" }).success).toBe(
      true,
    );
    // Internal children never receive IM material...
    expect(
      RunnerCloudSessionMessageRunFrameSchema.safeParse({
        ...runFrame,
        outboxContext: feishuOutbox,
        sessionKind: "internal",
      }).success,
    ).toBe(false);
    // ...and a visible target is never dispatched without it.
    expect(RunnerCloudSessionMessageRunFrameSchema.safeParse({ ...runFrame, sessionKind: "visible" }).success).toBe(
      false,
    );
    const visible = { ...runFrame, outboxContext: feishuOutbox, sessionKind: "visible" as const };
    expect(RunnerCloudSessionMessageRunFrameSchema.safeParse(visible).success).toBe(true);
    expect(RunnerServerFrameSchema.safeParse(visible).success).toBe(true);
    // A thread outbox context without a thread reference fails the shared outbox schema.
    expect(
      RunnerCloudSessionMessageRunFrameSchema.safeParse({
        ...visible,
        outboxContext: { ...feishuOutbox, sessionKind: "thread" },
      }).success,
    ).toBe(false);
  });

  it("keeps the worker document union backward compatible and role-accurate", () => {
    const grant = {
      baseUrl: "https://server.example.com/api/v1/cloud-model",
      expiresAt: new Date(1_900_000_000_000).toISOString(),
      model: "deepseek-v4.1-flash-expires-on-0910",
      token: "unit-execution-token-0123456789abcdef",
      contextWindow: 258_000 as const,
      maxTokens: 8_192,
    };
    const sessionWorker = {
      kind: "session-message" as const,
      message: sessionMessage,
      model: grant,
      executionDir: "/run/opentag-execution/turn-1",
      outboxContext: feishuOutbox,
      sessionKind: "visible" as const,
    };
    expect(RunnerCloudSessionWorkerRequestSchema.safeParse(sessionWorker).success).toBe(true);
    expect(RunnerCloudWorkerRequestSchema.safeParse(sessionWorker).success).toBe(true);
    expect(
      RunnerCloudWorkerRequestSchema.safeParse({ ...sessionWorker, outboxContext: undefined, sessionKind: "internal" })
        .success,
    ).toBe(true);
    expect(
      RunnerCloudWorkerRequestSchema.safeParse({ ...sessionWorker, sessionKind: "visible", outboxContext: undefined })
        .success,
    ).toBe(false);
    // The exact E4 Turn worker document stays valid in the union.
    const turnWorker = {
      delivery: {
        agentId: sessionMessage.agentId,
        attention: "direct" as const,
        content: {
          kind: "text" as const,
          providerRef: {
            appId: "app",
            botOpenId: "bot",
            chatId: "chat",
            messageId: "msg",
            provider: "feishu" as const,
            teamBrand: "feishu" as const,
          },
          text: "hello",
        },
        deliveryId: uuid,
        imMessageId: uuid,
        placementGeneration: 1,
        requestId: uuid,
        runtime: sessionMessage.runtime,
        sessionId: sessionMessage.targetSessionId,
        type: "im:deliver" as const,
      },
      executionDir: "/run/opentag-execution/turn-2",
      kind: "turn" as const,
      model: grant,
    };
    expect(RunnerCloudWorkerRequestSchema.safeParse(turnWorker).success).toBe(true);
  });

  it("carries cancellation of journaled Session work as its own frame", () => {
    const cancel = {
      type: "session:message:cancel" as const,
      requestId: uuid,
      messageId: "0b12b3c0-0000-4000-8000-000000000003",
    };
    expect(RunnerServerFrameSchema.safeParse(cancel).success).toBe(true);
  });

  it("acknowledges only an exact terminal settlement and keeps proof fields off verified frames", () => {
    const ack = {
      type: "session:message:settled:ack" as const,
      requestId: uuid,
      messageId: "0b12b3c0-0000-4000-8000-000000000003",
      turnId: "turn-1",
      status: "recorded" as const,
    };
    expect(RunnerServerFrameSchema.safeParse(ack).success).toBe(true);
    expect(RunnerServerFrameSchema.safeParse({ ...ack, status: "accepted" }).success).toBe(false);
    expect(
      RunnerServerFrameSchema.safeParse({
        ...ack,
        requestId: undefined,
      }).success,
    ).toBe(false);

    // Proofs are delivered on the execution open, never on a verified frame: the strict schemas
    // reject any reintroduced field so a legacy Runner can never be sent one unknowingly.
    const proof = { proofId: uuid, token: "unit-session-proof-token-0123456789abcdef" };
    expect(
      RunnerServerFrameSchema.safeParse({
        type: "delivery:verified",
        requestId: uuid,
        status: "verified",
        sessionCliProof: proof,
      }).success,
    ).toBe(false);
    expect(
      RunnerServerFrameSchema.safeParse({
        type: "session:message:verified",
        requestId: uuid,
        status: "verified",
        sessionCliProof: proof,
      }).success,
    ).toBe(false);
  });
});

describe("Runner wire-budget rejections", () => {
  const uuid = "0b12b3c0-0000-4000-8000-000000000001";
  const grant: RunnerCloudModelGrant = {
    baseUrl: "https://server.example.com/api/v1/cloud-model",
    expiresAt: new Date(1_900_000_000_000).toISOString(),
    model: "deepseek-v4.1-flash-expires-on-0910",
    token: "unit-execution-token-0123456789abcdef",
    contextWindow: 258_000 as const,
    maxTokens: 8_192,
  };
  const runtime = {
    agentId: "0b12b3c0-0000-4000-8000-000000000004",
    contextTrees: [],
    execution: { approvalPolicy: "never" as const, networkAccess: true },
    instructions: { agent: "Agent.", platform: "Platform." },
    model: "deepseek-v4.1-flash-expires-on-0910",
    provider: "pi" as const,
    revision: {
      agent: { id: "0b12b3c0-0000-4000-8000-000000000005", sequence: 1 },
      session: { id: "0b12b3c0-0000-4000-8000-000000000006", sequence: 1 },
    },
    workspace: {
      mode: "empty_on_create" as const,
      sharing: "agent" as const,
      workspaceId: "0b12b3c0-0000-4000-8000-000000000007",
    },
  };
  const sessionMessage = {
    type: "session:message:deliver" as const,
    requestId: uuid,
    messageId: uuid,
    sourceSessionId: "0b12b3c0-0000-4000-8000-000000000002",
    targetSessionId: "0b12b3c0-0000-4000-8000-000000000003",
    agentId: runtime.agentId,
    placementGeneration: 1,
    content: { kind: "text" as const, text: "continue the task" },
    runtime,
  };
  const delivery = {
    agentId: runtime.agentId,
    attention: "direct" as const,
    content: {
      kind: "text" as const,
      providerRef: {
        appId: "app",
        botOpenId: "bot",
        chatId: "chat",
        messageId: "msg",
        provider: "feishu" as const,
        teamBrand: "feishu" as const,
      },
      text: "hello",
    },
    deliveryId: uuid,
    imMessageId: uuid,
    placementGeneration: 1,
    requestId: uuid,
    runtime,
    sessionId: sessionMessage.targetSessionId,
    type: "im:deliver" as const,
  };

  /** Text whose JSON-serialized frame clears a 256 KiB budget on its own. */
  const oversizedText = "x".repeat(300 * 1024);
  /**
   * Three documents that each stay inside the per-document bounds but expand sixfold when the frame
   * is serialized (every NUL character becomes `\u0000`), clearing the aggregate frame budget.
   */
  const escapeAmplified = "\u0000".repeat(16_000);

  it("refuses each acceptance request that cannot be dispatched", () => {
    // `real` is meaningless without the Pi configuration it must run.
    expect(AccountSandboxRunnerAcceptanceRequestSchema.safeParse({ mode: "real" }).success).toBe(false);
    // `offline` is the mode that must never carry a credential-bearing config.
    expect(
      AccountSandboxRunnerAcceptanceRequestSchema.safeParse({
        mode: "offline",
        piConfig: { authJson: JSON.stringify({ token: "unit" }) },
      }).success,
    ).toBe(false);
    expect(AccountSandboxRunnerAcceptanceRequestSchema.safeParse({ mode: "offline" }).success).toBe(true);
  });

  it("refuses an acceptance run frame that exceeds the control-channel budget", () => {
    // Each 16K-char document passes the per-document bounds; the serialized frame triples them to
    // 288 KiB because every NUL expands to `\u0000`.
    const frame = {
      type: "acceptance:run" as const,
      requestId: uuid,
      mode: "real" as const,
      deadlineAtMs: 1_800_000_000_000,
      piConfig: { authJson: escapeAmplified, modelsJson: escapeAmplified, settingsJson: escapeAmplified },
    };
    expect(RunnerPiConfigInputSchema.safeParse(frame.piConfig).success).toBe(true);
    expect(utf8Bytes(JSON.stringify(frame))).toBeGreaterThan(RUNNER_WS_MAX_FRAME_BYTES);
    expect(RunnerAcceptanceRunFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("refuses a delivery run frame whose requestId disagrees with the delivery", () => {
    const frame = { type: "delivery:run" as const, requestId: uuid, delivery };
    expect(RunnerServerFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      RunnerServerFrameSchema.safeParse({ ...frame, requestId: "0b12b3c0-0000-4000-8000-00000000000f" }).success,
    ).toBe(false);
  });

  it("refuses a delivery run frame that exceeds the control-channel budget", () => {
    const frame = {
      type: "delivery:run" as const,
      requestId: uuid,
      delivery: {
        ...delivery,
        content: { ...delivery.content, text: oversizedText },
      },
    };
    expect(RunnerServerFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("refuses a session message run frame whose requestId disagrees with the message", () => {
    const frame = {
      type: "session:message:run" as const,
      requestId: uuid,
      message: sessionMessage,
      sessionKind: "internal" as const,
    };
    expect(RunnerServerFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      RunnerServerFrameSchema.safeParse({ ...frame, requestId: "0b12b3c0-0000-4000-8000-00000000000f" }).success,
    ).toBe(false);
  });

  it("refuses a session message run frame that exceeds the control-channel budget", () => {
    const frame = {
      type: "session:message:run" as const,
      requestId: uuid,
      message: { ...sessionMessage, content: { kind: "text" as const, text: oversizedText } },
      sessionKind: "internal" as const,
    };
    expect(RunnerServerFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("refuses worker documents that exceed their stdin budget", () => {
    const oversizedDelivery = { ...delivery, content: { ...delivery.content, text: oversizedText } };
    expect(
      RunnerCloudTurnWorkerRequestSchema.safeParse({ kind: "turn", delivery: oversizedDelivery, model: grant }).success,
    ).toBe(false);
    expect(
      RunnerCloudSessionWorkerRequestSchema.safeParse({
        kind: "session-message",
        message: { ...sessionMessage, content: { kind: "text" as const, text: oversizedText } },
        model: grant,
        executionDir: "/run/opentag-execution/turn-1",
        sessionKind: "internal",
      }).success,
    ).toBe(false);
  });

  it("refuses a Turn worker document that only the serialized form makes oversized", () => {
    // Every document field is individually inside its own bound, but JSON escaping expands each NUL
    // character to six characters, so the worker stdin document clears the 256 KiB budget.
    const nul = "\u0000";
    const historyItem = {
      imMessageId: "m".repeat(64),
      occurredAt: "2024-01-01T00:00:00.000Z",
      text: nul.repeat(5_000),
      providerRef: delivery.content.providerRef,
    };
    const worker = {
      kind: "turn" as const,
      delivery: {
        ...delivery,
        content: { ...delivery.content, history: [historyItem], text: nul.repeat(16_384) },
        runtime: {
          ...runtime,
          instructions: { agent: nul.repeat(12_288), platform: nul.repeat(12_288) },
        },
      },
      model: grant,
      executionDir: "/run/opentag-execution/turn-1",
    };
    expect(utf8Bytes(JSON.stringify(worker))).toBeGreaterThan(RUNNER_CLOUD_TURN_WORKER_STDIN_MAX_BYTES);
    expect(RunnerCloudTurnWorkerRequestSchema.safeParse(worker).success).toBe(false);
  });

  it("refuses a session worker document whose outbox context contradicts its role", () => {
    const worker = {
      kind: "session-message" as const,
      message: sessionMessage,
      model: grant,
      executionDir: "/run/opentag-execution/turn-1",
      outboxContext: { provider: "feishu" as const, sessionKind: "channel" as const, chatId: "oc_channel" },
      sessionKind: "internal" as const,
    };
    expect(RunnerCloudSessionWorkerRequestSchema.safeParse(worker).success).toBe(false);
    expect(RunnerCloudWorkerRequestSchema.safeParse(worker).success).toBe(false);
  });

  it("serializes both worker documents and refuses the oversized ones", () => {
    const turn = serializeRunnerCloudTurnWorkerStdin({
      delivery,
      model: grant,
      executionDir: "/run/opentag-execution/turn-1",
    });
    expect(JSON.parse(turn)).toMatchObject({ kind: "turn", executionDir: "/run/opentag-execution/turn-1" });
    expect(() =>
      serializeRunnerCloudTurnWorkerStdin({
        delivery: { ...delivery, content: { ...delivery.content, text: oversizedText } },
        model: grant,
        executionDir: "/run/opentag-execution/turn-1",
      }),
    ).toThrow(/Turn worker document exceeds its stdin budget/);

    const session = serializeRunnerCloudSessionWorkerStdin({
      message: sessionMessage,
      model: grant,
      executionDir: "/run/opentag-execution/turn-1",
      sessionKind: "internal",
    });
    expect(JSON.parse(session)).toMatchObject({ kind: "session-message", sessionKind: "internal" });
    expect(() =>
      serializeRunnerCloudSessionWorkerStdin({
        message: { ...sessionMessage, content: { kind: "text" as const, text: oversizedText } },
        model: grant,
        executionDir: "/run/opentag-execution/turn-1",
        sessionKind: "internal",
      }),
    ).toThrow(/Session worker document exceeds its stdin budget/);
  });

  it("requires an auth:renewed frame to carry at least one refreshed credential", () => {
    expect(RunnerServerFrameSchema.safeParse({ type: "auth:renewed", token: "next" }).success).toBe(true);
    expect(RunnerServerFrameSchema.safeParse({ type: "auth:renewed", controlToken: "next-control" }).success).toBe(
      true,
    );
    expect(RunnerServerFrameSchema.safeParse({ type: "auth:renewed" }).success).toBe(false);
  });
});
