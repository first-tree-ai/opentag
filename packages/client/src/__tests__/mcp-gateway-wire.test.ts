import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  MCP_GATEWAY_PATH,
  negotiateRuntimeCapabilities,
  RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_CAPABILITY_OFFERS,
  RUNTIME_PROVIDER_PROXY_PATH,
  RUNTIME_SERVER_CAPABILITY_OFFERS,
  RuntimeCredentialClientFrameSchema,
  RuntimeMcpGatewayResultSchema,
} from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RuntimeConnection } from "../runtime/runtime-connection.js";
import { RuntimeCredentialRelay } from "../runtime/runtime-credential-relay.js";
import { completeAuth, heartbeatResult, registrationResult } from "./support/runtime-server.js";

/**
 * The MCP gateway contract over a real WebSocket.
 *
 * Every other test on either side of this boundary uses a double: the Server's suites stub the
 * Client and the Client's suites stub the connection. Three things therefore had no coverage at all
 * — that `runtime.mcpGateway` actually negotiates, that the Client actually asks for the `mcp`
 * service on the open frame, and that the `runtime:mcp:gateway` request and result actually survive
 * the wire in both directions.
 *
 * Both ends are checked against the **shared schemas**, which are the wire authority: the fake
 * Server here parses what the Client sent with `RuntimeCredentialClientFrameSchema` and validates
 * its own reply with `RuntimeMcpGatewayResultSchema`, so a frame either side would reject in
 * production fails here too.
 */

/*
 * A production-shaped bearer: `otmg_` plus 32 random bytes as base64url. The wire schema bounds an
 * opaque token at 32..512 bytes, so a short placeholder would be rejected before it proved anything.
 */
const GATEWAY_TOKEN = `otmg_${"a".repeat(43)}`;

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
  /** Every business frame the Client sent, already parsed by the shared client-frame schema. */
  received: Record<string, unknown>[];
  negotiated: Record<string, number>;
}

/**
 * Bring up a real connection and drive the Server side of the credential protocol.
 *
 * `reply` decides how the Server answers the gateway request, so a test can exercise the granted
 * path, a refusal, and a fenceable mismatch without touching the transport.
 */
async function connect(options: {
  grantMcp?: boolean;
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

  /** The control handshake: auth, registration, heartbeats. Nothing here is under test. */
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

  /** The Server's answer to one credential frame, or `undefined` for one it does not drive. */
  const answer = (parsed: { type: string; requestId: string }): Record<string, unknown> | undefined => {
    if (parsed.type === "runtime:execution:open") {
      return {
        type: "runtime:execution:result",
        requestId: parsed.requestId,
        status: "succeeded",
        executionId,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        providers: [],
        ...(options.grantMcp === false ? {} : { services: [{ service: "mcp", scopes: ["mcp:tools"] }] }),
      };
    }
    if (parsed.type === "runtime:proxy:ticket") {
      /*
       * Answered so `open()` can finish. The data channel is a separate transport with its own
       * suites; this one is about the MCP frames, so the ticket is satisfied and the channel stubbed.
       */
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
    if (parsed.type === "runtime:mcp:gateway") {
      const reply = options.reply
        ? options.reply(parsed as unknown as Record<string, unknown>, executionId)
        : {
            type: "runtime:mcp:gateway:result",
            requestId: parsed.requestId,
            status: "succeeded",
            executionId,
            token: GATEWAY_TOKEN,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            path: MCP_GATEWAY_PATH,
          };
      // The Server would never emit a frame its own schema rejects; hold the fake to that too.
      expect(RuntimeMcpGatewayResultSchema.safeParse(reply).success).toBe(true);
      return reply;
    }
    return undefined;
  };

  server.wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (handshake(socket, frame)) return;
      /*
       * `connectionId` is the transport's own fence, stamped on every outbound frame by the Client
       * and stripped before the payload is parsed — the credential schemas are strict and would
       * reject it, exactly as the real Server strips it.
       */
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
  /*
   * `run()` owns the connection for its lifetime, so it is started and left running while the test
   * drives the credential protocol; `whenRegistered()` is the point capabilities are negotiated.
   */
  const running = connection.run().catch((error: unknown) => {
    if (process.env.WIRE_DEBUG) console.log("CONNECTION ENDED:", String(error));
    throw error;
  });
  cleanup.push(async () => {
    connection.stop();
    await running.catch(() => undefined);
  });
  await connection.whenRegistered();
  return { connection, received, negotiated };
}

async function openRelay(wire: Wire, services: readonly ("web" | "mcp")[] = ["mcp"]) {
  return RuntimeCredentialRelay.open(
    {
      connection: wire.connection,
      serverUrl: "https://server.example.test",
      // The data channel is a separate transport with its own suites; stubbed so `open()` completes.
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

describe("capability negotiation", () => {
  /*
   * The capability is what keeps an older peer from ever seeing the `services` field its strict
   * schema would reject. If it failed to negotiate, the whole feature would be silently off.
   */
  it("negotiates runtime.mcpGateway at version 1 over a live connection", async () => {
    const wire = await connect({});
    expect(wire.connection.capabilityVersion(RUNTIME_CAPABILITY.mcpGateway)).toBe(1);
    expect(wire.negotiated[RUNTIME_CAPABILITY.mcpGateway]).toBe(1);
  });

  it("is not a required capability, so an older peer still connects", async () => {
    const wire = await connect({});
    // Connecting at all is the assertion; a required capability the Server lacked would refuse.
    expect(wire.connection.capabilityVersion(RUNTIME_CAPABILITY.runtimeCredential)).toBe(1);
  });
});

describe("the open frame", () => {
  it("carries the mcp service request across the wire", async () => {
    const wire = await connect({});
    await openRelay(wire);
    const open = wire.received.find((frame) => frame.type === "runtime:execution:open");
    expect(open).toBeDefined();
    // Parsed by the shared client-frame schema on the Server side, so this is the real contract.
    expect(open?.services).toEqual(["mcp"]);
  });

  it("carries both services when the Client opted into each", async () => {
    const wire = await connect({});
    await openRelay(wire, ["web", "mcp"]);
    const open = wire.received.find((frame) => frame.type === "runtime:execution:open");
    expect(open?.services).toEqual(["web", "mcp"]);
  });

  it("delivers the granted service back to the relay", async () => {
    const wire = await connect({});
    const relay = await openRelay(wire);
    expect(relay.services).toEqual([{ service: "mcp", scopes: ["mcp:tools"] }]);
  });
});

describe("the gateway token frame", () => {
  it("round-trips a request and its result", async () => {
    const wire = await connect({});
    const relay = await openRelay(wire);
    const granted = await relay.acquireMcpGatewayToken();
    expect(granted?.token).toBe(GATEWAY_TOKEN);
    const request = wire.received.find((frame) => frame.type === "runtime:mcp:gateway");
    expect(request).toBeDefined();
    expect(request?.executionId).toBe(relay.executionId);
  });

  /* The grant is the authorization; without it the Client must not even ask. */
  it("never asks when the Server granted no MCP service", async () => {
    const wire = await connect({ grantMcp: false });
    const relay = await openRelay(wire);
    expect(await relay.acquireMcpGatewayToken()).toBeUndefined();
    expect(wire.received.some((frame) => frame.type === "runtime:mcp:gateway")).toBe(false);
  });

  it("treats a Server refusal as no gateway rather than a failed turn", async () => {
    const wire = await connect({
      reply: (frame) => ({
        type: "runtime:mcp:gateway:result",
        requestId: frame.requestId,
        status: "rejected",
        code: "service_not_granted",
      }),
    });
    const relay = await openRelay(wire);
    expect(await relay.acquireMcpGatewayToken()).toBeUndefined();
  });

  /*
   * A result naming another execution is refused rather than used. The token would be real, but
   * binding it to the wrong execution is exactly the confusion the fence exists to prevent.
   */
  it("refuses a result whose execution does not match", async () => {
    const wire = await connect({
      reply: (frame) => ({
        type: "runtime:mcp:gateway:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: randomUUID(),
        token: GATEWAY_TOKEN,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        path: MCP_GATEWAY_PATH,
      }),
    });
    const relay = await openRelay(wire);
    expect(await relay.acquireMcpGatewayToken()).toBeUndefined();
  });

  /*
   * The path is fixed by the schema itself, so a result naming another one cannot be put on the
   * wire at all — the Client's own path check is defence in depth behind a frame that is
   * unrepresentable. Asserted against the schema rather than through the relay, because there is no
   * way to send the thing the relay would refuse.
   */
  it("makes a result naming a different path unrepresentable", () => {
    const wrongPath = {
      type: "runtime:mcp:gateway:result",
      requestId: randomUUID(),
      status: "succeeded",
      executionId: randomUUID(),
      token: GATEWAY_TOKEN,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      path: "/api/v1/somewhere-else",
    };
    expect(RuntimeMcpGatewayResultSchema.safeParse(wrongPath).success).toBe(false);
    expect(RuntimeMcpGatewayResultSchema.safeParse({ ...wrongPath, path: MCP_GATEWAY_PATH }).success).toBe(true);
  });
});
