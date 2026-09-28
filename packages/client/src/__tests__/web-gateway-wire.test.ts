import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  negotiateRuntimeCapabilities,
  RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_CAPABILITY_OFFERS,
  RUNTIME_PROVIDER_PROXY_PATH,
  RUNTIME_SERVER_CAPABILITY_OFFERS,
  RuntimeCredentialClientFrameSchema,
  RuntimeWebGatewayResultSchema,
} from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RuntimeConnection } from "../runtime/runtime-connection.js";
import { RuntimeCredentialRelay } from "../runtime/runtime-credential-relay.js";
import { completeAuth, heartbeatResult, registrationResult } from "./support/runtime-server.js";

/**
 * The execution web gateway contract over a real WebSocket.
 *
 * The Server's own suites cover the fence and the route; this one covers the wire between: that
 * `runtime.webTools` negotiates, that the Client asks for the `web` service on the open frame, and
 * that the bearer request and its result survive in both directions. Both ends parse with the shared
 * schemas, so a frame either side would reject in production fails here too.
 */

/* A production-shaped bearer: `otwg_` plus 32 random bytes as base64url (the wire minimum is 32). */
const WEB_TOKEN = `otwg_${"w".repeat(43)}`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

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

interface Wire {
  connection: RuntimeConnection;
  received: Record<string, unknown>[];
  negotiated: Record<string, number>;
}

async function connect(options: {
  grantWeb?: boolean;
  reply?: (frame: Record<string, unknown>, executionId: string) => Record<string, unknown>;
}): Promise<Wire> {
  const server = await runtimeServer();
  cleanup.push(server.close);
  const connectionId = randomUUID();
  const executionId = randomUUID();
  const received: Record<string, unknown>[] = [];
  const negotiated = negotiateRuntimeCapabilities(
    RUNTIME_CLIENT_CAPABILITY_OFFERS,
    RUNTIME_SERVER_CAPABILITY_OFFERS,
  ) as Record<string, number>;

  const handshake = (socket: import("ws").WebSocket, frame: Record<string, unknown>): boolean => {
    if (frame.type === "auth") {
      completeAuth(socket, frame);
      return true;
    }
    if (frame.type === "computer:register") {
      socket.send(JSON.stringify(registrationResult(frame, connectionId)));
      return true;
    }
    if (frame.type === "heartbeat") {
      socket.send(JSON.stringify(heartbeatResult(frame)));
      return true;
    }
    return false;
  };

  const answer = (parsed: { type: string; requestId: string }): Record<string, unknown> | undefined => {
    if (parsed.type === "runtime:execution:open") {
      return {
        type: "runtime:execution:result",
        requestId: parsed.requestId,
        status: "succeeded",
        executionId,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        providers: [],
        ...(options.grantWeb === false ? {} : { services: [{ service: "web", scopes: ["web:search", "web:fetch"] }] }),
      };
    }
    if (parsed.type === "runtime:proxy:ticket") {
      return {
        type: "runtime:proxy:ticket:result",
        requestId: parsed.requestId,
        status: "succeeded",
        executionId,
        ticket: `ticket_${"t".repeat(40)}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        path: RUNTIME_PROVIDER_PROXY_PATH,
      };
    }
    if (parsed.type === "runtime:web:gateway") {
      const reply = options.reply
        ? options.reply(parsed as unknown as Record<string, unknown>, executionId)
        : {
            type: "runtime:web:gateway:result",
            requestId: parsed.requestId,
            status: "succeeded",
            executionId,
            token: WEB_TOKEN,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          };
      expect(RuntimeWebGatewayResultSchema.safeParse(reply).success).toBe(true);
      return reply;
    }
    return undefined;
  };

  server.wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (handshake(socket, frame)) return;
      const { connectionId: _fence, ...payload } = frame;
      const parsed = RuntimeCredentialClientFrameSchema.safeParse(payload);
      if (!parsed.success) {
        received.push({ type: "unparseable", frame });
        return;
      }
      received.push(parsed.data as unknown as Record<string, unknown>);
      const reply = answer(parsed.data as unknown as { type: string; requestId: string });
      if (reply) socket.send(JSON.stringify({ connectionId, ...reply }));
    });
  });

  const connection = new RuntimeConnection({
    arch: "arm64",
    clientVersion: "0.0.1",
    computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
    displayName: "workstation",
    instanceId: randomUUID(),
    platform: "darwin",
    machineToken: "machine-token",
  });
  const running = connection.run().catch((error: unknown) => {
    throw error;
  });
  cleanup.push(async () => {
    connection.stop();
    await running.catch(() => undefined);
  });
  await connection.whenRegistered();
  return { connection, received, negotiated };
}

async function openRelay(wire: Wire, services: readonly ("web" | "mcp")[] = ["web"]) {
  return RuntimeCredentialRelay.open(
    {
      connection: wire.connection,
      serverUrl: "https://server.example.test",
      dataConnectionFactory: async () => ({
        closed: false,
        close: async () => undefined,
        openStream: async () => ({}) as never,
        settled: async () => new Promise<void>(() => undefined),
      }),
    },
    {
      agentId: randomUUID(),
      placementGeneration: 1,
      runId: randomUUID(),
      sessionId: randomUUID(),
      source: { kind: "delivery", deliveryId: randomUUID(), turnId: randomUUID() },
      services,
    },
  );
}

describe("web capability negotiation", () => {
  it("negotiates runtime.webTools at version 1 over a live connection", async () => {
    const wire = await connect({});
    expect(wire.connection.capabilityVersion(RUNTIME_CAPABILITY.webTools)).toBe(1);
    expect(wire.negotiated[RUNTIME_CAPABILITY.webTools]).toBe(1);
  });
});

describe("the web gateway token frame", () => {
  it("round-trips a request and its result", async () => {
    const wire = await connect({});
    const relay = await openRelay(wire);
    expect(relay.services).toEqual([{ service: "web", scopes: ["web:search", "web:fetch"] }]);
    const granted = await relay.acquireWebGatewayToken();
    expect(granted?.token).toBe(WEB_TOKEN);
    const request = wire.received.find((frame) => frame.type === "runtime:web:gateway");
    expect(request?.executionId).toBe(relay.executionId);
  });

  it("never asks when the Server granted no web service", async () => {
    const wire = await connect({ grantWeb: false });
    const relay = await openRelay(wire);
    expect(await relay.acquireWebGatewayToken()).toBeUndefined();
    expect(wire.received.some((frame) => frame.type === "runtime:web:gateway")).toBe(false);
  });

  it("treats a Server refusal as no web tools rather than a failed turn", async () => {
    const wire = await connect({
      reply: (frame) => ({
        type: "runtime:web:gateway:result",
        requestId: frame.requestId,
        status: "rejected",
        code: "service_not_granted",
      }),
    });
    const relay = await openRelay(wire);
    expect(await relay.acquireWebGatewayToken()).toBeUndefined();
  });

  it("refuses a result whose execution does not match", async () => {
    const wire = await connect({
      reply: (frame) => ({
        type: "runtime:web:gateway:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: randomUUID(),
        token: WEB_TOKEN,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    });
    const relay = await openRelay(wire);
    expect(await relay.acquireWebGatewayToken()).toBeUndefined();
  });

  it("carries both service requests on one open frame", async () => {
    const wire = await connect({});
    await openRelay(wire, ["web", "mcp"]);
    const open = wire.received.find((frame) => frame.type === "runtime:execution:open");
    expect(open?.services).toEqual(["web", "mcp"]);
  });
});
