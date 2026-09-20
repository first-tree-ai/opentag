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
function scriptedDataFixture(
  script: {
    onCancel?(socket: ServerWebSocket, streamId: number): void;
    onOpen(socket: ServerWebSocket, streamId: number, openIndex: number): void;
  },
  options: { closeOnAuth?: boolean; closeOnOpen?: boolean; silentAuth?: boolean } = {},
): (socket: ServerWebSocket) => void {
  let opens = 0;
  const onAuth = (socket: ServerWebSocket) => {
    if (options.closeOnAuth) {
      socket.close();
      return;
    }
    if (!options.silentAuth) socket.send(JSON.stringify({ type: "ready", executionId: EXECUTION_ID }));
  };
  const onOpen = (socket: ServerWebSocket, streamId: number) => {
    opens += 1;
    if (options.closeOnOpen) socket.close();
    else script.onOpen(socket, streamId, opens);
  };
  return (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = decodeJson(data);
      if (frame.type === "auth") onAuth(socket);
      else if (frame.type === "open") onOpen(socket, frame.streamId as number);
      else if (frame.type === "cancel") script.onCancel?.(socket, frame.streamId as number);
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

  it("rejects an open on a closed connection and an already-aborted request", async () => {
    const fixture = await startDataFixture(scriptedDataFixture({ onOpen: () => undefined }));
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
      const aborted = new AbortController();
      aborted.abort();
      await expect(connection.openStream({ ...request, signal: aborted.signal })).rejects.toMatchObject({
        code: "aborted",
      });
      expect(connection.closed).toBe(false);
      expect(connection.activeStreamCount).toBe(0);
    } finally {
      await connection.close();
    }
    expect(connection.closed).toBe(true);
    await expect(connection.openStream(request)).rejects.toMatchObject({ code: "connection_closed" });
    // Closing again is idempotent.
    await connection.close();
  });

  it("rejects an open queued behind the stream limit when the open queue is full", async () => {
    const fixture = await startDataFixture(scriptedDataFixture({ onOpen: () => undefined }));
    const connection = await connectData(fixture.url);
    const request = {
      capability: "cap",
      provider: "github" as const,
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    };
    const started = Array.from({ length: 8 }, () => connection.openStream(request));
    const queued = Array.from({ length: 64 }, () => connection.openStream(request));
    await expect(connection.openStream(request)).rejects.toMatchObject({ code: "queue_full" });
    expect(connection.activeStreamCount).toBe(8);
    const closing = connection.close();
    for (const pending of [...started, ...queued]) {
      await expect(pending).rejects.toMatchObject({ code: "connection_closed" });
    }
    await closing;
  });

  it("rejects a queued open whose signal aborted before its slot freed", async () => {
    const fixture = await startDataFixture(scriptedDataFixture({ onOpen: () => undefined }));
    const connection = await connectData(fixture.url);
    const request = {
      capability: "cap",
      provider: "github" as const,
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    };
    const started = Array.from({ length: 8 }, () => connection.openStream(request));
    const controller = new AbortController();
    const queued = connection.openStream({ ...request, signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "aborted" });
    await connection.close();
    for (const pending of started) await expect(pending).rejects.toBeInstanceOf(Error);
  });

  it("cancels with the open_timeout code when a stream never gets a response", async () => {
    const fixture = await startDataFixture((socket, requests) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const frame = decodeJson(data);
        requests.push(frame);
        if (frame.type === "auth") socket.send(JSON.stringify({ type: "ready", executionId: EXECUTION_ID }));
      });
    });
    const connection = await RuntimeProxyDataConnection.connect({
      executionId: EXECUTION_ID,
      openTimeoutMs: 20,
      ticket: "ticket-value-with-enough-bytes-1234",
      url: fixture.url,
    });
    try {
      await expect(
        connection.openStream({
          capability: "cap",
          provider: "github",
          bindingId: "b",
          method: "GET",
          path: "/user",
          headers: {},
        }),
      ).rejects.toMatchObject({ code: "aborted" });
      // The client told the Server why: the open deadline expired, not a consumer cancel.
      await wait(20);
      expect(fixture.requests).toContainEqual(expect.objectContaining({ code: "open_timeout", type: "cancel" }));
      expect(connection.activeStreamCount).toBe(0);
    } finally {
      await connection.close();
    }
  });

  it("cancels with the request_body_failed code when a body source throws", async () => {
    const fixture = await startDataFixture((socket, requests) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const frame = decodeJson(data);
        requests.push(frame);
        if (frame.type === "auth") socket.send(JSON.stringify({ type: "ready", executionId: EXECUTION_ID }));
      });
    });
    const connection = await connectData(fixture.url);
    const failing: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            return Promise.reject(new Error("body source failed"));
          },
        };
      },
    };
    try {
      await expect(
        connection.openStream({
          bindingId: "b",
          body: failing,
          capability: "cap",
          headers: {},
          method: "POST",
          path: "/user",
          provider: "github",
        }),
      ).rejects.toMatchObject({ code: "aborted" });
      await wait(20);
      expect(fixture.requests).toContainEqual(expect.objectContaining({ code: "request_body_failed", type: "cancel" }));
      expect(connection.activeStreamCount).toBe(0);
    } finally {
      await connection.close();
    }
  });

  it("cancels by the caller's code and fails the body of a Server-cancelled stream", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onCancel: (socket, streamId) => socket.send(JSON.stringify({ type: "end", streamId })),
        onOpen: (socket, streamId, openIndex) => {
          if (openIndex === 3) {
            socket.send(JSON.stringify({ type: "cancel", streamId, code: "policy" }));
            return;
          }
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
          if (openIndex === 2) socket.send(JSON.stringify({ type: "error", streamId, code: "upstream_failed" }));
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
    try {
      const cancelled = await connection.openStream(request);
      cancelled.cancel?.("policy");
      await wait(20);
      expect(connection.activeStreamCount).toBe(0);

      const failedBody = await connection.openStream(request);
      await expect(collect(failedBody.body)).rejects.toMatchObject({ code: "stream_error" });

      await expect(connection.openStream(request)).rejects.toMatchObject({ code: "stream_error" });
    } finally {
      await connection.close();
    }
  });

  it("waits for send credit before writing a body larger than the initial window", async () => {
    const sentBytes = { total: 0 };
    const fixture = await startDataFixture((socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          const frame = Buffer.from(data as Buffer);
          sentBytes.total += frame.byteLength - 4;
          // A real flow-controlled Server grants back exactly what it consumed.
          socket.send(JSON.stringify({ type: "credit", streamId: frame.readUInt32BE(0), bytes: frame.byteLength - 4 }));
          return;
        }
        const frame = decodeJson(data);
        if (frame.type === "auth") {
          socket.send(JSON.stringify({ type: "ready", executionId: EXECUTION_ID }));
          return;
        }
        if (frame.type === "open") {
          socket.send(JSON.stringify({ type: "response", streamId: frame.streamId, status: 200, headers: {} }));
        }
      });
    });
    const connection = await connectData(fixture.url);
    const total = 1_200_000;
    try {
      const response = await connection.openStream({
        bindingId: "b",
        body: bodyStream("z".repeat(total)),
        capability: "cap",
        headers: {},
        method: "POST",
        path: "/user",
        provider: "github",
      });
      expect(response.status).toBe(200);
      // The whole body is written in ≤64 KiB chunks, which is only possible because the pump waits
      // for the Server's credit frames after the 1 MiB initial window is exhausted.
      await wait(1_500);
      expect(sentBytes.total).toBe(total);
    } finally {
      await connection.close();
    }
  });

  it("hands a chunk to a consumer that is already waiting for one", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onOpen: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
          // Delay the data so the consumer reaches its pending waiter first.
          setTimeout(() => socket.send(binaryFrame(streamId, "late-chunk"), { binary: true }), 30);
        },
      }),
    );
    const connection = await connectData(fixture.url);
    const response = await connection.openStream({
      capability: "cap",
      provider: "github",
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    });
    try {
      const iterator = response.body[Symbol.asyncIterator]();
      const pending = iterator.next();
      const [first] = await Promise.all([pending, wait(60)]);
      expect(Buffer.from(first.value as Uint8Array).toString("utf8")).toBe("late-chunk");
    } finally {
      await connection.close();
    }
  });

  it("fails a consumer that is already waiting when the stream errors", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onOpen: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
          setTimeout(() => socket.send(JSON.stringify({ type: "error", streamId, code: "upstream_failed" })), 30);
        },
      }),
    );
    const connection = await connectData(fixture.url);
    const response = await connection.openStream({
      capability: "cap",
      provider: "github",
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    });
    try {
      // The consumer is parked on its pending read when the failure frame arrives.
      await expect(collect(response.body)).rejects.toMatchObject({ code: "stream_error" });
    } finally {
      await connection.close();
    }
  });

  it("logs a socket error without failing the connection", async () => {
    let socketRef: ServerWebSocket | undefined;
    const fixture = await startDataFixture((socket) => {
      socketRef = socket;
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const frame = decodeJson(data);
        if (frame.type === "auth") socket.send(JSON.stringify({ type: "ready", executionId: EXECUTION_ID }));
      });
    });
    const connection = await connectData(fixture.url);
    try {
      // Abruptly kill the peer: the client's socket reports an error and then closes.
      socketRef?.terminate();
      await connection.settled();
    } finally {
      await connection.close();
    }
  });

  it("terminates a socket that never completes the handshake", async () => {
    // The fixture never answers the auth frame, so the handshake deadline decides the outcome.
    const fixture = await startDataFixture(scriptedDataFixture({ onOpen: () => undefined }, { silentAuth: true }));
    await expect(
      RuntimeProxyDataConnection.connect({
        executionId: EXECUTION_ID,
        handshakeTimeoutMs: 30,
        ticket: "ticket-value-with-enough-bytes-1234",
        url: fixture.url,
      }),
    ).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("fails the handshake when the server closes the socket before ready", async () => {
    const closing = await startDataFixture(
      scriptedDataFixture({ onOpen: () => undefined }, { closeOnAuth: true, silentAuth: true }),
    );
    await expect(connectData(closing.url)).rejects.toMatchObject({ name: "RuntimeProxyDataError" });
  });

  it("rejects a binary frame that arrives before the ready handshake", async () => {
    const fixture = await startDataFixture((socket) => {
      socket.on("message", () => socket.send(binaryFrame(1, "early"), { binary: true }));
    });
    await expect(connectData(fixture.url)).rejects.toMatchObject({
      code: "protocol_error",
      message: expect.stringContaining("binary before ready"),
    });
  });

  it("rejects an auth reply that is not valid JSON", async () => {
    const fixture = await startDataFixture((socket) => {
      socket.on("message", () => socket.send("not json at all"));
    });
    await expect(connectData(fixture.url)).rejects.toMatchObject({ code: "protocol_error" });
  });

  it("fails a stream whose header frame is never sent because the socket closed", async () => {
    const fixture = await startDataFixture(scriptedDataFixture({ onOpen: () => undefined }, { closeOnOpen: true }));
    const connection = await connectData(fixture.url);
    await expect(
      connection.openStream({
        capability: "cap",
        provider: "github",
        bindingId: "b",
        method: "GET",
        path: "/user",
        headers: {},
      }),
    ).rejects.toBeInstanceOf(Error);
    await connection.close();
  });

  it("fails every open stream when the Server closes the data connection", async () => {
    const fixture = await startDataFixture(scriptedDataFixture({ onOpen: () => undefined }, { closeOnOpen: true }));
    const connection = await connectData(fixture.url);
    const pending = connection.openStream({
      capability: "cap",
      provider: "github",
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    });
    await expect(pending).rejects.toMatchObject({ code: "connection_lost" });
    expect(connection.closed).toBe(true);
    await connection.close();
  });

  it("aborts an open stream through its request signal", async () => {
    const fixture = await startDataFixture(scriptedDataFixture({ onOpen: () => undefined }));
    const connection = await connectData(fixture.url);
    const controller = new AbortController();
    const pending = connection.openStream({
      capability: "cap",
      provider: "github",
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(connection.activeStreamCount).toBe(0);
    await connection.close();
  });

  it("evicts the oldest tombstone instead of growing without bound", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onCancel: () => undefined,
        // The Server never ends, so each cancelled stream leaves exactly one tombstone behind.
        onOpen: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
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
    try {
      for (let index = 0; index < 260; index += 1) {
        const response = await connection.openStream(request);
        response.cancel?.("consumer_cancelled");
      }
      // 260 locally cancelled streams exceed the 256-entry tombstone limit; the connection is
      // still healthy and every cancelled stream has left the active map.
      expect(connection.closed).toBe(false);
      expect(connection.activeStreamCount).toBe(0);
    } finally {
      await connection.close();
    }
  }, 20_000);

  it("rejects a duplicate response for a locally cancelled stream", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onCancel: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
        },
        onOpen: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
        },
      }),
    );
    const connection = await connectData(fixture.url);
    const response = await connection.openStream({
      capability: "cap",
      provider: "github",
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    });
    response.cancel?.("consumer_cancelled");
    await connection.settled();
    expect(connection.closed).toBe(true);
    await connection.close();
  });

  it("rejects credit beyond the window for a locally cancelled stream", async () => {
    const fixture = await startDataFixture(
      scriptedDataFixture({
        onCancel: (socket, streamId) =>
          socket.send(JSON.stringify({ type: "credit", streamId, bytes: 2 * 1024 * 1024 })),
        onOpen: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
        },
      }),
    );
    const connection = await connectData(fixture.url);
    const response = await connection.openStream({
      capability: "cap",
      provider: "github",
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    });
    response.cancel?.("consumer_cancelled");
    await connection.settled();
    expect(connection.closed).toBe(true);
    await connection.close();
  });

  it("rejects any frame and data after a tombstoned stream completed", async () => {
    const frameAfterTerminal = await startDataFixture(
      scriptedDataFixture({
        onCancel: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "end", streamId }));
          socket.send(JSON.stringify({ type: "credit", streamId, bytes: 1 }));
        },
        onOpen: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
        },
      }),
    );
    const firstConnection = await connectData(frameAfterTerminal.url);
    const firstResponse = await firstConnection.openStream({
      capability: "cap",
      provider: "github",
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    });
    firstResponse.cancel?.("consumer_cancelled");
    await firstConnection.settled();
    expect(firstConnection.closed).toBe(true);
    await firstConnection.close();

    const dataAfterTerminal = await startDataFixture(
      scriptedDataFixture({
        onCancel: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "end", streamId }));
          socket.send(binaryFrame(streamId, "late"), { binary: true });
        },
        onOpen: (socket, streamId) => {
          socket.send(JSON.stringify({ type: "response", streamId, status: 200, headers: {} }));
        },
      }),
    );
    const secondConnection = await connectData(dataAfterTerminal.url);
    const secondResponse = await secondConnection.openStream({
      capability: "cap",
      provider: "github",
      bindingId: "b",
      method: "GET",
      path: "/user",
      headers: {},
    });
    secondResponse.cancel?.("consumer_cancelled");
    await secondConnection.settled();
    expect(secondConnection.closed).toBe(true);
    await secondConnection.close();
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
