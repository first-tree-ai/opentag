import {
  decodeProviderProxyDataFrame,
  encodeProviderProxyDataFrame,
  PROVIDER_PROXY_AUTH_TIMEOUT_MS,
  PROVIDER_PROXY_CHUNK_MAX_BYTES,
  PROVIDER_PROXY_HEADER_MAX_BYTES,
  PROVIDER_PROXY_INITIAL_CREDIT_BYTES,
  PROVIDER_PROXY_MAX_STREAM_OPENS_PER_CONNECTION,
  PROVIDER_PROXY_MAX_STREAMS_PER_EXECUTION,
  PROVIDER_PROXY_STREAM_REVALIDATE_INTERVAL_MS,
  RUNTIME_CREDENTIAL_CAPABILITY_TTL_MS,
  type RuntimeCredentialProvider,
  RuntimeProviderProxyAuthFrameSchema,
  RuntimeProviderProxyClientFrameSchema,
  type RuntimeProviderProxyServerFrame,
} from "@opentag/shared";
import type WebSocket from "ws";
import type { RawData } from "ws";
import {
  type RuntimeConnectionFence,
  type RuntimeCredentialBroker,
  RuntimeCredentialError,
} from "./credential-broker.js";
import { AsyncByteQueue, QUEUE_END } from "./data-transport-queue.js";
import type { RuntimeExecutionRegistry } from "./execution-registry.js";
import type { ProviderProxyAdapter, ProviderProxyRequest } from "./provider-proxy-adapter.js";
import type { RuntimeProxyTicketStore } from "./ticket-store.js";

interface ResolvedTransportLimits {
  authTimeoutMs: number;
  headerMaxBytes: number;
  chunkMaxBytes: number;
  initialCreditBytes: number;
  maxStreams: number;
  maxOpens: number;
  revalidateIntervalMs: number;
}

export interface RuntimeProviderProxyTransportOptions {
  broker: RuntimeCredentialBroker;
  adapters: ReadonlyMap<RuntimeCredentialProvider, ProviderProxyAdapter>;
  tickets: RuntimeProxyTicketStore;
  executions: RuntimeExecutionRegistry;
  /** Exact current control connection; a replaced connection invalidates tickets immediately. */
  connectionFence?: RuntimeConnectionFence;
  logger?: { warn(record: Record<string, unknown>, message: string): void };
  now?: () => number;
  authTimeoutMs?: number;
  headerMaxBytes?: number;
  chunkMaxBytes?: number;
  initialCreditBytes?: number;
  maxStreams?: number;
  maxOpens?: number;
  revalidateIntervalMs?: number;
}

interface ProxyStream {
  id: number;
  state: "opening" | "open" | "closed";
  abort: AbortController;
  authorization?: Awaited<ReturnType<RuntimeCredentialBroker["beginRequest"]>>;
  requestBody: AsyncByteQueue;
  uploadCredit: number;
  downloadCredit: number;
  /** Set once the client's request half-close (`end`) was accepted; later body bytes are invalid. */
  requestEnded: boolean;
  downloadNotify?: () => void;
  responseStarted: boolean;
}

/**
 * The binary WSS data plane. The first frame authenticates a single-use ticket (never a URL
 * query); streams then multiplex strict JSON control frames and 4-byte-framed binary chunks with
 * per-stream credit windows in both directions. Protocol violations close the whole connection;
 * connection loss, cancellation, execution close, or broker destruction aborts upstream work.
 */
export class RuntimeProviderProxyTransport {
  readonly #options: RuntimeProviderProxyTransportOptions;
  readonly #limits: ResolvedTransportLimits;

  constructor(options: RuntimeProviderProxyTransportOptions) {
    this.#options = options;
    this.#limits = {
      authTimeoutMs: options.authTimeoutMs ?? PROVIDER_PROXY_AUTH_TIMEOUT_MS,
      headerMaxBytes: options.headerMaxBytes ?? PROVIDER_PROXY_HEADER_MAX_BYTES,
      chunkMaxBytes: options.chunkMaxBytes ?? PROVIDER_PROXY_CHUNK_MAX_BYTES,
      initialCreditBytes: options.initialCreditBytes ?? PROVIDER_PROXY_INITIAL_CREDIT_BYTES,
      maxStreams: options.maxStreams ?? PROVIDER_PROXY_MAX_STREAMS_PER_EXECUTION,
      maxOpens: options.maxOpens ?? PROVIDER_PROXY_MAX_STREAM_OPENS_PER_CONNECTION,
      revalidateIntervalMs: options.revalidateIntervalMs ?? PROVIDER_PROXY_STREAM_REVALIDATE_INTERVAL_MS,
    };
  }

  attach(socket: WebSocket): void {
    new ProxyDataConnection(socket, this.#options, this.#limits).start();
  }
}

class ProxyDataConnection {
  readonly #socket: WebSocket;
  readonly #transport: RuntimeProviderProxyTransportOptions;
  readonly #limits: ResolvedTransportLimits;
  readonly #streams = new Map<number, ProxyStream>();
  readonly #usedStreamIds = new Set<number>();
  #state: "await-auth" | "ready" | "closed" = "await-auth";
  #executionId?: string;
  #opens = 0;
  #unsubscribeClose?: () => void;
  #revalidateTimer?: ReturnType<typeof setInterval>;
  #authTimer?: ReturnType<typeof setTimeout>;

  constructor(socket: WebSocket, options: RuntimeProviderProxyTransportOptions, limits: ResolvedTransportLimits) {
    this.#socket = socket;
    this.#transport = options;
    this.#limits = limits;
  }

  start(): void {
    this.#authTimer = setTimeout(() => this.#fail(4401, "proxy_auth_timeout"), this.#limits.authTimeoutMs);
    this.#authTimer.unref?.();
    this.#socket.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    this.#socket.on("close", () => this.#destroy());
    this.#socket.on("error", () => this.#destroy());
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    if (this.#state === "closed") return;
    if (isBinary) {
      this.#onBinary(rawBuffer(data));
      return;
    }
    const buffer = rawBuffer(data);
    if (buffer.byteLength > this.#limits.headerMaxBytes) {
      this.#fail(4400, "proxy_frame_too_large");
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(buffer.toString("utf8"));
    } catch {
      this.#fail(4400, "proxy_frame_invalid");
      return;
    }
    if (this.#state === "await-auth") {
      this.#onAuthFrame(decoded);
      return;
    }
    this.#onControlFrame(decoded);
  }

  #onAuthFrame(decoded: unknown): void {
    const parsed = RuntimeProviderProxyAuthFrameSchema.safeParse(decoded);
    if (!parsed.success) {
      this.#fail(4401, "proxy_auth_invalid");
      return;
    }
    const ticket = this.#transport.tickets?.consume(parsed.data.ticket);
    if (!ticket) {
      this.#fail(4401, "proxy_auth_invalid");
      return;
    }
    const execution = this.#transport.executions?.get(ticket.executionId);
    if (
      !execution ||
      execution.computerId !== ticket.computerId ||
      execution.instanceId !== ticket.instanceId ||
      execution.connectionId !== ticket.connectionId ||
      (this.#transport.connectionFence &&
        !this.#transport.connectionFence.isCurrent(ticket.computerId, ticket.instanceId, ticket.connectionId))
    ) {
      this.#fail(4401, "proxy_auth_invalid");
      return;
    }
    this.#executionId = execution.executionId;
    this.#state = "ready";
    if (this.#authTimer) clearTimeout(this.#authTimer);
    this.#unsubscribeClose = this.#transport.executions?.onClose((event) => {
      if (event.executionId === this.#executionId) this.#fail(4000, "proxy_execution_closed");
    });
    this.#revalidateTimer = setInterval(() => void this.#revalidateStreams(), this.#limits.revalidateIntervalMs);
    this.#revalidateTimer.unref?.();
    this.#sendJson({ type: "ready", executionId: execution.executionId });
  }

  #onControlFrame(decoded: unknown): void {
    const parsed = RuntimeProviderProxyClientFrameSchema.safeParse(decoded);
    if (!parsed.success) {
      this.#fail(4400, "proxy_frame_invalid");
      return;
    }
    const frame = parsed.data;
    if (frame.type === "open") {
      this.#onOpen(frame);
      return;
    }
    const stream = this.#streams.get(frame.streamId);
    if (!stream) {
      // Stream ids are bounded by the lifetime opens cap and can never be reused, so an unknown id
      // is always a violation; a known closed id is still validated below.
      this.#fail(4400, "proxy_stream_unknown");
      return;
    }
    if (frame.type === "end") {
      // The request half-close happens once. A second end — including on a completed stream — is
      // a protocol violation rather than a flood to absorb.
      if (stream.requestEnded) {
        this.#fail(4400, "proxy_duplicate_end");
        return;
      }
      stream.requestEnded = true;
      stream.requestBody.end();
      return;
    }
    if (frame.type === "cancel") {
      // Cancellation is idempotent and aborting an already-closed stream is a legitimate race.
      this.#abortStream(stream);
      return;
    }
    // Download credit is the remaining Server→client allowance. A correct client only returns
    // credit for bytes it consumed, so the window never exceeds the initial grant — for active and
    // closed streams alike. This is the real outstanding-credit bound.
    if (stream.downloadCredit + frame.bytes > this.#limits.initialCreditBytes) {
      this.#fail(4400, "proxy_credit_overflow");
      return;
    }
    stream.downloadCredit += frame.bytes;
    stream.downloadNotify?.();
  }

  #onOpen(frame: {
    streamId: number;
    capability: string;
    provider: RuntimeCredentialProvider;
    bindingId: string;
    method: string;
    path: string;
    headers: Record<string, string>;
  }): void {
    if (this.#usedStreamIds.has(frame.streamId)) {
      this.#fail(4400, "proxy_stream_reused");
      return;
    }
    if (this.#opens >= this.#limits.maxOpens || this.#activeStreamCount() >= this.#limits.maxStreams) {
      this.#fail(4400, "proxy_stream_limit");
      return;
    }
    this.#usedStreamIds.add(frame.streamId);
    this.#opens += 1;
    const stream: ProxyStream = {
      id: frame.streamId,
      state: "opening",
      abort: new AbortController(),
      requestBody: new AsyncByteQueue(),
      uploadCredit: this.#limits.initialCreditBytes,
      downloadCredit: this.#limits.initialCreditBytes,
      requestEnded: false,
      responseStarted: false,
    };
    this.#streams.set(stream.id, stream);
    void this.#runStream(stream, frame).catch(() => undefined);
  }

  async #runStream(
    stream: ProxyStream,
    frame: {
      capability: string;
      provider: RuntimeCredentialProvider;
      bindingId: string;
      method: string;
      path: string;
      headers: Record<string, string>;
    },
  ): Promise<void> {
    const broker = this.#transport.broker;
    const adapter = this.#transport.adapters?.get(frame.provider);
    try {
      if (!broker || !adapter) throw new RuntimeCredentialError("provider_mismatch");
      const authorization = await broker.beginRequest({
        capability: frame.capability,
        provider: frame.provider,
        bindingId: frame.bindingId,
        signal: stream.abort.signal,
      });
      stream.authorization = authorization;
      if (stream.state === "closed") return;
      stream.state = "open";
      const request: ProviderProxyRequest = {
        executionId: authorization.executionId,
        sessionId: authorization.sessionId,
        provider: frame.provider,
        bindingId: frame.bindingId,
        method: frame.method,
        path: frame.path,
        headers: frame.headers,
        body: this.#requestBodyIterable(stream),
        capability: frame.capability,
        capabilityTtlSeconds: Math.ceil(RUNTIME_CREDENTIAL_CAPABILITY_TTL_MS / 1_000),
        signal: stream.abort.signal,
      };
      const response = await adapter.handle(request, authorization);
      if (this.#streamClosed(stream)) return;
      stream.responseStarted = true;
      this.#sendJson({ type: "response", streamId: stream.id, status: response.status, headers: response.headers });
      await this.#pipeResponseBody(stream, response.body);
      if (!this.#streamClosed(stream)) {
        this.#sendJson({ type: "end", streamId: stream.id });
        this.#closeStream(stream);
      }
    } catch (error) {
      // A stream that already ended or was aborted locally must not emit a late terminal frame:
      // the client may have finished it already, and a stale cancel/error would be a violation.
      if (this.#streamClosed(stream)) return;
      const code = errorCodeOf(error);
      if (stream.responseStarted) {
        this.#sendJson({ type: "cancel", streamId: stream.id, code });
      } else {
        this.#sendJson({ type: "error", streamId: stream.id, code });
      }
      this.#closeStream(stream);
    }
  }

  #streamClosed(stream: ProxyStream): boolean {
    return stream.state === "closed";
  }

  async *#requestBodyIterable(stream: ProxyStream): AsyncIterable<Uint8Array> {
    for (;;) {
      if (stream.abort.signal.aborted) return;
      const chunk = await stream.requestBody.take();
      if (chunk === QUEUE_END) return;
      // The stream can close while take() was awaited (cancel/revalidation); never grant credit
      // or hand a chunk to a closed stream.
      if (stream.abort.signal.aborted || this.#streamClosed(stream)) return;
      // Replenish the Server's own window as the body is consumed: the client spends granted
      // credit, so uploads larger than the initial 1 MiB window must replenish this counter too.
      stream.uploadCredit += chunk.byteLength;
      this.#sendJson({ type: "credit", streamId: stream.id, bytes: chunk.byteLength });
      yield chunk;
    }
  }

  async #pipeResponseBody(stream: ProxyStream, body: AsyncIterable<Uint8Array>): Promise<void> {
    for await (const chunk of body) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (stream.abort.signal.aborted || this.#streamClosed(stream)) return;
        const size = Math.min(this.#limits.chunkMaxBytes, chunk.byteLength - offset);
        await this.#awaitDownloadCredit(stream, size);
        if (stream.abort.signal.aborted || this.#streamClosed(stream)) return;
        const piece = chunk.subarray(offset, offset + size);
        offset += size;
        stream.downloadCredit -= piece.byteLength;
        this.#socket.send(Buffer.from(encodeProviderProxyDataFrame(stream.id, piece)));
      }
    }
  }

  #awaitDownloadCredit(stream: ProxyStream, bytes: number): Promise<void> {
    if (stream.downloadCredit >= bytes) return Promise.resolve();
    return new Promise((resolve) => {
      const previous = stream.downloadNotify;
      stream.downloadNotify = () => {
        previous?.();
        if (stream.downloadCredit >= bytes || stream.state === "closed") {
          stream.downloadNotify = undefined;
          resolve();
        }
      };
      if (stream.state === "closed") resolve();
    });
  }

  #onBinary(frame: Uint8Array): void {
    if (this.#state !== "ready") {
      this.#fail(4400, "proxy_frame_invalid");
      return;
    }
    const decoded = decodeProviderProxyDataFrame(frame);
    if (!decoded) {
      this.#fail(4400, "proxy_frame_invalid");
      return;
    }
    const stream = this.#streams.get(decoded.streamId);
    if (!stream) {
      this.#fail(4400, "proxy_stream_unknown");
      return;
    }
    if (stream.requestEnded) {
      // Body bytes after the client's own half-close are invalid, whether the stream is open or
      // already completed.
      this.#fail(4400, "proxy_body_after_end");
      return;
    }
    if (decoded.payload.byteLength > this.#limits.chunkMaxBytes || decoded.payload.byteLength > stream.uploadCredit) {
      this.#fail(4400, "proxy_credit_violation");
      return;
    }
    stream.uploadCredit -= decoded.payload.byteLength;
    if (stream.state === "closed") {
      // In-flight bytes for a completed/aborted stream consume only the previously granted window
      // and are then discarded; they never extend it.
      return;
    }
    stream.requestBody.push(decoded.payload);
  }

  async #revalidateStreams(): Promise<void> {
    if (this.#state !== "ready") return;
    for (const stream of [...this.#streams.values()]) {
      if (stream.state === "closed" || !stream.authorization) continue;
      try {
        await this.#transport.broker?.revalidate(stream.authorization);
      } catch (error) {
        if (this.#streamClosed(stream)) continue;
        const code = errorCodeOf(error);
        if (stream.responseStarted) this.#sendJson({ type: "cancel", streamId: stream.id, code });
        else this.#sendJson({ type: "error", streamId: stream.id, code });
        this.#abortStream(stream);
      }
    }
  }

  #activeStreamCount(): number {
    let count = 0;
    for (const stream of this.#streams.values()) {
      if (stream.state !== "closed") count += 1;
    }
    return count;
  }

  #abortStream(stream: ProxyStream): void {
    if (stream.state === "closed") return;
    stream.abort.abort();
    stream.requestBody.end();
    this.#closeStream(stream);
  }

  #closeStream(stream: ProxyStream): void {
    if (stream.state === "closed") return;
    stream.state = "closed";
    stream.abort.abort();
    stream.requestBody.end();
    stream.downloadNotify?.();
  }

  #sendJson(frame: RuntimeProviderProxyServerFrame): void {
    if (this.#state === "closed" || this.#socket.readyState !== 1) return;
    const serialized = JSON.stringify(frame);
    if (new TextEncoder().encode(serialized).byteLength > this.#limits.headerMaxBytes) return;
    this.#socket.send(serialized);
  }

  #fail(code: number, reason: string): void {
    if (this.#state === "closed") return;
    try {
      this.#transport.logger?.warn(
        { code, reason, executionId: this.#executionId },
        "Provider proxy connection closed",
      );
    } catch {
      // Logging must never change connection teardown.
    }
    this.#destroy();
    this.#socket.close(code, reason.slice(0, 120));
  }

  #destroy(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    if (this.#authTimer) clearTimeout(this.#authTimer);
    if (this.#revalidateTimer) clearInterval(this.#revalidateTimer);
    this.#unsubscribeClose?.();
    for (const stream of this.#streams.values()) this.#abortStream(stream);
  }
}

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function errorCodeOf(error: unknown): string {
  if (error instanceof RuntimeCredentialError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "upstream_unavailable";
}
