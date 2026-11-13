import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { MCP_GATEWAY_PATH, runtimeProxyErrorReason } from "./runtime-credential-frames.js";

const LOCAL_TOKEN_PREFIX = "otmg_local_";
const MAX_REQUEST_BYTES = 1024 * 1024;
/**
 * Upstream HTTP statuses that occur strictly before `dispatchInboundRequest` on `/api/v1/mcp`:
 * - 401: in-memory `RuntimeMcpGatewayTokenStore` (`otmg_`) lost across a Server restart/rolling deploy
 * - 404: in-memory `RuntimeExecutionRegistry` lost the execution record (`execution_unknown`)
 * - 409: `McpGatewayExecutionAuthorizer` detected the control connection was replaced (`execution_closed`)
 */
const RETRYABLE_PRE_DISPATCH_STATUSES = new Set([401, 404, 409]);

export interface RuntimeMcpGatewayLoopbackOptions {
  readonly serverUrl: string;
  readonly initialToken: string;
  readonly refreshToken: () => Promise<string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: Pick<ClientLogger, "debug" | "warn">;
}

export class RuntimeMcpGatewayLoopback {
  readonly #upstreamUrl: string;
  readonly #localToken: string;
  readonly #refreshTokenFn: () => Promise<string | undefined>;
  readonly #fetch: typeof fetch;
  readonly #logger: Pick<ClientLogger, "debug" | "warn">;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #inFlightRequests = new Set<AbortController>();
  readonly #url: string;
  #upstreamToken: string;
  #refreshInFlight?: Promise<string | undefined>;
  #closed = false;

  private constructor(options: {
    upstreamUrl: string;
    localToken: string;
    initialToken: string;
    refreshToken: () => Promise<string | undefined>;
    fetchImpl: typeof fetch;
    logger: Pick<ClientLogger, "debug" | "warn">;
    server: Server;
    port: number;
  }) {
    this.#upstreamUrl = options.upstreamUrl;
    this.#localToken = options.localToken;
    this.#upstreamToken = options.initialToken;
    this.#refreshTokenFn = options.refreshToken;
    this.#fetch = options.fetchImpl;
    this.#logger = options.logger;
    this.#server = options.server;
    this.#url = `http://127.0.0.1:${options.port}${MCP_GATEWAY_PATH}`;
    this.#server.on("connection", (socket) => {
      if (this.#closed) {
        socket.destroy();
        return;
      }
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
    this.#server.on("request", (req, res) => {
      void this.#handleRequest(req, res).catch((error: unknown) => {
        this.#logger.warn(
          { code: "mcp_gateway_request_handler_failed", reason: runtimeProxyErrorReason(error) },
          "Local MCP gateway request handler failed",
        );
        if (!res.headersSent && !res.destroyed) {
          writeJson(res, 400, { error: "bad_request" });
        } else if (!res.destroyed) {
          res.destroy();
        }
      });
    });
  }

  static async start(options: RuntimeMcpGatewayLoopbackOptions): Promise<RuntimeMcpGatewayLoopback> {
    const upstreamUrl = new URL(MCP_GATEWAY_PATH, options.serverUrl).toString();
    const localToken = `${LOCAL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const server = createServer();
    const port = await listenLoopback(server);
    // Do not hold the Node event loop open if a caller forgets to clean up in a test.
    server.unref();
    return new RuntimeMcpGatewayLoopback({
      upstreamUrl,
      localToken,
      initialToken: options.initialToken,
      refreshToken: options.refreshToken,
      fetchImpl: options.fetchImpl ?? fetch,
      logger: options.logger ?? createLogger("runtime-mcp-gateway-loopback"),
      server,
      port,
    });
  }

  get url(): string {
    return this.#url;
  }

  get token(): string {
    return this.#localToken;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#inFlightRequests) {
      controller.abort();
    }
    this.#inFlightRequests.clear();
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
  }

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#validateInboundRequest(req, res)) {
      return;
    }
    const { controller, signal, cleanup } = this.#bindRequestSignal(req, res);
    try {
      const body = await this.#readValidatedBody(req, res, signal);
      if (!body) {
        return;
      }
      const { contentType, accept } = extractForwardHeaders(req);
      const upstreamResponse = await this.#dispatchUpstream(res, contentType, accept, body, signal);
      if (!upstreamResponse) {
        return;
      }
      await this.#relayUpstreamResponse(upstreamResponse, res, signal);
    } finally {
      this.#inFlightRequests.delete(controller);
      cleanup();
    }
  }

  #bindRequestSignal(
    req: IncomingMessage,
    res: ServerResponse,
  ): { controller: AbortController; signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const abortIfPending = () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    req.once("aborted", abortIfPending);
    res.once("close", abortIfPending);
    if (this.#closed || req.destroyed) {
      controller.abort();
    }
    this.#inFlightRequests.add(controller);
    return {
      controller,
      signal: controller.signal,
      cleanup: () => {
        req.off("aborted", abortIfPending);
        res.off("close", abortIfPending);
      },
    };
  }

  async #readValidatedBody(
    req: IncomingMessage,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<Buffer | undefined> {
    try {
      return await readRequestBody(req, MAX_REQUEST_BYTES, signal);
    } catch (error) {
      if (!signal.aborted) {
        const isTooLarge = error instanceof RequestBodyTooLargeError;
        writeJson(res, isTooLarge ? 413 : 400, { error: isTooLarge ? "payload_too_large" : "bad_request" });
      }
      return undefined;
    }
  }

  async #dispatchUpstream(
    res: ServerResponse,
    contentType: string,
    accept: string,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<Response | undefined> {
    try {
      return await this.#forwardWithRefresh(contentType, accept, body, signal);
    } catch (error) {
      if (signal.aborted) {
        this.#logger.debug(
          { code: "mcp_gateway_request_cancelled", reason: runtimeProxyErrorReason(error) },
          "Cancelled in-flight upstream MCP gateway request",
        );
        destroyIfOpen(res);
        return undefined;
      }
      this.#logger.warn(
        { code: "mcp_gateway_upstream_unreachable", reason: runtimeProxyErrorReason(error) },
        "Upstream MCP gateway request failed",
      );
      writeJson(res, 502, { error: "upstream_unavailable" });
      return undefined;
    }
  }

  #validateInboundRequest(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.#closed) {
      writeJson(res, 503, { error: "gateway_closed" });
      return false;
    }
    const pathname = parseRequestPathname(req.url);
    if (!pathname) {
      writeJson(res, 400, { error: "bad_request" });
      return false;
    }
    if (pathname !== MCP_GATEWAY_PATH) {
      writeJson(res, 404, { error: "not_found" });
      return false;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return false;
    }
    const presented = extractBearer(req.headers.authorization);
    if (!presented || !tokensMatch(presented, this.#localToken)) {
      writeJson(res, 401, { error: "unauthorized" });
      return false;
    }
    return true;
  }

  async #forwardWithRefresh(contentType: string, accept: string, body: Buffer, signal: AbortSignal): Promise<Response> {
    const tokenUsed = this.#upstreamToken;
    const initialResponse = await this.#forward(tokenUsed, contentType, accept, body, signal);
    if (!RETRYABLE_PRE_DISPATCH_STATUSES.has(initialResponse.status) || this.#closed || signal.aborted) {
      return initialResponse;
    }
    this.#logger.debug(
      { code: "mcp_gateway_token_refresh_start", status: initialResponse.status },
      "Upstream MCP gateway rejected bearer before dispatch; refreshing execution token",
    );
    const refreshedToken = await raceWithSignal(this.#refreshUpstreamToken(tokenUsed), signal);
    if (!refreshedToken || this.#closed || signal.aborted) {
      this.#logger.warn(
        { code: "mcp_gateway_token_refresh_unavailable", status: initialResponse.status },
        "Could not refresh upstream MCP gateway bearer after pre-dispatch rejection",
      );
      return initialResponse;
    }
    void initialResponse.body?.cancel().catch(() => undefined);
    const replayedResponse = await this.#forward(refreshedToken, contentType, accept, body, signal);
    this.#logger.debug(
      { code: "mcp_gateway_token_refresh_succeeded", status: replayedResponse.status },
      "Replayed MCP gateway request with refreshed execution token",
    );
    return replayedResponse;
  }

  async #relayUpstreamResponse(upstreamResponse: Response, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const cancelUpstreamBody = () => {
      void upstreamResponse.body?.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", cancelUpstreamBody, { once: true });
    try {
      const responseBuffer = Buffer.from(await raceWithSignal(upstreamResponse.arrayBuffer(), signal));
      writeUpstreamResponse(res, upstreamResponse, responseBuffer);
    } catch (error) {
      cancelUpstreamBody();
      this.#handleRelayFailure(res, error, signal);
    } finally {
      signal.removeEventListener("abort", cancelUpstreamBody);
    }
  }

  #handleRelayFailure(res: ServerResponse, error: unknown, signal: AbortSignal): void {
    if (signal.aborted) {
      this.#logger.debug(
        { code: "mcp_gateway_response_cancelled", reason: runtimeProxyErrorReason(error) },
        "Cancelled upstream MCP gateway response read",
      );
      destroyIfOpen(res);
      return;
    }
    this.#logger.warn(
      { code: "mcp_gateway_response_read_failed", reason: runtimeProxyErrorReason(error) },
      "Failed to relay upstream MCP gateway response body",
    );
    if (!res.headersSent) {
      writeJson(res, 502, { error: "upstream_unavailable" });
    } else {
      res.destroy();
    }
  }

  async #forward(
    token: string,
    contentType: string,
    accept: string,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.#fetch(this.#upstreamUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": contentType,
        accept,
      },
      body: new Uint8Array(body),
      signal,
    });
  }

  async #refreshUpstreamToken(failedToken: string): Promise<string | undefined> {
    if (this.#upstreamToken !== failedToken) {
      return this.#upstreamToken;
    }
    if (!this.#refreshInFlight) {
      const refreshPromise = this.#refreshTokenFn()
        .then((nextToken) => {
          if (nextToken) {
            this.#upstreamToken = nextToken;
          }
          return nextToken;
        })
        .catch((error: unknown) => {
          this.#logger.warn(
            { code: "mcp_gateway_token_refresh_failed", reason: runtimeProxyErrorReason(error) },
            "MCP gateway token refresh failed",
          );
          return undefined;
        })
        .finally(() => {
          if (this.#refreshInFlight === refreshPromise) {
            this.#refreshInFlight = undefined;
          }
        });
      this.#refreshInFlight = refreshPromise;
    }
    return this.#refreshInFlight;
  }
}

class RequestBodyTooLargeError extends Error {}

function extractForwardHeaders(req: IncomingMessage): { contentType: string; accept: string } {
  const contentType =
    typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/json";
  const accept = typeof req.headers.accept === "string" ? req.headers.accept : "application/json, text/event-stream";
  return { contentType, accept };
}

function writeUpstreamResponse(res: ServerResponse, upstreamResponse: Response, responseBuffer: Buffer): void {
  const headers: Record<string, string> = {
    "content-length": String(responseBuffer.byteLength),
  };
  const upstreamContentType = upstreamResponse.headers.get("content-type");
  if (upstreamContentType) headers["content-type"] = upstreamContentType;
  const upstreamCacheControl = upstreamResponse.headers.get("cache-control");
  if (upstreamCacheControl) headers["cache-control"] = upstreamCacheControl;
  res.writeHead(upstreamResponse.status, headers);
  res.end(responseBuffer);
}

function destroyIfOpen(res: ServerResponse): void {
  if (!res.writableEnded && !res.destroyed) {
    res.destroy();
  }
}

function parseRequestPathname(rawUrl: string | undefined): string | undefined {
  if (!rawUrl || !rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
    return undefined;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1").pathname;
  } catch {
    return undefined;
  }
}

function createAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  error.name = "AbortError";
  return error;
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(createAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

function tokensMatch(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  if (leftBuf.byteLength !== rightBuf.byteLength) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

function readRequestBody(req: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        req.resume();
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, string>): void {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
  });
  res.end(body);
}

function listenLoopback(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Loopback server did not bind a TCP port"));
        return;
      }
      resolve((address as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}
