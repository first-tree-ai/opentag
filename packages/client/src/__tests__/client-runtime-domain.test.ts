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
import { type WebSocket, WebSocketServer } from "ws";
import { ClientRuntime } from "../runtime/client-runtime.js";
import { RuntimeConnection } from "../runtime/runtime-connection.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";

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
    const results: Array<Record<string, unknown>> = [];
    let runtime: ClientRuntime;

    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeLegacyAuth(socket, frame);
          return;
        }
        if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          socket.send(JSON.stringify(delivery(earlyDeliveryId, randomUUID(), computerId)));
          return;
        }
        results.push(frame);
        if (frame.type === "im:deliver:result" && frame.deliveryId === earlyDeliveryId) {
          socket.send(JSON.stringify(reconcile(computerId, reconcileRequestId)));
        } else if (frame.type === "session:reconcile:result") {
          socket.send(JSON.stringify(delivery(readyDeliveryId, randomUUID(), computerId)));
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

  constructor(frames: readonly Record<string, unknown>[]) {
    this.#frames = frames;
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

function reconcile(computerId: string, requestId: string) {
  return {
    type: "session:reconcile",
    requestId,
    computerId,
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

function completeLegacyAuth(socket: WebSocket, frame: Record<string, unknown>): void {
  if (frame.protocolVersion !== 1) {
    socket.send(
      JSON.stringify({
        type: "error",
        requestId: frame.requestId,
        code: "PROTOCOL_VERSION_UNSUPPORTED",
        message: "The test Server supports runtime protocol v1 only",
      }),
    );
    socket.close(4400, "Protocol version unsupported");
    return;
  }
  socket.send(
    JSON.stringify({
      type: "auth:result",
      requestId: frame.requestId,
      ok: true,
      workspaceComputerId: randomUUID(),
      workspaceId: randomUUID(),
      computerId: randomUUID(),
    }),
  );
  socket.send(
    JSON.stringify({
      type: "server:welcome",
      protocolVersion: 1,
      capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imCredentialGrant: 1 },
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 2_000,
    }),
  );
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
