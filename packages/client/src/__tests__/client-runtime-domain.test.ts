import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { EffectiveRuntimeSnapshot, SessionReconcileRequest, SessionReconcileResult } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { AccessTokenProvider } from "../auth/token-provider.js";
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
        computer: { version: 1, computerId, serverUrl: server.url, userId: randomUUID() },
        displayName: "workstation",
        instanceId: randomUUID(),
        platform: "darwin",
        tokenProvider: tokenProvider(),
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
});

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
        teamId: "team-1",
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

function tokenProvider(): AccessTokenProvider {
  return {
    getAccessTokenLease: async () => ({
      accessToken: "access",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  } as unknown as AccessTokenProvider;
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
      userId: randomUUID(),
      tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
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
