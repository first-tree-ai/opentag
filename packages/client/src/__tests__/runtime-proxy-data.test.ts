import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as ServerWebSocket, WebSocketServer } from "ws";
import type { RuntimeProxyStreamResponse } from "../runtime/runtime-proxy-data-client.js";
import { RuntimeProxyDataConnection } from "../runtime/runtime-proxy-data-client.js";
import {
  type RuntimeProxyAdapterStreamRequest,
  RuntimeProxyLoopbackAdapter,
} from "../runtime/runtime-proxy-loopback-adapter.js";

const homes: string[] = [];
const teardowns: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(teardowns.splice(0).map((teardown) => teardown()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function bytesOf(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type FixtureFrame = Record<string, unknown>;

/** Real WSS fixture for the production data client. */
async function startDataFixture(
  handler: (socket: ServerWebSocket, requests: FixtureFrame[], openIds: number[]) => void,
): Promise<{ url: string; requests: FixtureFrame[]; openIds: number[] }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const requests: FixtureFrame[] = [];
  const openIds: number[] = [];
  server.on("connection", (socket) => handler(socket, requests, openIds));
  teardowns.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `ws://127.0.0.1:${address.port}/api/v1/runtime/provider-proxy`, requests, openIds };
}

function decodeJson(data: unknown): FixtureFrame {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  return JSON.parse(buffer.toString("utf8")) as FixtureFrame;
}

const EXECUTION_ID = "11111111-1111-4111-8111-111111111111";

async function connectData(
  url: string,
  ticket = "ticket-value-with-enough-bytes-1234",
): Promise<RuntimeProxyDataConnection> {
  return RuntimeProxyDataConnection.connect({ executionId: EXECUTION_ID, ticket, url });
}

function bodyStream(...chunks: string[]): AsyncIterable<Uint8Array> {
  const values = chunks.map(bytesOf);
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value;
    },
  };
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function binaryFrame(streamId: number, payload: string): Buffer {
  const frame = Buffer.alloc(4 + Buffer.byteLength(payload));
  frame.writeUInt32BE(streamId, 0);
  frame.write(payload, 4, "utf8");
  return frame;
}

/** First open fails upstream, second is cancelled, third loses the connection. */
function respondToSequencedOpens(socket: ServerWebSocket, requests: FixtureFrame[], frame: FixtureFrame): void {
  const streamNumber = requests.filter((entry) => entry.type === "open").length;
  if (streamNumber === 1) {
    socket.send(JSON.stringify({ type: "error", streamId: frame.streamId, code: "upstream_denied" }));
    return;
  }
  if (streamNumber === 2) {
    socket.send(JSON.stringify({ type: "cancel", streamId: frame.streamId, code: "policy" }));
    return;
  }
  socket.close(1011, "server_lost");
}

/** Scripted fixture: boilerplate auth/ready plus per-open and per-cancel responder callbacks. */
function scriptedDataFixture(script: {
  onCancel?(socket: ServerWebSocket, streamId: number): void;
  onOpen(socket: ServerWebSocket, streamId: number, openIndex: number): void;
}): (socket: ServerWebSocket) => void {
  return (socket) => {
    let opens = 0;
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = decodeJson(data);
      if (frame.type === "auth") {
        socket.send(JSON.stringify({ type: "ready", executionId: EXECUTION_ID }));
        return;
      }
      if (frame.type === "open") {
        opens += 1;
        script.onOpen(socket, frame.streamId as number, opens);
        return;
      }
      if (frame.type === "cancel") script.onCancel?.(socket, frame.streamId as number);
    });
  };
}

describe("RuntimeProxyDataConnection", () => {
  it("authenticates with a first-frame ticket and streams JSON + binary frames with credit", async () => {
    let fixtureSocket: ServerWebSocket | undefined;
    const fixture = await startDataFixture((socket, requests) => {
      fixtureSocket = socket;
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const frame = decodeJson(data);
        requests.push(frame);
        if (frame.type === "auth") socket.send(JSON.stringify({ type: "ready", executionId: EXECUTION_ID }));
        if (frame.type === "open") {
          socket.send(
            JSON.stringify({
              type: "response",
              streamId: frame.streamId,
              status: 201,
              headers: { "content-type": "application/json" },
            }),
          );
          socket.send(binaryFrame(frame.streamId as number, "hello "), { binary: true });
        }
      });
    });
    const connection = await connectData(fixture.url);
    try {
      const response = await connection.openStream({
        capability: "cap",
        provider: "feishu",
        bindingId: "binding-1",
        method: "POST",
        path: "/open-apis/im/v1/messages",
        headers: { "content-type": "application/json" },
        body: bodyStream("payload"),
      });
      expect(response.status).toBe(201);
      expect(response.headers["content-type"]).toBe("application/json");
      const iterator = response.body[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(Buffer.from(first.value as Uint8Array).toString("utf8")).toBe("hello ");
      await wait(20);
      expect(fixture.requests[0]).toEqual({ type: "auth", ticket: "ticket-value-with-enough-bytes-1234" });
      const open = fixture.requests.find((frame) => frame.type === "open");
      expect(open).toMatchObject({ provider: "feishu", bindingId: "binding-1", capability: "cap" });
      const credits = fixture.requests.filter((frame) => frame.type === "credit");
      expect(credits.some((frame) => frame.bytes === 6)).toBe(true);
      fixtureSocket?.send(JSON.stringify({ type: "end", streamId: open?.streamId }));
      const done = await iterator.next();
      expect(done.done).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("rejects connecting URLs that carry the ticket in the query string", async () => {
    await expect(
      RuntimeProxyDataConnection.connect({
        executionId: EXECUTION_ID,
        ticket: "ticket-value-with-enough-bytes-1234",
        url: "ws://127.0.0.1:9/api/v1/runtime/provider-proxy?ticket=leak",
      }),
    ).rejects.toMatchObject({ code: "protocol_error" });
  });

  it("rejects a ready frame for a different execution", async () => {
    const fixture = await startDataFixture((socket) => {
      socket.on("message", () => socket.send(JSON.stringify({ type: "ready", executionId: "other" })));
    });
    await expect(connectData(fixture.url)).rejects.toMatchObject({
      name: "RuntimeProxyDataError",
      code: "auth_failed",
    });
  });

  it("rejects pending streams on error, cancel, and connection loss", async () => {
    const fixture = await startDataFixture((socket, requests) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const frame = decodeJson(data);
        requests.push(frame);
        if (frame.type === "auth") socket.send(JSON.stringify({ type: "ready", executionId: EXECUTION_ID }));
        if (frame.type === "open") respondToSequencedOpens(socket, requests, frame);
      });
    });
    const connection = await connectData(fixture.url);
    const request = {
      capability: "cap",
      provider: "github" as const,
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    };
    try {
      await expect(connection.openStream(request)).rejects.toMatchObject({ code: "stream_error" });
      await expect(connection.openStream(request)).rejects.toMatchObject({ code: "stream_error" });
      await expect(connection.openStream(request)).rejects.toMatchObject({ code: "connection_lost" });
    } finally {
      await connection.close();
    }
  });

  it("bounds concurrent streams at eight, queues opens, and drains after a slot frees", async () => {
    const fixture = await startDataFixture((socket, requests, openIds) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const frame = decodeJson(data);
        requests.push(frame);
        if (frame.type === "auth") socket.send(JSON.stringify({ type: "ready", executionId: EXECUTION_ID }));
        if (frame.type === "open") {
          openIds.push(frame.streamId as number);
          socket.send(JSON.stringify({ type: "response", streamId: frame.streamId, status: 200, headers: {} }));
          setTimeout(() => socket.send(JSON.stringify({ type: "end", streamId: frame.streamId })), 30);
        }
      });
    });
    const connection = await connectData(fixture.url);
    const request = {
      capability: "cap",
      provider: "github" as const,
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    };
    try {
      const firstEight = Array.from({ length: 8 }, () => connection.openStream(request));
      const ninth = connection.openStream(request);
      await wait(10);
      expect(fixture.openIds).toHaveLength(8);
      expect(connection.activeStreamCount).toBe(8);
      const responses = await Promise.all([...firstEight, ninth]);
      for (const response of responses) await collect(response.body);
      await wait(50);
      expect(fixture.openIds).toHaveLength(9);
      expect(connection.activeStreamCount).toBe(0);
    } finally {
      await connection.close();
    }
  });

  it("cancels the upstream stream when the consumer stops early", async () => {
    const fixture = await startDataFixture((socket, requests) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const frame = decodeJson(data);
        requests.push(frame);
        if (frame.type === "auth") socket.send(JSON.stringify({ type: "ready", executionId: EXECUTION_ID }));
        if (frame.type === "open") {
          socket.send(JSON.stringify({ type: "response", streamId: frame.streamId, status: 200, headers: {} }));
          socket.send(binaryFrame(frame.streamId as number, "chunk"), { binary: true });
        }
      });
    });
    const connection = await connectData(fixture.url);
    try {
      const response = await connection.openStream({
        capability: "cap",
        provider: "github",
        bindingId: "b",
        method: "GET",
        path: "/user",
        headers: {},
      });
      const iterator = response.body[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(Buffer.from(first.value as Uint8Array).toString("utf8")).toBe("chunk");
      await iterator.return?.();
      await wait(20);
      expect(fixture.requests.some((frame) => frame.type === "cancel")).toBe(true);
      expect(connection.activeStreamCount).toBe(0);
    } finally {
      await connection.close();
    }
  });

  it("tolerates a late server cancel for a stream the consumer already cancelled", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onOpen: (socket, streamId, openIndex) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
          socket.send(binaryFrame(streamId, openIndex === 1 ? "first" : "second"), { binary: true });
          if (openIndex > 1) socket.send(JSON.stringify({ type: "end", streamId }));
        },
        onCancel: (socket, streamId) => {
          // The Server may answer our cancel with its own terminal cancel after we settled locally.
          socket.send(JSON.stringify({ type: "cancel", streamId, code: "upstream_failed" }));
        },
      }),
    );
    const connection = await connectData(fixture.url);
    try {
      const request = {
        capability: "cap",
        provider: "github" as const,
        bindingId: "b",
        method: "GET",
        path: "/user",
        headers: {},
      };
      const first = await connection.openStream(request);
      const iterator = first.body[Symbol.asyncIterator]();
      expect(Buffer.from((await iterator.next()).value as Uint8Array).toString("utf8")).toBe("first");
      first.cancel?.("consumer_cancelled");
      // Ordered delivery: the late cancel is sent before the sibling response, so a healthy
      // connection completes the sibling stream with no timing sleeps.
      const second = await connection.openStream(request);
      expect(await collect(second.body)).toBe("second");
    } finally {
      await connection.close();
    }
  });

  it("tolerates bounded in-flight binary and one terminal frame after a local cancel", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onOpen: (socket, streamId, openIndex) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
          socket.send(binaryFrame(streamId, openIndex === 1 ? "first" : "sibling"), { binary: true });
          if (openIndex > 1) socket.send(JSON.stringify({ type: "end", streamId }));
        },
        onCancel: (socket, streamId) => {
          socket.send(binaryFrame(streamId, "late"), { binary: true });
          socket.send(JSON.stringify({ type: "end", streamId }));
        },
      }),
    );
    const connection = await connectData(fixture.url);
    try {
      const request = {
        capability: "cap",
        provider: "github" as const,
        bindingId: "b",
        method: "GET",
        path: "/user",
        headers: {},
      };
      const first = await connection.openStream(request);
      const iterator = first.body[Symbol.asyncIterator]();
      expect(Buffer.from((await iterator.next()).value as Uint8Array).toString("utf8")).toBe("first");
      await iterator.return?.();
      const second = await connection.openStream(request);
      expect(await collect(second.body)).toBe("sibling");
    } finally {
      await connection.close();
    }
  });

  it("rejects a duplicate terminal frame after a locally cancelled stream", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onOpen: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
          socket.send(binaryFrame(streamId, "first"), { binary: true });
        },
        onCancel: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "cancel", streamId, code: "upstream_failed" }));
          socket.send(JSON.stringify({ type: "end", streamId }));
        },
      }),
    );
    const connection = await connectData(fixture.url);
    const request = {
      capability: "cap",
      provider: "github" as const,
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    };
    const first = await connection.openStream(request);
    const iterator = first.body[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await connection.settled();
    await expect(connection.openStream(request)).rejects.toMatchObject({ code: "connection_closed" });
  });

  it("rejects out-of-credit binary after a local cancel", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onOpen: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
          socket.send(binaryFrame(streamId, "first"), { binary: true });
        },
        onCancel: (socket, streamId) => {
          // 17 chunks of 64 KiB exceed the initial window plus the one granted chunk.
          for (let index = 0; index < 17; index += 1) {
            socket.send(binaryFrame(streamId, "x".repeat(65_536)), { binary: true });
          }
        },
      }),
    );
    const connection = await connectData(fixture.url);
    const request = {
      capability: "cap",
      provider: "github" as const,
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    };
    const first = await connection.openStream(request);
    const iterator = first.body[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await connection.settled();
  });

  it("rejects malformed binary after a local cancel", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onOpen: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
          socket.send(binaryFrame(streamId, "first"), { binary: true });
        },
        onCancel: (socket) => socket.send(Buffer.alloc(4), { binary: true }),
      }),
    );
    const connection = await connectData(fixture.url);
    const request = {
      capability: "cap",
      provider: "github" as const,
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    };
    const first = await connection.openStream(request);
    const iterator = first.body[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await connection.settled();
  });
});

/* ---------------------------------- loopback adapter ---------------------------------- */

interface AdapterHarness {
  adapter: RuntimeProxyLoopbackAdapter;
  bodies: string[];
  requests: RuntimeProxyAdapterStreamRequest[];
  response: RuntimeProxyStreamResponse;
}

function okResponse(): RuntimeProxyStreamResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "2" },
    body: (async function* () {
      yield bytesOf("{}");
    })(),
  };
}

async function startAdapter(options?: {
  localHandleFor?: (provider: string) => string | undefined;
  response?: () => RuntimeProxyStreamResponse;
}): Promise<AdapterHarness> {
  const home = await mkdtemp(join(tmpdir(), "opentag-adapter-"));
  homes.push(home);
  const bodies: string[] = [];
  const requests: RuntimeProxyAdapterStreamRequest[] = [];
  const createResponse = options?.response ?? okResponse;
  const adapter = await RuntimeProxyLoopbackAdapter.start({
    executionId: EXECUTION_ID,
    logger: { debug() {}, warn() {} },
    materialDir: join(home, "exec"),
    openStream: async (request) => {
      requests.push(request);
      bodies.push(await readBodyText(request.body));
      return createResponse();
    },
    verifyHandle: (_provider, handle) => handle === "otrh_valid",
    ...(options?.localHandleFor ? { localHandleFor: options.localHandleFor as never } : {}),
  });
  teardowns.push(() => adapter.close());
  return { adapter, bodies, requests, response: okResponse() };
}

async function readBodyText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const SLACK_FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded; charset=utf-8" };

function onceData(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("socket ended"));
    };
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
    };
    socket.once("data", onData);
    socket.once("end", onEnd);
  });
}

async function readHttpResponse(socket: tls.TLSSocket | net.Socket): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
}> {
  let buffer = Buffer.alloc(0);
  while (buffer.indexOf("\r\n\r\n") < 0) {
    buffer = Buffer.concat([buffer, await onceData(socket)]);
  }
  const headerEnd = buffer.indexOf("\r\n\r\n");
  const lines = buffer.subarray(0, headerEnd).toString("utf8").split("\r\n");
  const status = Number(lines[0]?.split(" ")[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  const length = Number(headers["content-length"] ?? 0);
  let body = buffer.subarray(headerEnd + 4);
  while (body.byteLength < length) body = Buffer.concat([body, await onceData(socket)]);
  return { status, headers, body: body.subarray(0, length).toString("utf8") };
}

/** Plain CONNECT handshake, then a real TLS client session for the requested host. */
async function connectTunnel(proxyPort: number, host: string, ca: Buffer): Promise<tls.TLSSocket> {
  const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
  await once(socket, "connect");
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  let handshake = Buffer.alloc(0);
  while (handshake.indexOf("\r\n\r\n") < 0) {
    handshake = Buffer.concat([handshake, await onceData(socket)]);
  }
  expect(handshake.toString("utf8")).toContain("200");
  const rest = handshake.subarray(handshake.indexOf("\r\n\r\n") + 4);
  if (rest.byteLength > 0) socket.unshift(rest);
  const secure = tls.connect({ socket, ca, servername: host });
  await once(secure, "secureConnect");
  return secure;
}

function writeRequest(
  socket: tls.TLSSocket | net.Socket,
  request: { method: string; path: string; headers?: Record<string, string>; body?: string },
): void {
  const body = request.body ?? "";
  const headers = {
    host: "placeholder",
    connection: "close",
    ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
    ...(request.headers ?? {}),
  };
  const lines = [
    `${request.method} ${request.path} HTTP/1.1`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
}

describe("RuntimeProxyLoopbackAdapter", () => {
  it("rejects CONNECT targets outside the fixed platform allowlist", async () => {
    const { adapter } = await startAdapter();
    const socket = net.connect({ host: "127.0.0.1", port: Number(new URL(adapter.connectProxyUrl).port) });
    await once(socket, "connect");
    socket.write("CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n");
    let response = Buffer.alloc(0);
    while (response.indexOf("\r\n\r\n") < 0) response = Buffer.concat([response, await onceData(socket)]);
    expect(response.toString("utf8")).toContain("403");
    socket.destroy();
  });

  it("challenges credential-less Git with 401 and verifies the execution-local handle", async () => {
    const { adapter, requests } = await startAdapter();
    const ca = await readFile(adapter.caCertPath);
    const proxyPort = Number(new URL(adapter.connectProxyUrl).port);

    const challengeTunnel = await connectTunnel(proxyPort, "github.com", ca);
    await writeRequest(challengeTunnel, { method: "GET", path: "/acme/repo.git/info/refs?service=git-upload-pack" });
    const challenge = await readHttpResponse(challengeTunnel);
    expect(challenge.status).toBe(401);
    expect(challenge.headers["www-authenticate"]).toContain("Basic");
    challengeTunnel.destroy();

    const authorized = await connectTunnel(proxyPort, "github.com", ca);
    await writeRequest(authorized, {
      method: "GET",
      path: "/acme/repo.git/info/refs?service=git-upload-pack",
      headers: { authorization: `Basic ${Buffer.from("x-access-token:otrh_valid").toString("base64")}` },
    });
    const ok = await readHttpResponse(authorized);
    expect(ok.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ provider: "github", method: "GET" });
    expect(requests[0]?.path).toBe("/acme/repo.git/info/refs?service=git-upload-pack");
    expect(requests[0]?.headers["x-opentag-provider-origin"]).toBe("github.com");
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
    expect(requests[0]?.headers).not.toHaveProperty("host");
    authorized.destroy();

    const wrong = await connectTunnel(proxyPort, "github.com", ca);
    await writeRequest(wrong, {
      method: "GET",
      path: "/acme/repo.git/info/refs",
      headers: { authorization: `Basic ${Buffer.from("x-access-token:otrh_wrong").toString("base64")}` },
    });
    expect((await readHttpResponse(wrong)).status).toBe(403);
    wrong.destroy();
  });

  it("sets the exact reserved provider origin for API traffic and ignores caller spoofing", async () => {
    const { adapter, requests } = await startAdapter();
    const ca = await readFile(adapter.caCertPath);
    const tunnel = await connectTunnel(Number(new URL(adapter.connectProxyUrl).port), "api.github.com", ca);
    await writeRequest(tunnel, {
      method: "GET",
      path: "/user",
      headers: { authorization: "token otrh_valid", "x-opentag-provider-origin": "evil.example" },
    });
    expect((await readHttpResponse(tunnel)).status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["x-opentag-provider-origin"]).toBe("api.github.com");
    tunnel.destroy();
  });

  it("round-trips Server handle URLs on provider origins without local handle material", async () => {
    const { adapter, requests } = await startAdapter();
    const ca = await readFile(adapter.caCertPath);
    const proxyPort = Number(new URL(adapter.connectProxyUrl).port);
    const tunnel = await connectTunnel(proxyPort, "slack.com", ca);
    await writeRequest(tunnel, { method: "GET", path: "/__opentag__/handles/handle-id-1" });
    expect((await readHttpResponse(tunnel)).status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ provider: "slack", path: "/__opentag__/handles/handle-id-1" });
    expect(requests[0]?.headers).not.toHaveProperty("x-opentag-provider-origin");
    tunnel.destroy();

    // Slack `upload_url` handles are POSTed with an opaque body; no local token is required.
    const upload = await connectTunnel(proxyPort, "slack.com", ca);
    await writeRequest(upload, {
      method: "POST",
      path: "/__opentag__/handles/upload-id-1",
      headers: { "content-type": "application/octet-stream" },
      body: "file-bytes",
    });
    expect((await readHttpResponse(upload)).status).toBe(200);
    expect(requests.at(-1)).toMatchObject({
      provider: "slack",
      method: "POST",
      path: "/__opentag__/handles/upload-id-1",
    });
    upload.destroy();

    // GitHub download handles keep the exact reserved origin for the GitHub adapter.
    const github = await connectTunnel(proxyPort, "api.github.com", ca);
    await writeRequest(github, { method: "GET", path: "/__opentag__/handles/gh-id-1" });
    expect((await readHttpResponse(github)).status).toBe(200);
    expect(requests.at(-1)).toMatchObject({ provider: "github" });
    expect(requests.at(-1)?.headers["x-opentag-provider-origin"]).toBe("api.github.com");
    github.destroy();
  });

  it("substitutes the harmless Feishu tenant-token placeholder with the local handle", async () => {
    const placeholder = JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "server-placeholder", expire: 7200 });
    const { adapter, requests } = await startAdapter({
      localHandleFor: (provider) => (provider === "feishu" ? "otrh_feishu_handle" : undefined),
      response: () => ({
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(placeholder)) },
        body: (async function* () {
          yield bytesOf(placeholder);
        })(),
      }),
    });
    const ca = await readFile(adapter.caCertPath);
    const tunnel = await connectTunnel(Number(new URL(adapter.connectProxyUrl).port), "open.feishu.cn", ca);
    await writeRequest(tunnel, {
      method: "POST",
      path: "/open-apis/auth/v3/tenant_access_token/internal",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: "cli-app", app_secret: "not-a-real-secret" }),
    });
    const response = await readHttpResponse(tunnel);
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.tenant_access_token).toBe("otrh_feishu_handle");
    expect(response.body).not.toContain("server-placeholder");
    expect(requests).toHaveLength(1);
    tunnel.destroy();
  });

  it("serves the direct Slack --apihost endpoint with handle verification and handle URLs", async () => {
    const { adapter, requests } = await startAdapter();
    const ca = await readFile(adapter.caCertPath);
    const port = Number(new URL(adapter.slackApiHost).port);

    const request = (options: https.RequestOptions): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const next = https.request({ host: "127.0.0.1", port, ca, ...options }, (response) => {
          let body = "";
          response.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
          });
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        });
        next.on("error", reject);
        next.end();
      });

    const authorized = await request({
      method: "POST",
      path: "/api/auth.test",
      headers: { authorization: "Bearer otrh_valid", "content-length": "0" },
    });
    expect(authorized.status).toBe(200);
    expect(requests.at(-1)?.provider).toBe("slack");

    const handleUrl = await request({ method: "GET", path: "/__opentag__/handles/upload-id" });
    expect(handleUrl.status).toBe(200);
    expect(requests.at(-1)?.path).toBe("/__opentag__/handles/upload-id");

    const invalid = await request({
      method: "POST",
      path: "/api/auth.test",
      headers: { authorization: "Bearer nope", "content-length": "0" },
    });
    expect(invalid.status).toBe(403);
  });

  it("accepts the native Slack form-body token and scrubs it before upstream", async () => {
    const { adapter, bodies, requests } = await startAdapter();
    const ca = await readFile(adapter.caCertPath);
    const tunnel = await connectTunnel(Number(new URL(adapter.connectProxyUrl).port), "slack.com", ca);
    await writeRequest(tunnel, {
      method: "POST",
      path: "/api/auth.test",
      headers: SLACK_FORM_HEADERS,
      body: "token=otrh_valid&foo=bar+baz",
    });
    expect((await readHttpResponse(tunnel)).status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(bodies).toEqual(["foo=bar+baz"]);
    expect(bodies[0]).not.toContain("otrh_valid");
    tunnel.destroy();
  });

  it("accepts a matching form token and Authorization header together", async () => {
    const { adapter, bodies, requests } = await startAdapter();
    const ca = await readFile(adapter.caCertPath);
    const tunnel = await connectTunnel(Number(new URL(adapter.connectProxyUrl).port), "slack.com", ca);
    await writeRequest(tunnel, {
      method: "POST",
      path: "/api/auth.test",
      headers: { ...SLACK_FORM_HEADERS, authorization: "Bearer otrh_valid" },
      body: "token=otrh_valid",
    });
    expect((await readHttpResponse(tunnel)).status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(bodies).toEqual([""]);
    tunnel.destroy();
  });

  it("rejects conflicting or duplicated Slack handles before any upstream call", async () => {
    const { adapter, requests } = await startAdapter();
    const ca = await readFile(adapter.caCertPath);
    const proxyPort = Number(new URL(adapter.connectProxyUrl).port);

    const conflicting = await connectTunnel(proxyPort, "slack.com", ca);
    await writeRequest(conflicting, {
      method: "POST",
      path: "/api/auth.test",
      headers: { ...SLACK_FORM_HEADERS, authorization: "Bearer otrh_other" },
      body: "token=otrh_valid",
    });
    expect((await readHttpResponse(conflicting)).status).toBe(403);
    conflicting.destroy();

    const duplicate = await connectTunnel(proxyPort, "slack.com", ca);
    await writeRequest(duplicate, {
      method: "POST",
      path: "/api/auth.test",
      headers: SLACK_FORM_HEADERS,
      body: "token=otrh_valid&token=otrh_valid",
    });
    expect((await readHttpResponse(duplicate)).status).toBe(403);
    duplicate.destroy();

    const invalid = await connectTunnel(proxyPort, "slack.com", ca);
    await writeRequest(invalid, {
      method: "POST",
      path: "/api/auth.test",
      headers: SLACK_FORM_HEADERS,
      body: "token=otrh_wrong",
    });
    expect((await readHttpResponse(invalid)).status).toBe(403);
    invalid.destroy();

    expect(requests).toHaveLength(0);
  });

  it("keeps the credential-less 401 for form, multipart, and oversized bodies", async () => {
    const { adapter, requests } = await startAdapter();
    const ca = await readFile(adapter.caCertPath);
    const proxyPort = Number(new URL(adapter.connectProxyUrl).port);

    const emptyForm = await connectTunnel(proxyPort, "slack.com", ca);
    await writeRequest(emptyForm, {
      method: "POST",
      path: "/api/auth.test",
      headers: SLACK_FORM_HEADERS,
      body: "foo=bar",
    });
    expect((await readHttpResponse(emptyForm)).status).toBe(401);
    emptyForm.destroy();

    // Multipart/file streams are never buffered for inspection and stay authenticated by header.
    const multipart = await connectTunnel(proxyPort, "slack.com", ca);
    await writeRequest(multipart, {
      method: "POST",
      path: "/api/files.upload",
      headers: { "content-type": "multipart/form-data; boundary=----opentag" },
      body: '------opentag\r\ncontent-disposition: form-data; name="token"\r\n\r\notrh_valid\r\n------opentag--\r\n',
    });
    expect((await readHttpResponse(multipart)).status).toBe(401);
    multipart.destroy();

    const oversized = await connectTunnel(proxyPort, "slack.com", ca);
    await writeRequest(oversized, {
      method: "POST",
      path: "/api/auth.test",
      headers: SLACK_FORM_HEADERS,
      body: `token=otrh_valid&padding=${"a".repeat(70 * 1024)}`,
    });
    expect((await readHttpResponse(oversized)).status).toBe(413);
    oversized.destroy();

    expect(requests).toHaveLength(0);
  });

  it("cancels the upstream stream when the client disconnects early", async () => {
    let cancelled = 0;
    const { adapter } = await startAdapter({
      response: () => ({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: (async function* () {
          yield bytesOf("first");
          await wait(500);
          yield bytesOf("second");
        })(),
        cancel: () => {
          cancelled += 1;
        },
      }),
    });
    const ca = await readFile(adapter.caCertPath);
    const tunnel = await connectTunnel(Number(new URL(adapter.connectProxyUrl).port), "api.github.com", ca);
    await writeRequest(tunnel, { method: "GET", path: "/user", headers: { authorization: "token otrh_valid" } });
    await onceData(tunnel);
    tunnel.destroy();
    await wait(50);
    expect(cancelled).toBe(1);
  });
});
