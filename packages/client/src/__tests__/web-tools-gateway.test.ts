import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allocateWebGatewaySocket,
  type WebGatewayDispatch,
  WebGatewayDispatchError,
  WebToolsGatewayServer,
} from "../runtime/web-tools-gateway.js";

const roots: string[] = [];
const servers: WebToolsGatewayServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function startGateway(
  dispatch: WebGatewayDispatch,
  options: { socketPath?: string; now?: () => number } = {},
): Promise<WebToolsGatewayServer> {
  const socketPath = options.socketPath ?? join(await temporaryRoot("ot-web-gw-test-"), "gateway.sock");
  const server = await WebToolsGatewayServer.start({
    socketPath,
    dispatch,
    ...(options.now ? { now: options.now } : {}),
  });
  servers.push(server);
  return server;
}

interface CallOptions {
  rawBody?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Write headers plus a partial body and never end the request. */
  stall?: boolean;
}

function call(
  socketPath: string,
  path: string,
  body: unknown,
  options: CallOptions = {},
): { response: Promise<{ status: number; body: string }>; request: http.ClientRequest } {
  const payload = options.rawBody ?? JSON.stringify(body);
  let resolveResponse: (value: { status: number; body: string }) => void = () => undefined;
  let rejectResponse: (error: unknown) => void = () => undefined;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  // Keep transport failures observed even when a caller destroys its socket mid-request; the
  // returned promise still rejects for the test assertion.
  response.catch(() => undefined);
  const request = http.request(
    {
      socketPath,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.stall ? { "content-length": String(payload.length + 100) } : {}),
        ...options.headers,
      },
    },
    (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () =>
        resolveResponse({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    },
  );
  request.on("error", (error) => {
    // A destroyed test client is expected during disconnect cases; the response promise owns
    // the assertion outcome.
    if (!options.signal?.aborted) rejectResponse(error);
  });
  options.signal?.addEventListener("abort", () => request.destroy(), { once: true });
  if (options.stall) {
    const partial = payload.slice(0, Math.max(1, Math.floor(payload.length / 2)));
    request.write(partial);
  } else {
    request.end(payload);
  }
  return { response, request };
}

const searchResult = {
  requestId: "r1",
  status: "ok" as const,
  retrievedAt: "2026-09-17T00:00:00Z",
  effectiveDepth: "basic" as const,
  results: [],
};

const fetchResult = {
  requestId: "r2",
  status: "ok" as const,
  retrievedAt: "2026-09-17T00:00:00Z",
  effectiveDepth: "basic" as const,
  results: [],
};

describe("WebToolsGatewayServer", () => {
  it("allocates a fresh short private per-execution endpoint outside Session storage", async () => {
    const first = await allocateWebGatewaySocket();
    const second = await allocateWebGatewaySocket();
    roots.push(first.directory, second.directory);
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(Buffer.byteLength(first.socketPath)).toBeLessThan(100);
    expect(first.socketPath.startsWith(tmpdir())).toBe(true);
    expect((await stat(first.directory)).mode & 0o777).toBe(0o700);
  });

  it("serves exactly /web/search and /web/fetch over the Unix socket", async () => {
    const seen: string[] = [];
    const server = await startGateway(async (input) => {
      seen.push(input.operation);
      return input.operation === "search" ? searchResult : fetchResult;
    });
    const toolCallId = randomUUID();
    const search = await call(server.socketPath, "/web/search", { protocolVersion: 1, toolCallId, query: "q" })
      .response;
    expect(search.status).toBe(200);
    expect(JSON.parse(search.body).requestId).toBe("r1");
    const fetch = await call(server.socketPath, "/web/fetch", {
      protocolVersion: 1,
      toolCallId,
      urls: ["https://example.com"],
    }).response;
    expect(fetch.status).toBe(200);
    expect(seen).toEqual(["search", "fetch"]);

    // Everything else is closed: unknown path, wrong method, and smuggled execution identity.
    const unknown = await call(server.socketPath, "/web/delete", { protocolVersion: 1, toolCallId, query: "q" })
      .response;
    expect(unknown.status).toBe(404);
    const smuggled = await call(server.socketPath, "/web/search", {
      protocolVersion: 1,
      toolCallId,
      query: "q",
      executionId: randomUUID(),
    }).response;
    expect(smuggled.status).toBe(400);
    const wrongVersion = await call(server.socketPath, "/web/search", { protocolVersion: 2, toolCallId, query: "q" })
      .response;
    expect(wrongVersion.status).toBe(400);
  });

  it("rejects invalid JSON, invalid params, and oversized bodies", async () => {
    const dispatch = async () => searchResult;
    const server = await startGateway(dispatch);
    const toolCallId = randomUUID();
    expect((await call(server.socketPath, "/web/search", {}, { rawBody: "not json" }).response).status).toBe(400);
    expect(
      (await call(server.socketPath, "/web/search", { protocolVersion: 1, toolCallId, query: "" }).response).status,
    ).toBe(400);
    expect(
      (
        await call(server.socketPath, "/web/fetch", {
          protocolVersion: 1,
          toolCallId,
          urls: ["http://169.254.169.254/latest"],
        }).response
      ).status,
    ).toBe(400);
    const huge = JSON.stringify({ protocolVersion: 1, toolCallId, query: "x".repeat(20 * 1024) });
    expect((await call(server.socketPath, "/web/search", {}, { rawBody: huge }).response).status).toBe(413);
  });

  it("maps dispatch failures to bounded error envelopes and preserves lifecycle codes", async () => {
    const server = await startGateway(async () => {
      throw new WebGatewayDispatchError("request_in_progress", "still running");
    });
    const response = await call(server.socketPath, "/web/search", {
      protocolVersion: 1,
      toolCallId: randomUUID(),
      query: "q",
    }).response;
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).error).toEqual({ code: "request_in_progress", message: "still running" });

    const retryable = await startGateway(async () => {
      throw new WebGatewayDispatchError("rate_limited", "limited", { retryable: true });
    });
    const limited = await call(retryable.socketPath, "/web/search", {
      protocolVersion: 1,
      toolCallId: randomUUID(),
      query: "q",
    }).response;
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body).error).toEqual({ code: "rate_limited", message: "limited", retryable: true });
  });

  it("passes the decreasing remaining budget into dispatch and rejects malformed headers", async () => {
    const budgets: number[] = [];
    const server = await startGateway(async (input) => {
      budgets.push(input.remainingMs);
      return searchResult;
    });
    const toolCallId = randomUUID();
    expect(
      (await call(server.socketPath, "/web/search", { protocolVersion: 1, toolCallId, query: "q" }).response).status,
    ).toBe(200);
    expect(budgets[0]).toBeLessThanOrEqual(15_000);
    expect(budgets[0]).toBeGreaterThan(14_000);

    const explicit = await call(
      server.socketPath,
      "/web/search",
      { protocolVersion: 1, toolCallId, query: "q" },
      { headers: { "x-web-remaining-ms": "25" } },
    ).response;
    expect(explicit.status).toBe(200);
    expect(budgets[1]).toBeLessThanOrEqual(25);
    expect(budgets[1]).toBeGreaterThan(0);

    const capped = await call(
      server.socketPath,
      "/web/search",
      { protocolVersion: 1, toolCallId, query: "q" },
      { headers: { "x-web-remaining-ms": "9999999" } },
    ).response;
    expect(capped.status).toBe(200);
    expect(budgets[2]).toBeLessThanOrEqual(15_000);
    expect(budgets[2]).toBeGreaterThan(14_000);

    for (const invalid of ["0", "-5", "1e3", "abc", "12345678", "+1", "0000000"]) {
      const response = await call(
        server.socketPath,
        "/web/search",
        { protocolVersion: 1, toolCallId, query: "q" },
        { headers: { "x-web-remaining-ms": invalid } },
      ).response;
      expect(response.status, `header ${invalid}`).toBe(400);
    }
  });

  it("times out a dispatch that ignores the budget and aborts its signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const server = await startGateway((_input, signal) => {
      observedSignal = signal;
      return new Promise(() => undefined);
    });
    const response = await call(
      server.socketPath,
      "/web/search",
      { protocolVersion: 1, toolCallId: randomUUID(), query: "q" },
      { headers: { "x-web-remaining-ms": "120" } },
    ).response;
    expect(response.status).toBe(504);
    expect(JSON.parse(response.body).error.retryable).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("times out a stalled request body and never dispatches", async () => {
    let dispatches = 0;
    const server = await startGateway(async () => {
      dispatches += 1;
      return searchResult;
    });
    const { response, request } = call(
      server.socketPath,
      "/web/search",
      { protocolVersion: 1, toolCallId: randomUUID(), query: "q" },
      { headers: { "x-web-remaining-ms": "150" }, stall: true },
    );
    const result = await response;
    request.destroy();
    expect(result.status).toBe(504);
    expect(dispatches).toBe(0);
  });

  it("aborts an in-flight dispatch on a real response-side disconnect", async () => {
    let dispatchEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      dispatchEntered = resolve;
    });
    let aborted: () => void = () => undefined;
    const abortObserved = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const server = await startGateway((_input, signal) => {
      dispatchEntered();
      signal.addEventListener("abort", () => aborted(), { once: true });
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const { response, request } = call(server.socketPath, "/web/search", {
      protocolVersion: 1,
      toolCallId: randomUUID(),
      query: "q",
    });
    await entered;
    request.destroy();
    await abortObserved;
    await response.catch(() => undefined);
  });

  it("refuses an occupied path instead of unlinking it", async () => {
    const root = await temporaryRoot("ot-web-gw-occupied-");
    const socketPath = join(root, "gateway.sock");
    const server = await startGateway(async () => searchResult, { socketPath });
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    // The close removed the owned socket; a foreign object left at the same path is refused.
    await writeFile(socketPath, "not a socket");
    await expect(WebToolsGatewayServer.start({ socketPath, dispatch: async () => searchResult })).rejects.toThrow(
      /occupied/,
    );
    expect((await lstat(socketPath)).isFile()).toBe(true);
  });

  it("close of a predecessor cannot remove a successor socket", async () => {
    const root = await temporaryRoot("ot-web-gw-successor-");
    const socketPath = join(root, "gateway.sock");
    const first = await startGateway(async () => searchResult, { socketPath });
    await first.close();
    const second = await startGateway(async () => fetchResult, { socketPath });
    // The predecessor close is idempotent and must not unlink the successor's owned socket.
    await first.close();
    const response = await call(second.socketPath, "/web/fetch", {
      protocolVersion: 1,
      toolCallId: randomUUID(),
      urls: ["https://example.com"],
    }).response;
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).requestId).toBe("r2");
  });

  it("destroys live connections on close so one instance stops the server", async () => {
    const server = await startGateway(async () => searchResult);
    const { response, request } = call(
      server.socketPath,
      "/web/search",
      { protocolVersion: 1, toolCallId: randomUUID(), query: "q" },
      { stall: true },
    );
    await new Promise<void>((resolve, reject) => {
      request.once("socket", (socket) => socket.once("connect", () => resolve()));
      request.once("error", reject);
    });
    const closed = await Promise.race([
      server.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    expect(closed).toBe(true);
    await response.catch(() => undefined);
  });
});
