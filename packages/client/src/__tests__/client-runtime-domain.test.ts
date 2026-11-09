import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  EffectiveRuntimeSnapshot,
  RuntimeImSteerRequest,
  SessionMessageDeliveryRequest,
  SessionReconcileRequest,
  SessionReconcileResult,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { AdmissionController } from "../runtime/admission-controller.js";
import { ClientRuntime } from "../runtime/client-runtime.js";
import { RuntimeConnection } from "../runtime/runtime-connection.js";
import { MemoryRuntimeDurabilityStore } from "../runtime/runtime-durability.js";
import { SessionMessageInbox } from "../runtime/session-message-inbox.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";
import { completeAuth, heartbeatResult, registrationResult } from "./support/runtime-server.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((close) => close())));

describe("ClientRuntime domain dispatch", () => {
  it("B-07 dispatches per-session reconcile before accepting delivery", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const computerId = randomUUID();
    const reconcileRequestId = randomUUID();
    const earlyDeliveryId = randomUUID();
    const readyDeliveryId = randomUUID();
    const connectionId = randomUUID();
    const results: Array<Record<string, unknown>> = [];
    let runtime: ClientRuntime;

    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        switch (frame.type) {
          case "auth":
            completeAuth(socket, frame);
            return;
          case "computer:register":
            socket.send(JSON.stringify(registrationResult(frame, connectionId)));
            socket.send(JSON.stringify({ ...delivery(earlyDeliveryId, randomUUID(), computerId), connectionId }));
            return;
          case "heartbeat":
            socket.send(JSON.stringify(heartbeatResult(frame)));
            return;
        }
        results.push(frame);
        if (frame.type === "im:deliver:result" && frame.deliveryId === earlyDeliveryId) {
          socket.send(JSON.stringify({ ...reconcile(computerId, reconcileRequestId), connectionId }));
        } else if (frame.type === "session:reconcile:result") {
          socket.send(JSON.stringify({ ...delivery(readyDeliveryId, randomUUID(), computerId), connectionId }));
        } else if (frame.type === "im:deliver:result" && frame.deliveryId === readyDeliveryId) {
          runtime.stop();
        }
      });
    });

    runtime = new ClientRuntime(
      new RuntimeConnection({
        arch: "arm64",
        clientVersion: "0.0.1",
        computer: { version: 2, computerId, serverUrl: server.url },
        displayName: "workstation",
        instanceId: randomUUID(),
        platform: "darwin",
        machineToken: "machine-token",
      }),
    );
    await runtime.run();

    expect(results).toEqual([
      expect.objectContaining({
        type: "im:deliver:result",
        deliveryId: earlyDeliveryId,
        status: "rejected",
        reason: "session_not_ready",
      }),
      expect.objectContaining({
        type: "session:reconcile:result",
        requestId: reconcileRequestId,
        status: "ready",
      }),
      expect.objectContaining({
        type: "im:deliver:result",
        deliveryId: readyDeliveryId,
        status: "rejected",
        reason: "provider_unavailable",
      }),
    ]);
  });

  it("cancels prepared reconcile state when sending the result fails", async () => {
    const computerId = randomUUID();
    const request = reconcile(computerId, randomUUID()) as SessionReconcileRequest;
    const sendError = new Error("socket unavailable");
    const connection = new FailingResultConnection(computerId, request, sendError);
    const onReconcileResultSendFailed = vi.fn();
    const logs: RecordedLog[] = [];
    const runtime = new ClientRuntime(connection as unknown as RuntimeConnection, {
      logger: recordingLogger(logs, { computerId, instanceId: "instance-1" }),
      onReconcileResultSendFailed,
      prepareReconcileResult: (_request, result) => result,
    });

    await expect(runtime.run()).rejects.toBe(sendError);
    expect(onReconcileResultSendFailed).toHaveBeenCalledOnce();
    expect(onReconcileResultSendFailed).toHaveBeenCalledWith(
      request,
      expect.objectContaining<Partial<SessionReconcileResult>>({
        type: "session:reconcile:result",
        requestId: request.requestId,
      }),
      sendError,
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          agentId: "agent-1",
          instanceId: "instance-1",
          requestId: request.requestId,
          sessionId: "session-1",
        }),
        level: "warn",
        message: "Session reconcile result send failed",
      }),
    );
    expect(JSON.stringify(logs)).not.toContain(sendError.message);
  });

  it("dispatches SessionMessage deliveries and returns typed delivery results", async () => {
    const agentId = randomUUID();
    const delivery = {
      type: "session:message:deliver" as const,
      requestId: randomUUID(),
      messageId: randomUUID(),
      sourceSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      agentId,
      placementGeneration: 1,
      content: { kind: "text" as const, text: "work" },
      runtime: { ...snapshot(), agentId, workspace: { ...snapshot().workspace, workspaceId: agentId } },
    };
    const connection = new FrameConnection([delivery]);
    const handleSessionMessageDelivery = vi.fn((request: SessionMessageDeliveryRequest) => ({
      type: "session:message:deliver:result" as const,
      requestId: request.requestId,
      messageId: request.messageId,
      targetSessionId: request.targetSessionId,
      placementGeneration: request.placementGeneration,
      status: "accepted" as const,
    }));
    const runtime = new ClientRuntime(connection as unknown as RuntimeConnection, {
      handleSessionMessageDelivery,
    });
    await runtime.run();
    expect(handleSessionMessageDelivery).toHaveBeenCalledWith(delivery);
    expect(connection.sent).toContainEqual(
      expect.objectContaining({ type: "session:message:deliver:result", messageId: delivery.messageId }),
    );
  });

  it("waits for the real inbox write and deduplicates a retry after the combined ACK is lost", async () => {
    const frame = messageReconcile();
    const reconciler = new SessionReconciler({ installationId: frame.installationId });
    const { sessionMessage, ...prepare } = frame;
    await reconciler.reconcile({ ...prepare, requestId: randomUUID() });
    const store = new MemoryRuntimeDurabilityStore();
    let failWrite = true;
    const writeStarted = deferred();
    const finishWrite = deferred();
    const write = vi.fn(async (record: Parameters<typeof store.write>[0]) => {
      if (failWrite) throw new Error("disk full");
      writeStarted.resolve();
      await finishWrite.promise;
      await store.write(record);
    });
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: { cleanup: vi.fn(), prepare: vi.fn() },
      imCredentialGrantVersion: () => 2,
      sessionCollaborationVersion: () => 4,
      logger: { warn: vi.fn() },
      persistence: { list: store.list.bind(store), write },
      reconciler,
      runtimeManager: {
        ensureRuntime: vi.fn(),
        isPrepared: () => false,
        sessionKind: () => "internal",
      },
    });
    const options = { reconciler, handleSessionMessageDelivery: inbox.accept.bind(inbox) };
    const failed = new FrameConnection([frame], 1);
    try {
      await new ClientRuntime(failed as unknown as RuntimeConnection, options).run();
      expect(failed.sent).toEqual([
        expect.objectContaining({
          sessionMessage: expect.objectContaining({ status: "rejected", reason: "client_busy" }),
        }),
      ]);
      expect(inbox.getState(sessionMessage.messageId)).toBeUndefined();

      failWrite = false;
      const lost = new FrameConnection([{ ...frame, requestId: randomUUID() }], 1);
      const sendFailure = new Error("connection lost before ACK");
      vi.spyOn(lost, "send").mockRejectedValue(sendFailure);
      const attempt = new ClientRuntime(lost as unknown as RuntimeConnection, options).run();
      const lostAck = expect(attempt).rejects.toBe(sendFailure);
      await writeStarted.promise;
      expect(lost.send).not.toHaveBeenCalled();
      finishWrite.resolve();
      await lostAck;
      expect(inbox.getState(sessionMessage.messageId)).toMatchObject({ status: "accepted" });

      const retry = new FrameConnection([{ ...frame, requestId: randomUUID() }], 1);
      await new ClientRuntime(retry as unknown as RuntimeConnection, options).run();
      expect(retry.sent).toEqual([
        expect.objectContaining({
          sessionMessage: expect.objectContaining({ status: "accepted", messageId: sessionMessage.messageId }),
        }),
      ]);
      expect(write).toHaveBeenCalledTimes(2);
      expect(inbox.pendingCount).toBe(1);
    } finally {
      finishWrite.resolve();
      inbox.stop();
      await inbox.settled();
    }
  });

  it("rechecks a target that changes placement after the warm reconcile", async () => {
    const frame = messageReconcile();
    const reconciler = new SessionReconciler({ installationId: frame.installationId });
    const { sessionMessage: _message, ...prepare } = frame;
    await reconciler.reconcile({ ...prepare, requestId: randomUUID() });
    const connection = new FrameConnection([frame], 1);
    const handleSessionMessageDelivery = vi.fn((request: SessionMessageDeliveryRequest) => ({
      type: "session:message:deliver:result" as const,
      requestId: request.requestId,
      messageId: request.messageId,
      targetSessionId: request.targetSessionId,
      placementGeneration: request.placementGeneration,
      status: "rejected" as const,
      reason: reconciler.checkSessionMessageDelivery(request),
    }));
    await new ClientRuntime(connection as unknown as RuntimeConnection, {
      handleSessionMessageDelivery,
      prepareReconcileResult: async (_request, result) => {
        await reconciler.reconcile({ ...prepare, requestId: randomUUID(), placementGeneration: 2 });
        return result;
      },
      reconciler,
    }).run();
    expect(connection.sent).toEqual([
      expect.objectContaining({
        sessionMessage: expect.objectContaining({ status: "rejected", reason: "stale_generation" }),
      }),
    ]);
  });

  it.each(["cold", "new placement", "new snapshot", "new proof", "retained report", "older Server"] as const)(
    "leaves the inbox to the ordinary delivery frame for %s",
    async (scenario) => {
      const frame = messageReconcile();
      const reconciler = new SessionReconciler({
        installationId: frame.installationId,
        preparation: {
          prepareAgent: vi.fn(),
          prepareSession: vi.fn(),
          requiresSessionPreparation: (request) => request.sessionCliProof?.proofId !== frame.sessionCliProof?.proofId,
          stopSession: vi.fn(),
        },
      });
      const { sessionMessage: _message, ...prepare } = frame;
      if (scenario !== "cold") await reconciler.reconcile({ ...prepare, requestId: randomUUID() });
      const request = { ...frame };
      if (scenario === "new placement") request.placementGeneration += 1;
      if (scenario === "new snapshot") {
        request.runtime = {
          ...request.runtime,
          revision: { ...request.runtime.revision, session: { sequence: 2, id: "session-revision-2" } },
        };
      }
      if (scenario === "new proof") request.sessionCliProof = { ...request.sessionCliProof, proofId: randomUUID() };

      const connection = new FrameConnection(
        [scenario === "older Server" ? prepare : request],
        scenario === "older Server" ? undefined : 1,
      );
      const handleSessionMessageDelivery = vi.fn();
      await new ClientRuntime(connection as unknown as RuntimeConnection, {
        handleSessionMessageDelivery,
        prepareReconcileResult: (_request, result) =>
          scenario !== "retained report"
            ? result
            : {
                ...result,
                retainedReports: [
                  {
                    dispatchRequestId: randomUUID(),
                    deliveryId: "delivery-1",
                    inputHash: "a".repeat(64),
                    turnId: "turn-1",
                    placementGeneration: 1,
                    resultHash: "b".repeat(64),
                  },
                ],
              },
        reconciler,
      }).run();
      expect(handleSessionMessageDelivery).not.toHaveBeenCalled();
      expect(connection.sent).toEqual([expect.objectContaining({ status: "ready" })]);
      if (scenario === "older Server") expect(connection.sent[0]).not.toHaveProperty("sessionMessage");
      else expect(connection.sent[0]).toHaveProperty("sessionMessage", "deferred");
    },
  );

  it("logs a refused Session message with its reason and no content", async () => {
    const agentId = randomUUID();
    const delivery: SessionMessageDeliveryRequest = {
      type: "session:message:deliver",
      requestId: randomUUID(),
      messageId: randomUUID(),
      sourceSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      agentId,
      placementGeneration: 1,
      content: { kind: "text" as const, text: "private work" },
      runtime: { ...snapshot(), agentId, workspace: { ...snapshot().workspace, workspaceId: agentId } },
    };
    const logs: RecordedLog[] = [];
    const runtime = new ClientRuntime(new FrameConnection([delivery]) as unknown as RuntimeConnection, {
      handleSessionMessageDelivery: (request) => ({
        type: "session:message:deliver:result" as const,
        requestId: request.requestId,
        messageId: request.messageId,
        targetSessionId: request.targetSessionId,
        placementGeneration: request.placementGeneration,
        status: "rejected" as const,
        reason: "client_busy" as const,
      }),
      logger: recordingLogger(logs),
    });
    await runtime.run();
    const entry = logs.find((log) => log.message === "Session message rejected");
    expect(entry).toMatchObject({
      level: "warn",
      fields: {
        messageId: delivery.messageId,
        reason: "client_busy",
        scheduled: false,
        sessionId: delivery.targetSessionId,
      },
    });
    expect(JSON.stringify(entry)).not.toContain("private work");
  });

  it("routes Session message outcome results to the outcome reporter", async () => {
    const result = {
      type: "session:message:outcome:result" as const,
      requestId: randomUUID(),
      messageId: randomUUID(),
      status: "notified" as const,
    };
    const connection = new FrameConnection([result]);
    const handleSessionMessageOutcomeResult = vi.fn();
    const runtime = new ClientRuntime(connection as unknown as RuntimeConnection, {
      handleSessionMessageOutcomeResult,
    });
    await runtime.run();
    expect(handleSessionMessageOutcomeResult).toHaveBeenCalledWith(result);
  });

  it("dispatches optional IM steer frames and returns the typed result", async () => {
    const request: RuntimeImSteerRequest = {
      type: "im:steer",
      requestId: randomUUID(),
      deliveryId: randomUUID(),
      imMessageId: randomUUID(),
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 1,
      rootDeliveryId: randomUUID(),
      expectedTurnId: "turn-1",
      attention: "direct",
      content: {
        kind: "text",
        text: "new direction",
        providerRef: {
          provider: "slack",
          appId: "app-1",
          teamId: "workspace-1",
          botUserId: "bot-1",
          channelId: "channel-1",
          messageTs: "1710000000.000002",
        },
      },
    };
    const connection = new FrameConnection([request]);
    const handleSteer = vi.fn(() => ({
      type: "im:steer:result" as const,
      requestId: request.requestId,
      deliveryId: request.deliveryId,
      sessionId: request.sessionId,
      placementGeneration: request.placementGeneration,
      rootDeliveryId: request.rootDeliveryId,
      expectedTurnId: request.expectedTurnId,
      status: "steered" as const,
    }));
    await new ClientRuntime(connection as unknown as RuntimeConnection, { handleSteer }).run();
    expect(handleSteer).toHaveBeenCalledWith(request);
    expect(connection.sent).toEqual([expect.objectContaining({ type: "im:steer:result", status: "steered" })]);
  });

  it("returns a schema-valid deferred result when no IM steer handler is installed", async () => {
    const request: RuntimeImSteerRequest = {
      type: "im:steer",
      requestId: randomUUID(),
      deliveryId: randomUUID(),
      imMessageId: randomUUID(),
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 7,
      rootDeliveryId: randomUUID(),
      expectedTurnId: "turn-1",
      attention: "direct",
      content: {
        kind: "text",
        text: "new direction",
        providerRef: {
          provider: "slack",
          appId: "app-1",
          teamId: "workspace-1",
          botUserId: "bot-1",
          channelId: "channel-1",
          messageTs: "1710000000.000003",
        },
      },
    };
    const connection = new FrameConnection([request]);

    await new ClientRuntime(connection as unknown as RuntimeConnection).run();

    expect(connection.sent).toEqual([
      expect.objectContaining({
        type: "im:steer:result",
        deliveryId: request.deliveryId,
        sessionId: request.sessionId,
        placementGeneration: request.placementGeneration,
        status: "deferred",
        reason: "steer_unsupported",
      }),
    ]);
  });

  it("dispatches runtime metadata without Session reconcile and reports unavailable handlers", async () => {
    const frame = {
      type: "agent-runtime:options",
      requestId: randomUUID(),
      agentId: randomUUID(),
      computerId: randomUUID(),
      provider: "pi",
      model: "custom/model",
    };
    const getRuntimeOptions = vi
      .fn()
      .mockResolvedValue({ modelSuggestions: ["custom/model"], reasoningEffortAllowedValues: ["off", "max"] });
    const connection = new FrameConnection([frame]);
    await new ClientRuntime(connection as unknown as RuntimeConnection, { getRuntimeOptions }).run();
    expect(getRuntimeOptions).toHaveBeenCalledWith(frame, expect.any(AbortSignal));
    expect(connection.sent).toEqual([
      {
        type: "agent-runtime:options:result",
        requestId: frame.requestId,
        result: {
          status: "completed",
          options: { modelSuggestions: ["custom/model"], reasoningEffortAllowedValues: ["off", "max"] },
        },
      },
    ]);
    const unavailable = new FrameConnection([frame]);
    await new ClientRuntime(unavailable as unknown as RuntimeConnection).run();
    expect(unavailable.sent).toEqual([
      {
        type: "agent-runtime:options:result",
        requestId: frame.requestId,
        result: { status: "failed", code: "capability_missing" },
      },
    ]);
  });

  it("dispatches Agent Runtime test results without Session reconcile", async () => {
    const requestId = randomUUID();
    const availabilityTester = {
      run: vi.fn(async () => ({
        type: "agent-runtime:test:result" as const,
        requestId,
        status: "passed" as const,
      })),
    };
    const connection = new FrameConnection([
      {
        type: "agent-runtime:test",
        requestId,
        computerId: randomUUID(),
        provider: "codex",
      },
    ]);
    await new ClientRuntime(connection as unknown as RuntimeConnection, { availabilityTester }).run();
    expect(availabilityTester.run).toHaveBeenCalledOnce();
    expect(connection.sent).toEqual([
      {
        type: "agent-runtime:test:result",
        requestId,
        status: "passed",
      },
    ]);
  });

  it("returns capability_missing when no availability tester is configured", async () => {
    const requestId = randomUUID();
    const connection = new FrameConnection([
      {
        type: "agent-runtime:test",
        requestId,
        computerId: randomUUID(),
        provider: "codex",
      },
    ]);
    await new ClientRuntime(connection as unknown as RuntimeConnection).run();
    expect(connection.sent).toEqual([
      {
        type: "agent-runtime:test:result",
        requestId,
        status: "failed",
        code: "capability_missing",
      },
    ]);
  });

  it("returns provider_failed when the availability tester throws", async () => {
    const requestId = randomUUID();
    const connection = new FrameConnection([
      {
        type: "agent-runtime:test",
        requestId,
        computerId: randomUUID(),
        provider: "claude-code",
      },
    ]);
    await new ClientRuntime(connection as unknown as RuntimeConnection, {
      availabilityTester: {
        run: async () => {
          throw new Error("tester exploded");
        },
      },
    }).run();
    expect(connection.sent).toEqual([
      {
        type: "agent-runtime:test:result",
        requestId,
        status: "failed",
        code: "provider_failed",
      },
    ]);
  });

  it("aborts an in-flight Agent Runtime test on the cancel frame", async () => {
    const requestId = randomUUID();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const availabilityTester = {
      run(_frame: unknown, signal: AbortSignal) {
        started();
        return new Promise<{
          type: "agent-runtime:test:result";
          requestId: string;
          status: "failed";
          code: "cancelled";
        }>((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                type: "agent-runtime:test:result",
                requestId,
                status: "failed",
                code: "cancelled",
              }),
            { once: true },
          );
        });
      },
    };
    let listener: ((frame: Record<string, unknown>) => Promise<void> | void) | undefined;
    const sent: unknown[] = [];
    const connection = {
      computerId: randomUUID(),
      subscribeBusinessFrames(next: (frame: Record<string, unknown>) => Promise<void> | void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      async run() {
        const pending = listener?.({
          type: "agent-runtime:test",
          requestId,
          computerId: randomUUID(),
          provider: "codex",
        });
        await startedPromise;
        await listener?.({ type: "agent-runtime:test:cancel", requestId });
        await pending;
      },
      async send(frame: unknown) {
        sent.push(frame);
      },
      stop() {},
    };
    await new ClientRuntime(connection as unknown as RuntimeConnection, { availabilityTester }).run();
    expect(sent).toEqual([
      {
        type: "agent-runtime:test:result",
        requestId,
        status: "failed",
        code: "cancelled",
      },
    ]);
  });
});

class FrameConnection {
  readonly computerId = randomUUID();
  readonly sent: unknown[] = [];
  readonly #frames: readonly Record<string, unknown>[];
  #listener?: (frame: Record<string, unknown>) => Promise<void> | void;

  constructor(
    frames: readonly Record<string, unknown>[],
    readonly inlineMessageVersion?: number,
  ) {
    this.#frames = frames;
  }

  capabilityVersion(): number | undefined {
    return this.inlineMessageVersion;
  }

  subscribeBusinessFrames(listener: (frame: Record<string, unknown>) => Promise<void> | void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  async run(): Promise<void> {
    for (const frame of this.#frames) await this.#listener?.(frame);
  }

  async send(frame: unknown): Promise<void> {
    this.sent.push(frame);
  }

  stop(): void {}
}

class FailingResultConnection {
  readonly computerId: string;
  readonly #error: Error;
  readonly #request: SessionReconcileRequest;
  #listener?: (frame: Record<string, unknown>) => Promise<void> | void;

  constructor(computerId: string, request: SessionReconcileRequest, error: Error) {
    this.computerId = computerId;
    this.#request = request;
    this.#error = error;
  }

  subscribeBusinessFrames(listener: (frame: Record<string, unknown>) => Promise<void> | void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  async run(): Promise<void> {
    await this.#listener?.(this.#request);
  }

  async send(): Promise<void> {
    throw this.#error;
  }

  stop(): void {}
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function messageReconcile() {
  const creatorSessionId = randomUUID();
  const agentId = randomUUID();
  return {
    ...reconcile(randomUUID(), randomUUID()),
    type: "session:reconcile" as const,
    desired: "ready" as const,
    agentId,
    sessionId: randomUUID(),
    sessionKind: "internal" as const,
    creatorSessionId,
    sessionCliProof: { proofId: randomUUID(), token: "p".repeat(32) },
    runtime: { ...snapshot(), agentId },
    sessionMessage: {
      messageId: randomUUID(),
      sourceSessionId: creatorSessionId,
      content: { kind: "text" as const, text: "work" },
    },
  };
}

function reconcile(installationId: string, requestId: string) {
  return {
    type: "session:reconcile",
    requestId,
    installationId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready",
    runtime: snapshot(),
  };
}

function delivery(deliveryId: string, requestId: string, _computerId: string) {
  return {
    type: "im:deliver",
    requestId,
    deliveryId,
    imMessageId: `message-${deliveryId}`,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "workspace-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000001",
      },
    },
    runtime: snapshot(),
  };
}

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    contextTrees: [],
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId: "agent-1",
    provider: "codex",
    instructions: { platform: "platform", agent: "agent", session: "session" },
    execution: { approvalPolicy: "never", networkAccess: true },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}

async function runtimeServer(): Promise<{ close(): Promise<void>; url: string; wss: WebSocketServer }> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as AddressInfo;
  return {
    wss,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
