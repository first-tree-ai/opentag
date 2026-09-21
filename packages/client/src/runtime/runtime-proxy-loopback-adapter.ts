import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import {
  RUNTIME_PROVIDER_ORIGIN_HEADER,
  type RuntimeProxyProvider,
  runtimeProxyErrorReason,
} from "./runtime-credential-frames.js";
import type { RuntimeProxyStreamResponse } from "./runtime-proxy-data-client.js";

const execFileAsync = promisify(execFile);

/**
 * Server-issued upload/download handle path. Handles keep the provider's fixed origin and
 * never embed platform tokens; the Server revalidates every use and resolves the native
 * upstream URL only in trusted memory.
 */
export const RUNTIME_PROXY_HANDLE_PATH_PREFIX = "/__opentag__/handles/";

/**
 * Reserved origin header for the GitHub proxy adapter: the exact CONNECT host distinguishes
 * `github.com` Git traffic from `api.github.com` REST/GraphQL traffic. Callers cannot set it;
 * the loopback adapter overwrites it and the Server ignores any caller host/URL. The constant
 * is defined by the Shared wire authority and re-exported for the parent harness.
 */
export { RUNTIME_PROVIDER_ORIGIN_HEADER };

/** Fixed platform CONNECT allowlist; authentication and target policy are revalidated on the Server. */
export const RUNTIME_PROXY_ALLOWED_CONNECT_HOSTS: readonly string[] = [
  "github.com",
  "api.github.com",
  "slack.com",
  "open.feishu.cn",
  "open.larksuite.com",
];

const CONNECT_HOST_PROVIDERS: Readonly<Record<string, RuntimeProxyProvider>> = {
  "github.com": "github",
  "api.github.com": "github",
  "slack.com": "slack",
  "open.feishu.cn": "feishu",
  "open.larksuite.com": "feishu",
};

const FEISHU_TENANT_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_TENANT_TOKEN_RESPONSE_MAX_BYTES = 256 * 1024;

/**
 * The native Slack CLI sends its `token` in a urlencoded form body by default. Only bounded
 * urlencoded bodies are inspected; multipart and file streams are never buffered.
 */
const SLACK_FORM_TOKEN_MAX_BYTES = 64 * 1024;
const URLENCODED_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-encoding",
  "content-length",
  "content-type",
  "git-protocol",
  "user-agent",
]);

const RESPONSE_HEADER_DENYLIST = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"]);

export class RuntimeProxyLoopbackError extends Error {
  constructor(
    readonly code: "ca_generation_failed" | "listen_failed" | "adapter_closed",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeProxyLoopbackError";
  }
}

export interface RuntimeProxyLoopbackCaMaterial {
  readonly certPath: string;
  readonly keyPath: string;
}

export interface RuntimeProxyAdapterStreamRequest {
  readonly body: AsyncIterable<Uint8Array>;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly path: string;
  readonly provider: RuntimeProxyProvider;
  readonly signal: AbortSignal;
}

export interface RuntimeProxyLoopbackAdapterOptions {
  /** The single execution this dedicated entry serves. */
  readonly executionId: string;
  readonly generateCa?: (materialDir: string) => Promise<RuntimeProxyLoopbackCaMaterial>;
  /**
   * Execution-local handles held by the Sandbox. Used only to substitute the harmless
   * Server tenant-token placeholder for `lark-cli`; the Server keeps the real token.
   */
  readonly localHandleFor?: (provider: RuntimeProxyProvider) => string | undefined;
  readonly logger?: Pick<ClientLogger, "debug" | "warn">;
  /** Private per-execution material directory holding the ephemeral CA. */
  readonly materialDir: string;
  /** Relay stream opening with the current capability already bound. */
  readonly openStream: (request: RuntimeProxyAdapterStreamRequest) => Promise<RuntimeProxyStreamResponse>;
  /** Hash-verified local handle check bound to this execution. */
  readonly verifyHandle: (provider: RuntimeProxyProvider, handle: string) => boolean;
}

interface PendingConnect {
  readonly host: string;
  readonly provider?: RuntimeProxyProvider;
}

/**
 * Per-execution loopback TLS adapter: a CONNECT proxy for git/gh/slack/lark-cli with a fixed
 * platform host allowlist plus a direct HTTPS endpoint for the Slack `--apihost` launcher.
 * It terminates TLS with an ephemeral execution-scoped CA, challenges credential-less Git
 * requests with 401, verifies the execution-local handle, and forwards requests through the
 * trusted Relay. Platform credentials never appear here; `Authorization`, `Cookie`, and
 * `Host` are never forwarded upstream. Server-issued handle URLs stay on the provider's
 * fixed origin (`<origin>/__opentag__/handles/<id>`) and are resolved Server-side.
 */
export class RuntimeProxyLoopbackAdapter {
  readonly #ca: RuntimeProxyLoopbackCaMaterial;
  readonly #connectServer: http.Server;
  readonly #directServer: https.Server;
  readonly #executionId: string;
  readonly #localHandleFor?: (provider: RuntimeProxyProvider) => string | undefined;
  readonly #logger: Pick<ClientLogger, "debug" | "warn">;
  readonly #openStream: RuntimeProxyLoopbackAdapterOptions["openStream"];
  readonly #sockets = new Set<net.Socket>();
  readonly #verifyHandle: RuntimeProxyLoopbackAdapterOptions["verifyHandle"];
  #closed = false;
  #connectPort = 0;
  #directPort = 0;

  private constructor(options: RuntimeProxyLoopbackAdapterOptions, ca: RuntimeProxyLoopbackCaMaterial) {
    this.#ca = ca;
    this.#executionId = options.executionId;
    this.#localHandleFor = options.localHandleFor;
    this.#logger = options.logger ?? createLogger("runtime-proxy-loopback");
    this.#openStream = options.openStream;
    this.#verifyHandle = options.verifyHandle;
    this.#connectServer = http.createServer((_request, response) => {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end();
    });
    this.#directServer = https.createServer((request, response) => {
      void this.#handleDirectRequest(request, response);
    });
  }

  /** Loopback HTTP CONNECT endpoint for git/gh HTTPS_PROXY and lark-cli proxy config. */
  get connectProxyUrl(): string {
    return `http://127.0.0.1:${this.#connectPort}`;
  }

  /** Loopback HTTPS endpoint the Slack launcher pins through `--apihost`. */
  get slackApiHost(): string {
    return `https://127.0.0.1:${this.#directPort}`;
  }

  /** Execution-scoped CA public certificate path for CLI trust configuration. */
  get caCertPath(): string {
    return this.#ca.certPath;
  }

  get executionId(): string {
    return this.#executionId;
  }

  get closed(): boolean {
    return this.#closed;
  }

  static async start(options: RuntimeProxyLoopbackAdapterOptions): Promise<RuntimeProxyLoopbackAdapter> {
    const generateCa = options.generateCa ?? generateExecutionCa;
    // Per-execution material directory first: the CA and CLI material never leave it.
    await mkdir(options.materialDir, { mode: 0o700, recursive: true });
    await chmod(options.materialDir, 0o700);
    const ca = await generateCa(options.materialDir);
    const adapter = new RuntimeProxyLoopbackAdapter(options, ca);
    await adapter.#listen();
    return adapter;
  }

  async #listen(): Promise<void> {
    const cert = await readFile(this.#ca.certPath, "utf8");
    const key = await readFile(this.#ca.keyPath, "utf8");
    const secureContext = tls.createSecureContext({ cert, key });
    this.#directServer.setSecureContext?.({ cert, key });
    const inner = http.createServer((request, response) => {
      void this.#handleInnerRequest(request, response).catch((error: unknown) => {
        this.#logger.debug(
          { code: "loopback_request_failed", error: runtimeProxyErrorReason(error) },
          "Loopback request handling failed",
        );
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
        response.end();
      });
    });
    this.#connectServer.on("connect", (request, socket, head) => {
      this.#handleConnect(request, socket as net.Socket, head, inner, secureContext);
    });
    for (const server of [this.#connectServer, this.#directServer]) {
      server.on("connection", (socket) => this.#track(socket));
      server.on("secureConnection", (socket) => this.#track(socket));
    }
    inner.on("connection", (socket) => this.#track(socket));
    try {
      this.#connectPort = await listenLoopback(this.#connectServer);
      this.#directPort = await listenLoopback(this.#directServer);
    } catch (error) {
      this.#connectServer.close();
      this.#directServer.close();
      throw new RuntimeProxyLoopbackError(
        "listen_failed",
        `The loopback adapter could not listen: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Stop both listeners and destroy every tunneled socket. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const socket of [...this.#sockets]) socket.destroy();
    await Promise.all(
      [this.#connectServer, this.#directServer].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
          }),
      ),
    );
  }

  #track(socket: net.Socket): void {
    if (this.#closed) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
  }

  #handleConnect(
    request: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    inner: http.Server,
    secureContext: tls.SecureContext,
  ): void {
    const target = parseConnectTarget(request.url ?? "");
    if (!target || !RUNTIME_PROXY_ALLOWED_CONNECT_HOSTS.includes(target.host)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (this.#closed) {
      socket.destroy();
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    const encrypted = new tls.TLSSocket(socket, { isServer: true, secureContext });
    encrypted.on("error", () => encrypted.destroy());
    (encrypted as unknown as { __opentagConnect?: PendingConnect }).__opentagConnect = {
      host: target.host,
      ...(CONNECT_HOST_PROVIDERS[target.host] ? { provider: CONNECT_HOST_PROVIDERS[target.host] } : {}),
    };
    this.#track(encrypted);
    inner.emit("connection", encrypted);
  }

  async #handleDirectRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const path = originRelativePath(request.url ?? "");
      if (!path) {
        replyText(response, 400, "bad_request");
        return;
      }
      if (isHandlePath(path)) {
        await this.#handleHandleRequest("slack", request, response, path, "slack.com");
        return;
      }
      await this.#handleProviderRequest("slack", request, response, path, "slack.com");
    } catch (error) {
      this.#logger.debug(
        { code: "loopback_slack_request_failed", error: runtimeProxyErrorReason(error) },
        "Loopback Slack request handling failed",
      );
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end();
    }
  }

  async #handleInnerRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const pending = (request.socket as unknown as { __opentagConnect?: PendingConnect }).__opentagConnect;
    if (!pending?.provider) {
      replyText(response, 403, "forbidden");
      return;
    }
    const path = originRelativePath(request.url ?? "");
    if (!path) {
      replyText(response, 400, "bad_request");
      return;
    }
    if (isHandlePath(path)) {
      await this.#handleHandleRequest(pending.provider, request, response, path, pending.host);
      return;
    }
    await this.#handleProviderRequest(pending.provider, request, response, path, pending.host);
  }

  /** Ordinary provider request: execution-local handle verification, no upstream identity. */
  async #handleProviderRequest(
    provider: RuntimeProxyProvider,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    path: string,
    originHost: string,
  ): Promise<void> {
    if (provider === "feishu" && isFeishuTenantTokenExchange(request.method, path)) {
      await this.#handleFeishuTenantToken(request, response, path, originHost);
      return;
    }
    const authorization = await authorizeProviderRequest({
      provider,
      request,
      verifyHandle: this.#verifyHandle,
    });
    if (!authorization.ok) {
      if (authorization.challenge) {
        // The credential-less challenge keeps the native Git credential-helper flow.
        response.writeHead(401, { "www-authenticate": 'Basic realm="OpenTag"', "content-type": "text/plain" });
        response.end("authentication required\n");
        return;
      }
      replyText(response, authorization.status, authorization.code);
      return;
    }
    if (this.#closed) {
      replyText(response, 503, "adapter_closed");
      return;
    }
    await this.#forward(provider, request, response, path, originHost, authorization.override);
  }

  /**
   * Server-issued handle URL: the path embeds the Server handle and the Relay revalidates it
   * before the Server resolves the protected native URL in memory. No local handle is needed.
   */
  async #handleHandleRequest(
    provider: RuntimeProxyProvider,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    path: string,
    originHost: string,
  ): Promise<void> {
    if (this.#closed) {
      replyText(response, 503, "adapter_closed");
      return;
    }
    await this.#forward(provider, request, response, path, originHost);
  }

  /**
   * `lark-cli` obtains a tenant token through the fixed exchange endpoint. The Server answers
   * locally with a harmless placeholder (never the Runner capability); this adapter replaces
   * that placeholder with the execution-local handle so the native CLI keeps working and no
   * usable token ever reaches the Sandbox.
   */
  async #handleFeishuTenantToken(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    path: string,
    originHost: string,
  ): Promise<void> {
    const localHandle = this.#localHandleFor?.("feishu");
    if (!localHandle || this.#closed) {
      if (this.#closed) {
        replyText(response, 503, "adapter_closed");
        return;
      }
      await this.#forward("feishu", request, response, path, originHost);
      return;
    }
    const abort = new AbortController();
    request.on("aborted", () => abort.abort(new Error("request aborted")));
    response.on("close", () => {
      if (!response.writableEnded) abort.abort(new Error("response closed"));
    });
    let upstream: RuntimeProxyStreamResponse;
    try {
      upstream = await this.#openStream({
        provider: "feishu",
        method: request.method ?? "GET",
        path,
        headers: forwardedRequestHeaders("feishu", request.headers, originHost),
        body: request as AsyncIterable<Uint8Array>,
        signal: abort.signal,
      });
    } catch (error) {
      this.#logger.debug(
        { code: "loopback_stream_open_failed", error: runtimeProxyErrorReason(error) },
        "Loopback stream open failed",
      );
      replyText(response, 503, "upstream_unavailable");
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    try {
      for await (const chunk of upstream.body) {
        total += chunk.byteLength;
        if (total > FEISHU_TENANT_TOKEN_RESPONSE_MAX_BYTES) {
          tooLarge = true;
          upstream.cancel?.("response_too_large");
          break;
        }
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      this.#logger.debug(
        { code: "loopback_stream_body_failed", error: runtimeProxyErrorReason(error) },
        "Stream body failed",
      );
      response.destroy();
      return;
    }
    if (tooLarge) {
      replyText(response, 502, "upstream_response_too_large");
      return;
    }
    const body = substituteFeishuTenantToken(Buffer.concat(chunks).toString("utf8"), localHandle);
    const rewritten = Buffer.from(body, "utf8");
    response.writeHead(upstream.status, {
      ...filteredResponseHeaders(upstream.headers),
      "content-length": String(rewritten.byteLength),
    });
    response.end(rewritten);
  }

  async #forward(
    provider: RuntimeProxyProvider,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    path: string,
    originHost: string,
    override?: { readonly body: AsyncIterable<Uint8Array>; readonly headers: http.IncomingHttpHeaders },
  ): Promise<void> {
    const abort = new AbortController();
    request.on("aborted", () => abort.abort(new Error("request aborted")));
    response.on("close", () => {
      if (!response.writableEnded) abort.abort(new Error("response closed"));
    });
    let upstream: RuntimeProxyStreamResponse;
    try {
      upstream = await this.#openStream({
        provider,
        method: request.method ?? "GET",
        path,
        headers: forwardedRequestHeaders(provider, override?.headers ?? request.headers, originHost),
        body: override?.body ?? (request as AsyncIterable<Uint8Array>),
        signal: abort.signal,
      });
    } catch (error) {
      this.#logger.debug(
        { code: "loopback_stream_open_failed", error: runtimeProxyErrorReason(error) },
        "Loopback stream open failed",
      );
      replyText(response, 503, "upstream_unavailable");
      return;
    }
    const onAbort = () => upstream.cancel?.("client_aborted");
    abort.signal.addEventListener("abort", onAbort, { once: true });
    response.writeHead(upstream.status, filteredResponseHeaders(upstream.headers));
    try {
      for await (const chunk of upstream.body) {
        if (response.writableEnded) break;
        if (!response.write(chunk)) await once(response, "drain");
      }
    } catch (error) {
      this.#logger.debug(
        { code: "loopback_stream_body_failed", error: runtimeProxyErrorReason(error) },
        "Stream body failed",
      );
      upstream.cancel?.("consumer_error");
      response.destroy();
      return;
    } finally {
      abort.signal.removeEventListener("abort", onAbort);
    }
    response.end();
  }
}

/**
 * Ephemeral per-execution CA via the platform OpenSSL CLI (the checked-in probe method).
 * The same self-signed CA cert carries every allowlisted SAN and terminates loopback
 * TLS; only Sandbox CLI subprocesses trust it, never the system store. The key is
 * untrusted Sandbox-side material: it cannot issue capabilities or platform tokens.
 */
export async function generateExecutionCa(materialDir: string): Promise<RuntimeProxyLoopbackCaMaterial> {
  const keyPath = join(materialDir, "loopback-ca-key.pem");
  const certPath = join(materialDir, "loopback-ca.pem");
  const subjectAltName = [
    "DNS:github.com",
    "DNS:api.github.com",
    "DNS:slack.com",
    "DNS:open.feishu.cn",
    "DNS:open.larksuite.com",
    "DNS:localhost",
    "IP:127.0.0.1",
  ].join(",");
  try {
    await execFileAsync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=OpenTag execution loopback CA",
        "-addext",
        `subjectAltName=${subjectAltName}`,
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { timeout: 30_000 },
    );
  } catch (error) {
    throw new RuntimeProxyLoopbackError(
      "ca_generation_failed",
      `The execution loopback CA could not be generated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await chmod(keyPath, 0o600);
  await chmod(certPath, 0o644);
  return { certPath, keyPath };
}

function parseConnectTarget(url: string): { host: string; port: number } | undefined {
  const match = /^([a-z0-9.-]+):(\d+)$/i.exec(url.trim());
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  const port = Number(match[2]);
  if (port !== 443) return undefined;
  return { host: match[1].toLowerCase(), port };
}

function originRelativePath(url: string): string | undefined {
  if (!url.startsWith("/") || url.startsWith("//")) return undefined;
  return url;
}

function isHandlePath(path: string): boolean {
  return path.startsWith(RUNTIME_PROXY_HANDLE_PATH_PREFIX);
}

function isFeishuTenantTokenExchange(method: string | undefined, path: string): boolean {
  return method?.toUpperCase() === "POST" && path.split("?", 1)[0] === FEISHU_TENANT_TOKEN_PATH;
}

/** Replace the Server placeholder with the execution-local handle; leave other bodies intact. */
function substituteFeishuTenantToken(body: string, localHandle: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  const record = parsed as Record<string, unknown>;
  if (typeof record.tenant_access_token !== "string") return body;
  record.tenant_access_token = localHandle;
  return JSON.stringify(record);
}

interface ProviderAuthorizationOverride {
  readonly body: AsyncIterable<Uint8Array>;
  readonly headers: http.IncomingHttpHeaders;
}

type ProviderAuthorization =
  | { readonly ok: true; readonly override?: ProviderAuthorizationOverride }
  | { readonly ok: false; readonly challenge?: boolean; readonly code: string; readonly status: number };

type SlackFormInspection =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly reason: "duplicate" | "oversized" }
  | { readonly body: Buffer; readonly kind: "body"; readonly token?: string };

/**
 * Local handle authorization for one provider request. Git/GitHub keep the 401 challenge flow;
 * Slack accepts the handle from `Authorization` or from the native urlencoded form `token` field,
 * rejects conflicting or duplicated credentials before any upstream work, and scrubs the form
 * field so the local handle is never forwarded. Multipart/file streams are never buffered.
 */
async function authorizeProviderRequest(input: {
  readonly provider: RuntimeProxyProvider;
  readonly request: http.IncomingMessage;
  readonly verifyHandle: (provider: RuntimeProxyProvider, handle: string) => boolean;
}): Promise<ProviderAuthorization> {
  const { provider, request, verifyHandle } = input;
  const headerHandle = extractProviderHandle(provider, headerValue(request.headers.authorization));
  const form = provider === "slack" ? await inspectSlackFormToken(request) : ({ kind: "none" } as const);
  if (form.kind === "invalid") {
    return form.reason === "oversized"
      ? { ok: false, status: 413, code: "payload_too_large" }
      : { ok: false, status: 403, code: "invalid_credentials" };
  }
  const formHandle = form.kind === "body" ? form.token : undefined;
  if (headerHandle && formHandle && headerHandle !== formHandle) {
    return { ok: false, status: 403, code: "conflicting_credentials" };
  }
  const handle = headerHandle ?? formHandle;
  if (!handle) {
    return provider === "feishu"
      ? { ok: true }
      : { ok: false, status: 401, code: "authentication_required", challenge: true };
  }
  if (!verifyHandle(provider, handle)) return { ok: false, status: 403, code: "invalid_handle" };
  if (form.kind !== "body") return { ok: true };
  // The bounded body was consumed for inspection; forward the scrubbed copy with its exact length.
  return {
    ok: true,
    override: {
      body: singleChunkBody(form.body),
      headers: headersWithContentLength(request.headers, form.body.byteLength),
    },
  };
}

async function inspectSlackFormToken(request: http.IncomingMessage): Promise<SlackFormInspection> {
  if ((request.method ?? "").toUpperCase() !== "POST") return { kind: "none" };
  if (!isUrlEncodedForm(request.headers["content-type"])) return { kind: "none" };
  const declaredLength = Number(headerValue(request.headers["content-length"]));
  if (Number.isFinite(declaredLength) && declaredLength > SLACK_FORM_TOKEN_MAX_BYTES) {
    return { kind: "invalid", reason: "oversized" };
  }
  let raw: Buffer;
  try {
    raw = await readBoundedRequestBody(request, SLACK_FORM_TOKEN_MAX_BYTES);
  } catch {
    return { kind: "invalid", reason: "oversized" };
  }
  const params = new URLSearchParams(raw.toString("utf8"));
  const tokens = params.getAll("token").filter((token) => token.length > 0);
  if (tokens.length > 1) return { kind: "invalid", reason: "duplicate" };
  params.delete("token");
  const token = tokens[0];
  const body = Buffer.from(params.toString(), "utf8");
  return token === undefined ? { kind: "body", body } : { kind: "body", body, token };
}

function isUrlEncodedForm(contentType: string | string[] | undefined): boolean {
  const value = headerValue(contentType);
  return value?.split(";", 1)[0]?.trim().toLowerCase() === URLENCODED_FORM_CONTENT_TYPE;
}

/** Reads at most `maxBytes` and fails closed when the peer lies about or omits the length. */
async function readBoundedRequestBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error("The bounded request body exceeds its limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function singleChunkBody(buffer: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
}

function headersWithContentLength(headers: http.IncomingHttpHeaders, length: number): http.IncomingHttpHeaders {
  return { ...headers, "content-length": String(length) };
}

function extractProviderHandle(provider: RuntimeProxyProvider, authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const schemes = provider === "github" ? ["Basic ", "token ", "bearer "] : ["Bearer ", "bearer "];
  for (const scheme of schemes) {
    if (authorization.startsWith(scheme)) return decodeHandleValue(scheme, authorization.slice(scheme.length));
  }
  return undefined;
}

function decodeHandleValue(scheme: string, value: string): string | undefined {
  if (scheme !== "Basic ") return value.trim() || undefined;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator < 0 ? undefined : decoded.slice(separator + 1) || undefined;
}

function forwardedRequestHeaders(
  provider: RuntimeProxyProvider,
  headers: http.IncomingHttpHeaders,
  originHost: string,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!REQUEST_HEADER_ALLOWLIST.has(name) || value === undefined) continue;
    filtered[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // The adapter sets the reserved origin; a caller-supplied value is never honored. Only the
  // GitHub adapter consumes it (git vs REST/GraphQL); IM origins stay provider-fixed.
  if (provider === "github") filtered[RUNTIME_PROVIDER_ORIGIN_HEADER] = originHost;
  return filtered;
}

function filteredResponseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) continue;
    filtered[name] = value;
  }
  return filtered;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function replyText(response: http.ServerResponse, status: number, body: string): void {
  if (!response.headersSent) response.writeHead(status, { "content-type": "text/plain" });
  response.end(`${body}\n`);
}

async function listenLoopback(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new RuntimeProxyLoopbackError("listen_failed", "The loopback adapter has no bound address");
  }
  return address.port;
}
