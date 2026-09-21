import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * Bounded local model-upstream fixture for the E4 Cloud model proxy. It is a real `node:http`
 * server on 127.0.0.1 — no public provider, no credentials — and the fixed master key is a
 * sentinel string so tests can prove the proxy never relays upstream auth/error material.
 *
 * `FIXTURE_MASTER_KEY` is the value tests configure as the proxy's `masterKey`; the fixture echoes
 * it in error bodies and response headers on purpose.
 */

export const FIXTURE_MASTER_KEY = "fixture-master-key-sentinel-9f1c0d";
export const FIXTURE_ERROR_BODY_MARKER = "fixture-upstream-auth-echo";
export const FIXTURE_RESPONSE_HEADER = "x-fixture-upstream-secret";

export type FixtureHandler =
  | { kind: "json"; payload?: unknown }
  | { kind: "sse"; chunks?: string[] }
  | { kind: "slow-sse"; chunkIntervalMs?: number }
  | { kind: "stall"; declaredLength?: number }
  | { kind: "overflow"; totalBytes?: number; chunkBytes?: number }
  | { kind: "backpressure"; totalBytes?: number; chunkBytes?: number }
  | { kind: "redirect"; location: string }
  | { kind: "error"; status: number }
  | { kind: "empty" }
  | { kind: "bad-content-type" };

export interface CloudModelUpstreamStats {
  hits: number;
  methods: string[];
  paths: string[];
  authorizations: (string | undefined)[];
  sawFixtureMasterKey: boolean;
  lastRequestBody: unknown;
  responseBytesSent: number;
  prematureClose: boolean;
  prematureCloseAtMs: number | null;
}

export interface CloudModelUpstream {
  baseUrl: string;
  stats: CloudModelUpstreamStats;
  close(): Promise<void>;
}

function chunkBuffer(size: number): Buffer {
  return Buffer.alloc(size, 0x61);
}

async function respond(
  handler: FixtureHandler,
  response: ServerResponse,
  stats: CloudModelUpstreamStats,
): Promise<void> {
  switch (handler.kind) {
    case "json": {
      const payload = JSON.stringify(handler.payload ?? { id: "chatcmpl-fixture", choices: [] });
      response.writeHead(200, {
        "content-type": "application/json",
        [FIXTURE_RESPONSE_HEADER]: FIXTURE_MASTER_KEY,
      });
      stats.responseBytesSent += Buffer.byteLength(payload);
      response.end(payload);
      return;
    }
    case "sse": {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of handler.chunks ?? ["fixture-chunk-0", "fixture-chunk-1", "fixture-chunk-2"]) {
        const payload = `data: ${chunk}\n\n`;
        stats.responseBytesSent += Buffer.byteLength(payload);
        response.write(payload);
      }
      const done = "data: [DONE]\n\n";
      stats.responseBytesSent += Buffer.byteLength(done);
      response.end(done);
      return;
    }
    case "slow-sse": {
      response.writeHead(200, { "content-type": "text/event-stream" });
      let index = 0;
      const timer = setInterval(() => {
        if (response.destroyed || response.writableEnded) {
          clearInterval(timer);
          return;
        }
        const payload = `data: fixture-chunk-${index}\n\n`;
        index += 1;
        stats.responseBytesSent += Buffer.byteLength(payload);
        response.write(payload);
      }, handler.chunkIntervalMs ?? 40);
      response.on("close", () => clearInterval(timer));
      return;
    }
    case "stall": {
      response.writeHead(200, {
        "content-type": "application/json",
        ...(handler.declaredLength === undefined ? {} : { "content-length": handler.declaredLength }),
      });
      response.flushHeaders();
      return;
    }
    case "overflow":
    case "backpressure": {
      const totalBytes = handler.totalBytes ?? (handler.kind === "overflow" ? 3 * 32 * 1024 : 64 * 1024 * 1024);
      const chunk = chunkBuffer(handler.chunkBytes ?? 8 * 1024);
      response.writeHead(200, { "content-type": "application/json" });
      let sent = 0;
      const pump = (): void => {
        if (response.destroyed || response.writableEnded) return;
        if (sent >= totalBytes) {
          response.end();
          return;
        }
        const size = Math.min(chunk.byteLength, totalBytes - sent);
        sent += size;
        stats.responseBytesSent += size;
        // Pace chunks on the event loop so the proxy sees a real multi-chunk stream instead of
        // one coalesced buffer, which would exercise only the pre-body cap path.
        if (response.write(chunk.subarray(0, size))) setImmediate(pump);
        else response.once("drain", pump);
      };
      pump();
      return;
    }
    case "redirect": {
      response.writeHead(302, { location: handler.location });
      response.end("redirect-fixture");
      return;
    }
    case "error": {
      const body = JSON.stringify({
        error: {
          message: `${FIXTURE_ERROR_BODY_MARKER} authorization=${stats.authorizations.at(-1) ?? ""} key=${FIXTURE_MASTER_KEY}`,
        },
      });
      response.writeHead(handler.status, {
        "content-type": "application/json",
        [FIXTURE_RESPONSE_HEADER]: FIXTURE_MASTER_KEY,
      });
      response.write(body);
      response.end();
      return;
    }
    case "empty": {
      response.writeHead(200, { "content-type": "application/json" });
      response.end();
      return;
    }
    case "bad-content-type": {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>not a model response</html>");
      return;
    }
  }
}

export async function startCloudModelUpstream(handler: FixtureHandler): Promise<CloudModelUpstream> {
  const sockets = new Set<Socket>();
  const stats: CloudModelUpstreamStats = {
    authorizations: [],
    hits: 0,
    methods: [],
    paths: [],
    prematureClose: false,
    prematureCloseAtMs: null,
    responseBytesSent: 0,
    sawFixtureMasterKey: false,
    lastRequestBody: undefined,
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    stats.hits += 1;
    stats.methods.push(request.method ?? "");
    stats.paths.push(request.url ?? "");
    const authorization = request.headers.authorization;
    stats.authorizations.push(authorization);
    if (authorization === `Bearer ${FIXTURE_MASTER_KEY}`) stats.sawFixtureMasterKey = true;
    const requestStartedAt = Date.now();
    let responseFinished = false;
    response.on("finish", () => {
      responseFinished = true;
    });
    response.on("close", () => {
      if (!responseFinished && !response.writableEnded) {
        stats.prematureClose = true;
        stats.prematureCloseAtMs = Date.now() - requestStartedAt;
      }
    });
    const requestChunks: Buffer[] = [];
    request.on("data", (value: Buffer) => {
      if (requestChunks.length < 128) requestChunks.push(value);
    });
    request.on("end", () => {
      try {
        stats.lastRequestBody = JSON.parse(Buffer.concat(requestChunks).toString("utf8"));
      } catch {
        stats.lastRequestBody = undefined;
      }
      respond(handler, response, stats).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    stats,
  };
}
