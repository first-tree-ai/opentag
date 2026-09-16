import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { RuntimeCapabilityStore } from "../runtime-credentials/capability-store.js";
import { type RuntimeConnectionFence, RuntimeCredentialBroker } from "../runtime-credentials/credential-broker.js";
import { RuntimeProviderProxyTransport } from "../runtime-credentials/data-transport.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import { UnavailableRuntimeGitHubAdmission } from "../runtime-credentials/github-admission.js";
import type { ProviderProxyAdapter } from "../runtime-credentials/provider-proxy-adapter.js";
import type { RuntimeScopeResolverPort, RuntimeScopeSnapshot } from "../runtime-credentials/scope-resolver.js";
import { RuntimeProxyTicketStore } from "../runtime-credentials/ticket-store.js";
import { runtimeExecutionProviderBinding } from "../runtime-credentials/types.js";

const AGENT = "00000000-0000-4000-8000-0000000000a1";
const COMPUTER = "00000000-0000-4000-8000-0000000000c1";
const BINDING = "00000000-0000-4000-8000-0000000000b1";

function scopeSnapshot(): RuntimeScopeSnapshot {
  return {
    sessionId: "session-1",
    sessionKind: "channel",
    sessionEnded: false,
    channelId: "C1",
    threadKey: null,
    binding: {
      id: BINDING,
      agentId: AGENT,
      provider: "slack",
      status: "active",
      credentialGeneration: 1,
      externalAppId: null,
      externalTeamId: "T",
      externalTeamBrand: null,
      externalBotId: "B",
      slackInstallationId: "00000000-0000-4000-8000-0000000000d1",
    },
    slackInstallation: {
      id: "00000000-0000-4000-8000-0000000000d1",
      agentId: AGENT,
      status: "active",
      credentialGeneration: 1,
      externalTeamId: "T",
      externalBotId: "B",
    },
    agent: {
      id: AGENT,
      status: "active",
      revision: 1,
      computerId: COMPUTER,
      createdByUserId: "00000000-0000-4000-8000-0000000000e1",
    },
    placement: { computerId: COMPUTER, generation: 1 },
    computer: { id: COMPUTER, kind: "local", ownerAccountId: "00000000-0000-4000-8000-0000000000e1" },
    sandbox: null,
  };
}

class MessageQueue {
  readonly #messages: Array<{ binary: boolean; data: Buffer }> = [];
  readonly #waiters: Array<(message: { binary: boolean; data: Buffer }) => void> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      const message = { binary: isBinary, data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer) };
      const waiter = this.#waiters.shift();
      if (waiter) waiter(message);
      else this.#messages.push(message);
    });
  }

  next(timeoutMs = 2_000): Promise<{ binary: boolean; data: Buffer }> {
    const message = this.#messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("Timed out waiting for a proxy frame"));
      }, timeoutMs);
      const waiter = (value: { binary: boolean; data: Buffer }): void => {
        clearTimeout(timer);
        resolve(value);
      };
      this.#waiters.push(waiter);
    });
  }

  async nextJson(): Promise<Record<string, unknown>> {
    const message = await this.next();
    if (message.binary) throw new Error("Expected a JSON frame but received binary data");
    return JSON.parse(message.data.toString("utf8")) as Record<string, unknown>;
  }

  hasMessages(): boolean {
    return this.#messages.length > 0;
  }
}

const servers: WebSocketServer[] = [];
const sockets: WebSocket[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function echoAdapter(): ProviderProxyAdapter {
  return {
    handle: async (request) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request.body) chunks.push(chunk);
      const merged = Buffer.concat(chunks);
      const upper = Buffer.from(merged.toString("utf8").toUpperCase(), "utf8");
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: (async function* () {
          if (upper.byteLength > 0) yield upper;
        })(),
      };
    },
  };
}

async function setup(
  adapter: ProviderProxyAdapter,
  options: {
    connectionFence?: RuntimeConnectionFence;
    brokerConnectionFence?: RuntimeConnectionFence;
    cloud?: boolean;
    cloudControlActive?: () => boolean;
    revalidateIntervalMs?: number;
    capabilityTtlMs?: number;
    chunkMaxBytes?: number;
    initialCreditBytes?: number;
  } = {},
) {
  const executions = new RuntimeExecutionRegistry();
  const capabilities = new RuntimeCapabilityStore(
    options.capabilityTtlMs
      ? { ttlMs: options.capabilityTtlMs, refreshAfterMs: Math.max(1, Math.floor(options.capabilityTtlMs / 2)) }
      : {},
  );
  const tickets = new RuntimeProxyTicketStore();
  const scopeResolverStub: RuntimeScopeResolverPort = {
    load: async () => scopeSnapshot(),
    loadValidationScope: async () => undefined,
    assertExecutionFence: () => undefined,
  };
  const broker = new RuntimeCredentialBroker({
    capabilities,
    executions,
    scopeResolver: scopeResolverStub,
    policy: { authorize: () => "permit" },
    gitHubAdmission: new UnavailableRuntimeGitHubAdmission(),
    materialResolvers: {
      slack: { resolve: async () => ({ kind: "bearer", token: "t", origin: "https://slack.com" }) },
    },
    ...((options.brokerConnectionFence ?? options.connectionFence)
      ? { connectionFence: options.brokerConnectionFence ?? options.connectionFence }
      : {}),
    ...(options.cloudControlActive ? { cloudControlActive: options.cloudControlActive } : {}),
  });
  const record = executions.open({
    runId: randomUUID(),
    accountId: "00000000-0000-4000-8000-0000000000e1",
    agentId: AGENT,
    agentRevision: 1,
    sessionId: "session-1",
    computerId: COMPUTER,
    instanceId: "instance-1",
    connectionId: "connection-1",
    placementGeneration: 1,
    source: { kind: "delivery", deliveryId: "d1", turnId: "t1" },
    purpose: "execution",
    computerKind: options.cloud ? "cloud" : "local",
    ...(options.cloud ? { sandbox: { sandboxId: randomUUID(), resourceUid: "uid-1", environmentGeneration: 1 } } : {}),
    providers: new Map([
      [
        `slack:${BINDING}`,
        runtimeExecutionProviderBinding("slack", BINDING, { provider: "slack", teamId: "T", botUserId: "B" }),
      ],
    ]),
  });
  const grant = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
  if (grant.status !== "succeeded") throw new Error("failed to acquire capability");
  const transport = new RuntimeProviderProxyTransport({
    broker,
    adapters: new Map([["slack", adapter]]),
    tickets,
    executions,
    ...(options.connectionFence ? { connectionFence: options.connectionFence } : {}),
    authTimeoutMs: 150,
    revalidateIntervalMs: options.revalidateIntervalMs ?? 60_000,
    ...(options.chunkMaxBytes !== undefined ? { chunkMaxBytes: options.chunkMaxBytes } : {}),
    ...(options.initialCreditBytes !== undefined ? { initialCreditBytes: options.initialCreditBytes } : {}),
  });
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  server.on("connection", (socket) => transport.attach(socket));
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { port, record, grant, tickets, executions, capabilities, transport, server, broker };
}

async function connect(port: number, ticket: string): Promise<{ socket: WebSocket; queue: MessageQueue }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  const queue = new MessageQueue(socket);
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "auth", ticket }));
  return { socket, queue };
}

function openFrame(streamId: number, capability: string, path = "/api/chat.postMessage"): string {
  return JSON.stringify({
    type: "open",
    streamId,
    capability,
    provider: "slack",
    bindingId: BINDING,
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
  });
}

function binaryFrame(streamId: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(4 + payload.byteLength);
  frame.writeUInt32BE(streamId, 0);
  payload.copy(frame, 4);
  return frame;
}

async function waitForFrame(queue: MessageQueue, type: string, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const message = await queue.next(remaining).catch(() => undefined);
    if (!message) return false;
    if (message.binary) continue;
    if ((JSON.parse(message.data.toString("utf8")) as { type: string }).type === type) return true;
  }
}

async function drainBinaryUntilFrame(queue: MessageQueue, type: string): Promise<number> {
  let bytes = 0;
  for (;;) {
    const message = await queue.next();
    if (message.binary) {
      bytes += message.data.byteLength - 4;
      continue;
    }
    if ((JSON.parse(message.data.toString("utf8")) as { type: string }).type === type) return bytes;
  }
}

describe("RuntimeProviderProxyTransport", () => {
  it("authenticates the first-frame ticket and streams a request/response with credits", async () => {
    const state = await setup(echoAdapter());
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    });
    const { socket, queue } = await connect(state.port, ticket);
    expect(await queue.nextJson()).toEqual({ type: "ready", executionId: state.record.executionId });
    socket.send(openFrame(7, state.grant.token, "/api/chat.postMessage"));
    socket.send(binaryFrame(7, Buffer.from("hello")));
    socket.send(JSON.stringify({ type: "end", streamId: 7 }));
    // The server grants upload credit as it consumes the request body, then answers.
    const credit = await queue.nextJson();
    expect(credit).toEqual({ type: "credit", streamId: 7, bytes: 5 });
    const response = await queue.nextJson();
    expect(response).toMatchObject({ type: "response", streamId: 7, status: 200 });
    const chunk = await queue.next();
    expect(chunk.binary).toBe(true);
    expect(chunk.data.subarray(0, 4).readUInt32BE(0)).toBe(7);
    expect(chunk.data.subarray(4).toString("utf8")).toBe("HELLO");
    expect(await queue.nextJson()).toEqual({ type: "end", streamId: 7 });
    socket.close();
  });

  it("rejects a ticket replay and a bad ticket", async () => {
    const state = await setup(echoAdapter());
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    });
    await connect(state.port, ticket);
    const replay = new WebSocket(`ws://127.0.0.1:${state.port}`);
    sockets.push(replay);
    await once(replay, "open");
    replay.send(JSON.stringify({ type: "auth", ticket }));
    const [code] = (await once(replay, "close")) as [number, string];
    expect(code).toBe(4401);

    const bad = new WebSocket(`ws://127.0.0.1:${state.port}`);
    sockets.push(bad);
    await once(bad, "open");
    bad.send(JSON.stringify({ type: "auth", ticket: "x".repeat(64) }));
    const [badCode] = (await once(bad, "close")) as [number, string];
    expect(badCode).toBe(4401);
  });

  it("closes the connection when no auth frame arrives", async () => {
    const state = await setup(echoAdapter());
    const socket = new WebSocket(`ws://127.0.0.1:${state.port}`);
    sockets.push(socket);
    await once(socket, "open");
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4401);
  });

  it("fails closed on oversize headers, oversize binary, credit overflow, and unknown streams", async () => {
    const state = await setup(echoAdapter());
    const cases: Array<(socket: WebSocket) => void> = [
      (socket) => socket.send("x".repeat(16 * 1024 + 1)),
      (socket) => socket.send(binaryFrame(1, Buffer.alloc(65_537))),
      (socket) => {
        socket.send(openFrame(1, state.grant.token));
        socket.send(JSON.stringify({ type: "credit", streamId: 1, bytes: 3 * 1_048_576 }));
      },
      (socket) => socket.send(binaryFrame(42, Buffer.from("no-stream"))),
    ];
    for (const run of cases) {
      const { ticket } = state.tickets.issue({
        executionId: state.record.executionId,
        computerId: COMPUTER,
        instanceId: "instance-1",
        connectionId: "connection-1",
      });
      const { socket, queue } = await connect(state.port, ticket);
      await queue.nextJson();
      run(socket);
      const [code] = (await once(socket, "close")) as [number, string];
      expect(code).toBe(4400);
    }
  });

  it("rejects a reused stream id", async () => {
    const state = await setup(echoAdapter());
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    });
    const { socket, queue } = await connect(state.port, ticket);
    await queue.nextJson();
    socket.send(openFrame(3, state.grant.token));
    socket.send(openFrame(3, state.grant.token));
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4400);
  });

  it("bounds concurrent streams per execution", async () => {
    const state = await setup(echoAdapter());
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    });
    const { socket, queue } = await connect(state.port, ticket);
    await queue.nextJson();
    for (let streamId = 1; streamId <= 9; streamId += 1) socket.send(openFrame(streamId, state.grant.token));
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4400);
  });

  it("honors the credit window for long streaming responses", async () => {
    const chunk = Buffer.alloc(65_536, 0x61);
    const adapter: ProviderProxyAdapter = {
      handle: async () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: (async function* () {
          for (let index = 0; index < 20; index += 1) yield chunk;
        })(),
      }),
    };
    const state = await setup(adapter);
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    });
    const { socket, queue } = await connect(state.port, ticket);
    await queue.nextJson();
    socket.send(openFrame(1, state.grant.token));
    const response = await queue.nextJson();
    expect(response.type).toBe("response");
    let received = 0;
    let ended = false;
    // Without granting credit the server must stop at the initial window and never flood.
    await new Promise((resolve) => setTimeout(resolve, 150));
    while (queue.hasMessages()) {
      const message = await queue.next();
      if (message.binary) received += message.data.byteLength - 4;
      else if (JSON.parse(message.data.toString("utf8")).type === "end") ended = true;
    }
    expect(received).toBe(1_048_576);
    expect(ended).toBe(false);
    for (let index = 0; index < 8; index += 1) {
      socket.send(JSON.stringify({ type: "credit", streamId: 1, bytes: 65_536 }));
    }
    received += await drainBinaryUntilFrame(queue, "end");
    expect(received).toBe(20 * 65_536);
    socket.close();
  });

  it("cancels a stream without closing the connection and aborts upstream work", async () => {
    let aborted = false;
    const adapter: ProviderProxyAdapter = {
      handle: async (request) => {
        request.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          status: 200,
          headers: { "content-type": "text/plain" },
          body: (async function* () {
            for (;;) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              yield Buffer.from("tick");
            }
          })(),
        };
      },
    };
    const state = await setup(adapter);
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    });
    const { socket, queue } = await connect(state.port, ticket);
    await queue.nextJson();
    socket.send(openFrame(5, state.grant.token));
    expect((await queue.nextJson()).type).toBe("response");
    socket.send(JSON.stringify({ type: "cancel", streamId: 5, code: "cancelled" }));
    // The connection stays usable: a fresh stream can open on the same socket.
    socket.send(openFrame(6, state.grant.token));
    expect(await queue.nextJson()).toMatchObject({ type: "response", streamId: 6 });
    await vi.waitFor(() => expect(aborted).toBe(true));
    socket.close();
  });

  it("aborts streams and closes the data connection when the execution closes", async () => {
    const state = await setup(echoAdapter());
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    });
    const { socket, queue } = await connect(state.port, ticket);
    await queue.nextJson();
    state.executions.close(state.record.executionId, "execution_closed");
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4000);
  });

  it("rejects a ticket once the control connection is no longer current", async () => {
    const state = await setup(echoAdapter(), {
      connectionFence: { isCurrent: () => false },
      brokerConnectionFence: { isCurrent: () => true },
    });
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    });
    const socket = new WebSocket(`ws://127.0.0.1:${state.port}`);
    sockets.push(socket);
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "auth", ticket }));
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4401);
  });

  it("fences the data connection to the exact execution connection facts", async () => {
    const state = await setup(echoAdapter());
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "other-instance",
      connectionId: "connection-1",
    });
    const socket = new WebSocket(`ws://127.0.0.1:${state.port}`);
    sockets.push(socket);
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "auth", ticket }));
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4401);
  });
});

describe("RuntimeProviderProxyTransport Cloud control liveness", () => {
  it("cancels a live Cloud stream within the revalidation interval once the credential is retired", async () => {
    let active = true;
    const identity = {
      credentialId: "credential-1",
      computerId: COMPUTER,
      installationId: "installation-1",
      kind: "cloud" as const,
    };
    const adapter: ProviderProxyAdapter = {
      handle: async () => ({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: (async function* () {
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            yield Buffer.from("tick");
          }
        })(),
      }),
    };
    const state = await setup(adapter, {
      cloud: true,
      revalidateIntervalMs: 40,
      cloudControlActive: () => active,
      connectionFence: { isCurrent: () => true, currentControlIdentity: () => identity },
    });
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    });
    const { socket, queue } = await connect(state.port, ticket);
    await queue.nextJson();
    socket.send(openFrame(1, state.grant.token));
    expect((await queue.nextJson()).type).toBe("response");
    active = false;
    const deadline = Date.now() + 3_000;
    let cancelled = false;
    while (!cancelled && Date.now() < deadline) {
      const message = await queue.next(deadline - Date.now());
      if (message.binary) continue;
      if ((JSON.parse(message.data.toString("utf8")) as { type: string }).type === "cancel") cancelled = true;
    }
    expect(cancelled).toBe(true);
    socket.close();
  });
});

describe("RuntimeProviderProxyTransport capability liveness", () => {
  it("cancels a live stream when the capability is never renewed and expires", async () => {
    const adapter: ProviderProxyAdapter = {
      handle: async () => ({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: (async function* () {
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            yield Buffer.from("tick");
          }
        })(),
      }),
    };
    const state = await setup(adapter, { capabilityTtlMs: 120, revalidateIntervalMs: 40 });
    const { ticket } = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    });
    const { socket, queue } = await connect(state.port, ticket);
    await queue.nextJson();
    socket.send(openFrame(1, state.grant.token));
    expect((await queue.nextJson()).type).toBe("response");
    expect(await waitForFrame(queue, "cancel")).toBe(true);
    socket.close();
  });
});

function creditGate(initial: number) {
  let available = initial;
  const waiters: Array<() => void> = [];
  return {
    consume(bytes: number): void {
      available -= bytes;
    },
    grant(bytes: number): void {
      available += bytes;
      for (const waiter of waiters.splice(0)) waiter();
    },
    wait(bytes: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const check = () => {
          if (available >= bytes) resolve();
          else waiters.push(check);
        };
        check();
      });
    },
  };
}

type ProxyServerFrame = { type: string; streamId?: number; bytes?: number; code?: string };

/** Reads echoed body frames, grants download credit, and feeds the Server's upload credit back. */
async function readEchoUntilEnd(input: {
  queue: MessageQueue;
  socket: WebSocket;
  streamId: number;
  grantUpload(bytes: number): void;
}): Promise<{ received: Buffer; creditFrames: number }> {
  const received: Buffer[] = [];
  let creditFrames = 0;
  for (;;) {
    const message = await input.queue.next(10_000);
    if (message.binary) {
      const chunk = message.data.subarray(4);
      received.push(Buffer.from(chunk));
      input.socket.send(JSON.stringify({ type: "credit", streamId: input.streamId, bytes: chunk.byteLength }));
      continue;
    }
    const frame = JSON.parse(message.data.toString("utf8")) as ProxyServerFrame;
    if (frame.type === "response") continue;
    if (frame.type === "credit") {
      creditFrames += 1;
      input.grantUpload(frame.bytes ?? 0);
      continue;
    }
    if (frame.type === "end") return { received: Buffer.concat(received), creditFrames };
    throw new Error(`unexpected frame ${JSON.stringify(frame)}`);
  }
}

/** Sends request bytes within granted Server credit, then half-closes with `end`. */
async function sendBodyUntilEnd(
  socket: WebSocket,
  streamId: number,
  payload: Buffer,
  gate: ReturnType<typeof creditGate>,
): Promise<void> {
  let offset = 0;
  while (offset < payload.byteLength) {
    const chunk = payload.subarray(offset, Math.min(offset + 65_536, payload.byteLength));
    offset += chunk.byteLength;
    await gate.wait(chunk.byteLength);
    gate.consume(chunk.byteLength);
    socket.send(binaryFrame(streamId, chunk));
  }
  socket.send(JSON.stringify({ type: "end", streamId }));
}

describe("RuntimeProviderProxyTransport completion and credit accounting", () => {
  async function ready(ticket: string, port: number) {
    const { socket, queue } = await connect(port, ticket);
    expect(await queue.nextJson()).toMatchObject({ type: "ready" });
    return { socket, queue };
  }
  function ticketFor(state: Awaited<ReturnType<typeof setup>>) {
    return state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    }).ticket;
  }
  const doneAdapter: ProviderProxyAdapter = {
    handle: async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: (async function* () {
        yield Buffer.from("done");
      })(),
    }),
  };

  it("tolerates in-flight completion frames for a completed stream and keeps the socket usable", async () => {
    const state = await setup(doneAdapter);
    const { socket, queue } = await ready(ticketFor(state), state.port);
    socket.send(openFrame(1, state.grant.token));
    expect(await queue.nextJson()).toMatchObject({ type: "response", streamId: 1 });
    const chunk = await queue.next();
    expect(chunk.binary).toBe(true);
    expect(await queue.nextJson()).toEqual({ type: "end", streamId: 1 });
    // These are legitimate in-flight completions: credit for the chunk just consumed, a late
    // request-body end, and a consumer cancellation racing the Server's own end.
    socket.send(JSON.stringify({ type: "credit", streamId: 1, bytes: chunk.data.byteLength - 4 }));
    socket.send(JSON.stringify({ type: "end", streamId: 1 }));
    socket.send(JSON.stringify({ type: "cancel", streamId: 1, code: "consumer_closed" }));
    socket.send(openFrame(2, state.grant.token));
    expect(await queue.nextJson()).toMatchObject({ type: "response", streamId: 2 });
    socket.close();
  });

  it("discards in-flight request-body bytes for a completed stream", async () => {
    const state = await setup(doneAdapter);
    const { socket, queue } = await ready(ticketFor(state), state.port);
    socket.send(openFrame(1, state.grant.token));
    expect(await queue.nextJson()).toMatchObject({ type: "response", streamId: 1 });
    expect((await queue.next()).binary).toBe(true);
    expect(await queue.nextJson()).toEqual({ type: "end", streamId: 1 });
    socket.send(binaryFrame(1, Buffer.from("late request body")));
    socket.send(openFrame(2, state.grant.token));
    expect(await queue.nextJson()).toMatchObject({ type: "response", streamId: 2 });
    socket.close();
  });

  it("rejects control frames for a never-opened stream", async () => {
    const state = await setup(doneAdapter);
    const { socket } = await ready(ticketFor(state), state.port);
    socket.send(JSON.stringify({ type: "credit", streamId: 77, bytes: 1 }));
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4400);
  });

  it("rejects late download credit beyond the outstanding window for a completed stream", async () => {
    const state = await setup(doneAdapter);
    const { socket, queue } = await ready(ticketFor(state), state.port);
    socket.send(openFrame(1, state.grant.token));
    expect(await queue.nextJson()).toMatchObject({ type: "response", streamId: 1 });
    expect((await queue.next()).binary).toBe(true);
    expect(await queue.nextJson()).toEqual({ type: "end", streamId: 1 });
    // Only 4 bytes were sent, so the client may return at most that much credit; a whole extra
    // window would push the allowance above the initial grant.
    socket.send(JSON.stringify({ type: "credit", streamId: 1, bytes: 1_048_576 }));
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4400);
  });

  it("rejects late request-body bytes beyond the granted window for a completed stream", async () => {
    const state = await setup(doneAdapter, { initialCreditBytes: 1024 });
    const { socket, queue } = await ready(ticketFor(state), state.port);
    socket.send(openFrame(1, state.grant.token));
    socket.send(binaryFrame(1, Buffer.alloc(1024, 0x61)));
    expect(await queue.nextJson()).toMatchObject({ type: "response", streamId: 1 });
    expect((await queue.next()).binary).toBe(true);
    expect(await queue.nextJson()).toEqual({ type: "end", streamId: 1 });
    // The full granted window was already used, so even one more byte is a credit violation.
    socket.send(binaryFrame(1, Buffer.from("x")));
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4400);
  });

  it("rejects oversized late binary for a completed stream", async () => {
    const state = await setup(doneAdapter, { chunkMaxBytes: 1024 });
    const { socket, queue } = await ready(ticketFor(state), state.port);
    socket.send(openFrame(1, state.grant.token));
    expect(await queue.nextJson()).toMatchObject({ type: "response", streamId: 1 });
    expect((await queue.next()).binary).toBe(true);
    expect(await queue.nextJson()).toEqual({ type: "end", streamId: 1 });
    socket.send(binaryFrame(1, Buffer.alloc(2048, 0x62)));
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4400);
  });

  it("rejects request-body bytes after the client half-close", async () => {
    const state = await setup(doneAdapter);
    const { socket } = await ready(ticketFor(state), state.port);
    socket.send(openFrame(1, state.grant.token));
    socket.send(JSON.stringify({ type: "end", streamId: 1 }));
    socket.send(binaryFrame(1, Buffer.from("after-end")));
    const [code] = (await once(socket, "close")) as [number, string];
    expect(code).toBe(4400);
  });

  it("streams more than two mebibytes in both directions with exact bytes and genuine credit", async () => {
    const echo: ProviderProxyAdapter = {
      handle: async (request) => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: (async function* () {
          for await (const chunk of request.body) yield chunk;
        })(),
      }),
    };
    const state = await setup(echo);
    const { socket, queue } = await ready(ticketFor(state), state.port);
    const size = 2 * 1024 * 1024 + 12_345;
    const sent = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) sent[index] = (index * 31 + 7) & 0xff;
    const gate = creditGate(1_048_576);
    socket.send(openFrame(1, state.grant.token));
    const [echoed] = await Promise.all([
      readEchoUntilEnd({ queue, socket, streamId: 1, grantUpload: (bytes) => gate.grant(bytes) }),
      sendBodyUntilEnd(socket, 1, sent, gate),
    ]);
    expect(echoed.received.byteLength).toBe(size);
    expect(createHash("sha256").update(echoed.received).digest("hex")).toBe(
      createHash("sha256").update(sent).digest("hex"),
    );
    // Genuine multi-window consumption: the Server granted several full windows while the
    // client granted download credit for every chunk it consumed.
    expect(echoed.creditFrames).toBeGreaterThan(16);
    socket.close();
  }, 20_000);
});

describe("RuntimeProviderProxyTransport execution fence", () => {
  it("rejects a sibling execution capability on an authenticated data connection", async () => {
    const adapter = { handle: vi.fn(echoAdapter().handle) };
    const state = await setup(adapter);
    const sibling = state.executions.open({ ...state.record, runId: randomUUID() });
    const siblingGrant = await state.broker.acquire({ execution: sibling, provider: "slack", bindingId: BINDING });
    if (siblingGrant.status !== "succeeded") throw new Error("Sibling setup failed");
    const ticket = state.tickets.issue({
      executionId: state.record.executionId,
      computerId: COMPUTER,
      instanceId: "instance-1",
      connectionId: "connection-1",
    }).ticket;
    const { socket, queue } = await connect(state.port, ticket);
    expect(await queue.nextJson()).toMatchObject({ type: "ready", executionId: state.record.executionId });
    socket.send(openFrame(1, siblingGrant.token));
    socket.send(JSON.stringify({ type: "end", streamId: 1 }));
    expect(await queue.nextJson()).toMatchObject({ type: "error", code: "credential_scope_denied" });
    expect(adapter.handle).not.toHaveBeenCalled();
    socket.close();
  });
});
