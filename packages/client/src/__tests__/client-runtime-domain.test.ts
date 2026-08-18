import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { EffectiveRuntimeSnapshot } from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { AccessTokenProvider } from "../auth/token-provider.js";
import { ClientRuntime } from "../runtime/client-runtime.js";
import { RuntimeConnection } from "../runtime/runtime-connection.js";

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
              capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1 },
              heartbeatIntervalMs: 1_000,
              heartbeatTimeoutMs: 2_000,
            }),
          );
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
});

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
    content: { kind: "text", text: "hello" },
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
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
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
