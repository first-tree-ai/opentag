import WebSocket, { type ClientOptions, type RawData } from "ws";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import {
  PROVIDER_PROXY_MAX_STREAM_OPENS_PER_CONNECTION,
  RUNTIME_PROXY_DATA_BINARY_FRAME_MAX_BYTES,
  RUNTIME_PROXY_DATA_CHUNK_BYTES,
  RUNTIME_PROXY_DATA_HEADER_MAX_BYTES,
  RUNTIME_PROXY_DATA_INITIAL_CREDIT_BYTES,
  RUNTIME_PROXY_DATA_MAX_STREAMS,
  type RuntimeProviderProxyServerFrame,
  RuntimeProxyDataReadyFrameSchema,
  RuntimeProxyDataServerFrameSchema,
  type RuntimeProxyProvider,
  runtimeProxyErrorReason,
} from "./runtime-credential-frames.js";

export type RuntimeProxyDataErrorCode =
  | "aborted"
  | "auth_failed"
  | "connection_lost"
  | "connection_closed"
  | "open_timeout"
  | "protocol_error"
  | "queue_full"
  | "stream_error"
  | "too_many_streams";

/** Controlled data-channel failure. `code` identifies the local cause; upstream codes stay in `message`. */
export class RuntimeProxyDataError extends Error {
  constructor(
    readonly code: RuntimeProxyDataErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeProxyDataError";
  }
}

export interface RuntimeProxyOpenStreamRequest {
  readonly bindingId: string;
  readonly body?: AsyncIterable<Uint8Array>;
  readonly capability: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly path: string;
  readonly provider: RuntimeProxyProvider;
  readonly signal?: AbortSignal;
}

export interface RuntimeProxyStreamResponse {
  readonly body: AsyncIterable<Uint8Array>;
  /** Cancel the stream locally and send a `cancel` control frame; safe after end/settle. */
  readonly cancel?: (code?: string) => void;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

export interface RuntimeProxyDataConnectionOptions {
  /** Expected execution binding; a `ready` frame for any other execution fails the handshake. */
  readonly executionId: string;
  readonly handshakeTimeoutMs?: number;
  readonly logger?: Pick<ClientLogger, "debug" | "warn">;
  readonly maxQueuedOpens?: number;
  readonly maxStreams?: number;
  readonly openTimeoutMs?: number;
  readonly ticket: string;
  /** Full WebSocket URL including the fixed path. Must not carry a query string. */
  readonly url: string;
  readonly webSocketFactory?: (url: string, options: ClientOptions) => WebSocket;
}

interface Tombstone {
  inboundGranted: number;
  inboundReceived: number;
  responded: boolean;
  terminal: boolean;
  sendCreditAvailable: number;
}

interface QueuedOpen {
  readonly reject: (error: Error) => void;
  readonly request: RuntimeProxyOpenStreamRequest;
  readonly resolve: (response: RuntimeProxyStreamResponse) => void;
}

interface CreditGate {
  available: number;
  waiters: Array<() => void>;
}

class ProxyStream {
  inboundGranted = 0;
  inboundReceived = 0;
  requestEnded = false;
  responded = false;
  responseEnded = false;
  settled = false;
  readonly sendCredit: CreditGate = { available: RUNTIME_PROXY_DATA_INITIAL_CREDIT_BYTES, waiters: [] };
  inbound!: StreamChunkQueue;
  resolveOpen?: (response: RuntimeProxyStreamResponse) => void;
  rejectOpen?: (error: Error) => void;
  openTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly streamId: number) {}
}

/**
 * Pull-based handoff between the socket reader and the response consumer. Credit is
 * granted only when a chunk is handed to the consumer, so a slow consumer applies
 * backpressure to the Server within the fixed initial window.
 */
class StreamChunkQueue implements AsyncIterable<Uint8Array> {
  #chunks: Uint8Array[] = [];
  #error?: Error;
  #finished = false;
  #waiter?: { reject(error: Error): void; resolve(value: IteratorResult<Uint8Array>): void };

  constructor(
    private readonly onConsume: (bytes: number) => void,
    private readonly onCancel?: () => void,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.#finished) return;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      this.onConsume(chunk.byteLength);
      waiter.resolve({ done: false, value: chunk });
      return;
    }
    this.#chunks.push(chunk);
  }

  end(): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#error = error;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter.reject(error);
    }
    this.#chunks = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const queue = this;
    return {
      next(): Promise<IteratorResult<Uint8Array>> {
        const chunk = queue.#chunks.shift();
        if (chunk !== undefined) {
          queue.onConsume(chunk.byteLength);
          return Promise.resolve({ done: false, value: chunk });
        }
        if (queue.#error) return Promise.reject(queue.#error);
        if (queue.#finished) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          queue.#waiter = { resolve, reject };
        });
      },
      return(): Promise<IteratorResult<Uint8Array>> {
        // Consumer stopped early: tell the Server to abort the upstream request.
        queue.onCancel?.();
        queue.end();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

/**
 * Production client for the fixed binary streaming data protocol: one authenticated
 * WSS per execution, first frame `{type:"auth",ticket}`, JSON header frames bounded at
 * 16 KiB, binary frames `4-byte BE streamId || chunk` with chunks ≤ 64 KiB, 1 MiB
 * initial per-direction credit, at most 8 concurrent streams with a bounded open
 * queue, half-close via `end`, and `cancel`/`error`/connection loss rejecting every
 * pending promise. Writes are never replayed.
 */
export class RuntimeProxyDataConnection {
  readonly #logger: Pick<ClientLogger, "debug" | "warn">;
  readonly #maxQueuedOpens: number;
  readonly #maxStreams: number;
  readonly #tombstoneLimit: number;
  /** Bounded tombstones for genuinely locally-cancelled streams only. */
  readonly #tombstones = new Map<number, Tombstone>();
  readonly #openTimeoutMs: number;
  readonly #openQueue: QueuedOpen[] = [];
  readonly #socket: WebSocket;
  readonly #streams = new Map<number, ProxyStream>();
  #closePromise: Promise<void>;
  #closed = false;
  #closeSocket!: () => void;
  #nextStreamId = 1;

  private constructor(socket: WebSocket, options: RuntimeProxyDataConnectionOptions) {
    this.#socket = socket;
    this.#logger = options.logger ?? createLogger("runtime-proxy-data");
    this.#maxQueuedOpens = options.maxQueuedOpens ?? 64;
    this.#maxStreams = options.maxStreams ?? RUNTIME_PROXY_DATA_MAX_STREAMS;
    this.#tombstoneLimit = PROVIDER_PROXY_MAX_STREAM_OPENS_PER_CONNECTION;
    this.#openTimeoutMs = options.openTimeoutMs ?? 30_000;
    this.#closePromise = new Promise((resolve) => {
      this.#closeSocket = resolve;
    });
    socket.on("message", (data: RawData, isBinary: boolean) => this.#handleMessage(data, isBinary));
    socket.on("close", () => this.#failAll(new RuntimeProxyDataError("connection_lost", "The data connection closed")));
    socket.on("error", (error: Error) => {
      this.#logger.debug(
        { code: "data_socket_error", error: runtimeProxyErrorReason(error) },
        "Data connection socket error",
      );
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get activeStreamCount(): number {
    return this.#streams.size;
  }

  /** Resolves once the connection is fully closed (by either side or a protocol violation). */
  settled(): Promise<void> {
    return this.#closePromise;
  }

  /** Establish the connection and complete the ticket auth handshake. */
  static async connect(options: RuntimeProxyDataConnectionOptions): Promise<RuntimeProxyDataConnection> {
    if (options.url.includes("?") || options.url.includes("#")) {
      throw new RuntimeProxyDataError("protocol_error", "The data endpoint URL must not carry query parameters");
    }
    const socket = (options.webSocketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions)))(
      options.url,
      { maxPayload: RUNTIME_PROXY_DATA_BINARY_FRAME_MAX_BYTES, perMessageDeflate: false },
    );
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
    return new Promise<RuntimeProxyDataConnection>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new RuntimeProxyDataError("auth_failed", "The data connection auth handshake timed out"));
      }, handshakeTimeoutMs);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners("message");
        socket.removeAllListeners("open");
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
      };
      const fail = (error: RuntimeProxyDataError, closeCode?: number, reason?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (closeCode !== undefined && socket.readyState === WebSocket.OPEN) socket.close(closeCode, reason);
        else socket.terminate();
        reject(error);
      };
      socket.on("open", () => {
        // The ticket is the first frame and never travels in the URL or a header.
        socket.send(JSON.stringify({ type: "auth", ticket: options.ticket }));
      });
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (settled) return;
        if (isBinary) {
          fail(
            new RuntimeProxyDataError("protocol_error", "The data connection sent binary before ready"),
            1008,
            "binary_before_ready",
          );
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(rawDataToBuffer(data).toString("utf8"));
        } catch {
          fail(
            new RuntimeProxyDataError("protocol_error", "The data connection sent an invalid auth reply"),
            1008,
            "invalid_frame",
          );
          return;
        }
        const ready = RuntimeProxyDataReadyFrameSchema.safeParse(frame);
        if (!ready.success || ready.data.executionId !== options.executionId) {
          fail(
            new RuntimeProxyDataError("auth_failed", "The data connection rejected the ticket"),
            1008,
            "auth_rejected",
          );
          return;
        }
        settled = true;
        cleanup();
        resolve(new RuntimeProxyDataConnection(socket, options));
      });
      socket.on("error", () => {
        fail(new RuntimeProxyDataError("connection_lost", "The data connection failed during the handshake"));
      });
      socket.on("close", () => {
        fail(new RuntimeProxyDataError("auth_failed", "The data connection closed before ready"));
      });
    });
  }

  /**
   * Open one request/response stream. The response resolves with the status and
   * headers; its body is an async iterable that applies credit backpressure. Request
   * bodies stream concurrently with the response within the credit window.
   */
  openStream(request: RuntimeProxyOpenStreamRequest): Promise<RuntimeProxyStreamResponse> {
    if (this.#closed) {
      return Promise.reject(new RuntimeProxyDataError("connection_closed", "The data connection is closed"));
    }
    if (request.signal?.aborted) {
      return Promise.reject(new RuntimeProxyDataError("aborted", "The stream was aborted before it opened"));
    }
    if (this.#streams.size >= this.#maxStreams) {
      if (this.#openQueue.length >= this.#maxQueuedOpens) {
        return Promise.reject(new RuntimeProxyDataError("queue_full", "The data connection stream queue is full"));
      }
      return new Promise<RuntimeProxyStreamResponse>((resolve, reject) => {
        const queued: QueuedOpen = { reject, request, resolve };
        request.signal?.addEventListener(
          "abort",
          () => {
            const index = this.#openQueue.indexOf(queued);
            if (index >= 0) {
              this.#openQueue.splice(index, 1);
              reject(new RuntimeProxyDataError("aborted", "The queued stream was aborted"));
            }
          },
          { once: true },
        );
        this.#openQueue.push(queued);
      });
    }
    return this.#startStream(request);
  }

  /** Cancel every stream and close the socket. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const error = new RuntimeProxyDataError("connection_closed", "The data connection is closed");
    this.#failQueued(error);
    for (const stream of this.#streams.values()) {
      this.#sendControl({ type: "cancel", streamId: stream.streamId });
      this.#failStream(stream, error);
    }
    const socket = this.#socket;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "execution_closed");
    } else {
      this.#closeSocket();
    }
    await this.#closePromise;
  }

  #startStream(request: RuntimeProxyOpenStreamRequest): Promise<RuntimeProxyStreamResponse> {
    const streamId = this.#allocateStreamId();
    const stream = new ProxyStream(streamId);
    stream.inbound = new StreamChunkQueue(
      (bytes) => this.#grantInboundCredit(stream, bytes),
      () => this.#cancelStream(stream, "consumer_closed"),
    );
    this.#streams.set(streamId, stream);
    const openPromise = new Promise<RuntimeProxyStreamResponse>((resolve, reject) => {
      stream.resolveOpen = (response) => {
        stream.resolveOpen = undefined;
        stream.rejectOpen = undefined;
        if (stream.openTimer) clearTimeout(stream.openTimer);
        stream.openTimer = undefined;
        resolve(response);
      };
      stream.rejectOpen = (error) => {
        stream.resolveOpen = undefined;
        stream.rejectOpen = undefined;
        if (stream.openTimer) clearTimeout(stream.openTimer);
        stream.openTimer = undefined;
        reject(error);
      };
    });
    stream.openTimer = setTimeout(() => {
      stream.openTimer = undefined;
      this.#cancelStream(stream, "open_timeout");
      stream.rejectOpen?.(
        new RuntimeProxyDataError("open_timeout", "The data stream did not produce a response in time"),
      );
    }, this.#openTimeoutMs);
    stream.openTimer.unref();
    const onAbort = () => {
      this.#cancelStream(stream, "aborted");
      stream.rejectOpen?.(new RuntimeProxyDataError("aborted", "The stream was aborted"));
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    void openPromise.then(
      () => request.signal?.removeEventListener("abort", onAbort),
      () => request.signal?.removeEventListener("abort", onAbort),
    );

    const sent = this.#sendControl({
      type: "open",
      streamId,
      capability: request.capability,
      provider: request.provider,
      bindingId: request.bindingId,
      method: request.method,
      path: request.path,
      headers: { ...request.headers },
    });
    if (!sent) {
      this.#failStream(stream, new RuntimeProxyDataError("connection_closed", "The data connection is closed"));
      return openPromise;
    }
    void this.#pumpRequestBody(stream, request.body);
    return openPromise;
  }

  #allocateStreamId(): number {
    for (let attempts = 0; attempts < 0xffffffff; attempts += 1) {
      const candidate = this.#nextStreamId;
      this.#nextStreamId = this.#nextStreamId >= 0xffffffff ? 1 : this.#nextStreamId + 1;
      if (!this.#streams.has(candidate) && !this.#tombstones.has(candidate)) return candidate;
    }
    throw new RuntimeProxyDataError("too_many_streams", "The data connection exhausted stream identifiers");
  }

  async #pumpRequestBody(stream: ProxyStream, body: AsyncIterable<Uint8Array> | undefined): Promise<void> {
    if (!body) {
      this.#finishRequestSide(stream);
      return;
    }
    try {
      for await (const chunk of body) {
        const buffer = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (!(await this.#pumpChunk(stream, buffer))) return;
      }
      this.#finishRequestSide(stream);
    } catch (error) {
      if (error instanceof RuntimeProxyDataError && error.code === "connection_closed") return;
      this.#logger.debug(
        { code: "request_body_pump_failed", error: runtimeProxyErrorReason(error) },
        "Request body pump failed",
      );
      this.#cancelStream(stream, "request_body_failed");
    }
  }

  /** Sends one body chunk within the credit window; `false` when the stream/connection ended. */
  async #pumpChunk(stream: ProxyStream, chunk: Uint8Array): Promise<boolean> {
    let buffer = chunk;
    while (buffer.byteLength > 0) {
      if (stream.settled || this.#closed) return false;
      const slice = buffer.subarray(0, RUNTIME_PROXY_DATA_CHUNK_BYTES);
      buffer = buffer.subarray(slice.byteLength);
      await this.#waitSendCredit(stream, slice.byteLength);
      if (stream.settled || this.#closed) return false;
      stream.sendCredit.available -= slice.byteLength;
      const frame = new Uint8Array(4 + slice.byteLength);
      new DataView(frame.buffer).setUint32(0, stream.streamId, false);
      frame.set(slice, 4);
      if (!(await this.#sendBinary(frame))) return false;
    }
    return true;
  }

  #finishRequestSide(stream: ProxyStream): void {
    if (stream.requestEnded || stream.settled) return;
    stream.requestEnded = true;
    this.#sendControl({ type: "end", streamId: stream.streamId });
    this.#completeIfDone(stream);
  }

  async #waitSendCredit(stream: ProxyStream, bytes: number): Promise<void> {
    while (!stream.settled && !this.#closed && stream.sendCredit.available < bytes) {
      await new Promise<void>((resolve) => {
        stream.sendCredit.waiters.push(resolve);
      });
    }
    if (stream.settled || this.#closed) {
      throw new RuntimeProxyDataError("connection_closed", "The data stream closed while waiting for credit");
    }
  }

  #grantInboundCredit(stream: ProxyStream, bytes: number): void {
    if (stream.settled || this.#closed) return;
    stream.inboundGranted += bytes;
    this.#sendControl({ type: "credit", streamId: stream.streamId, bytes });
  }

  #sendBinary(frame: Uint8Array): Promise<boolean> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.#socket.send(frame, (error?: Error) => {
        resolve(!error);
      });
    });
  }

  #sendControl(frame: Record<string, unknown>): boolean {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return false;
    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized, "utf8") > RUNTIME_PROXY_DATA_HEADER_MAX_BYTES) return false;
    this.#socket.send(serialized);
    return true;
  }

  #handleMessage(data: RawData, isBinary: boolean): void {
    if (this.#closed) return;
    if (isBinary) {
      this.#handleBinaryFrame(rawDataToBuffer(data));
      return;
    }
    const frame = this.#decodeHeaderFrame(rawDataToBuffer(data));
    if (!frame) return;
    const stream = this.#streams.get(frame.streamId);
    if (!stream) {
      const tombstone = this.#tombstones.get(frame.streamId);
      if (!tombstone) {
        this.#protocolViolation("The data connection referenced an unknown stream");
        return;
      }
      this.#handleTombstonedFrame(tombstone, frame);
      return;
    }
    this.#handleStreamFrame(stream, frame);
  }

  /** Strictly decode one Server header frame; protocol violations close the connection. */
  #decodeHeaderFrame(buffer: Buffer): Exclude<RuntimeProviderProxyServerFrame, { type: "ready" }> | undefined {
    if (buffer.byteLength > RUNTIME_PROXY_DATA_HEADER_MAX_BYTES) {
      this.#protocolViolation("The data connection sent an oversized header frame");
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(buffer.toString("utf8"));
    } catch {
      this.#protocolViolation("The data connection sent an invalid header frame");
      return undefined;
    }
    const parsed = RuntimeProxyDataServerFrameSchema.safeParse(value);
    if (!parsed.success) {
      this.#protocolViolation("The data connection sent an unexpected frame");
      return undefined;
    }
    if (parsed.data.type === "ready") {
      this.#protocolViolation("The data connection sent an unexpected frame");
      return undefined;
    }
    return parsed.data;
  }

  /**
   * Genuinely locally-cancelled streams may still have in-flight upstream completion frames. They
   * are validated against the same size/credit bounds and exactly one terminal completion; any
   * frame after that, or for a normally completed stream, is a protocol violation.
   */
  #handleTombstonedFrame(
    tombstone: Tombstone,
    frame: Exclude<RuntimeProviderProxyServerFrame, { type: "ready" }>,
  ): void {
    if (tombstone.terminal) {
      this.#protocolViolation("The data connection sent a frame after the stream completed");
      return;
    }
    switch (frame.type) {
      case "response":
        if (tombstone.responded) {
          this.#protocolViolation("The data connection repeated a stream response");
          return;
        }
        tombstone.responded = true;
        return;
      case "credit":
        tombstone.sendCreditAvailable += frame.bytes;
        if (tombstone.sendCreditAvailable > RUNTIME_PROXY_DATA_INITIAL_CREDIT_BYTES) {
          this.#protocolViolation("The data connection exceeded the stream credit window");
          return;
        }
        return;
      case "end":
      case "cancel":
      case "error":
        tombstone.terminal = true;
        return;
    }
  }

  #handleStreamFrame(stream: ProxyStream, frame: Exclude<RuntimeProviderProxyServerFrame, { type: "ready" }>): void {
    switch (frame.type) {
      case "response":
        if (stream.resolveOpen === undefined) {
          this.#protocolViolation("The data connection repeated a stream response");
          return;
        }
        stream.responded = true;
        stream.resolveOpen({
          body: stream.inbound,
          cancel: (code) => this.#cancelStream(stream, code ?? "consumer_cancelled"),
          headers: frame.headers,
          status: frame.status,
        });
        break;
      case "credit":
        stream.sendCredit.available += frame.bytes;
        if (stream.sendCredit.available > RUNTIME_PROXY_DATA_INITIAL_CREDIT_BYTES) {
          this.#protocolViolation("The data connection exceeded the stream credit window");
          return;
        }
        for (const waiter of stream.sendCredit.waiters.splice(0)) waiter();
        break;
      case "end":
        if (stream.responseEnded) {
          this.#protocolViolation("The data connection repeated a stream end");
          return;
        }
        stream.responseEnded = true;
        stream.inbound.end();
        this.#completeIfDone(stream);
        break;
      case "cancel":
        this.#failStream(
          stream,
          new RuntimeProxyDataError("stream_error", `The data stream was cancelled: ${frame.code ?? "cancelled"}`),
        );
        break;
      case "error":
        this.#failStream(stream, new RuntimeProxyDataError("stream_error", `The data stream failed: ${frame.code}`));
        break;
    }
  }

  #handleBinaryFrame(buffer: Buffer): void {
    if (buffer.byteLength < 5 || buffer.byteLength > RUNTIME_PROXY_DATA_BINARY_FRAME_MAX_BYTES) {
      this.#protocolViolation("The data connection sent a malformed binary frame");
      return;
    }
    const streamId = buffer.readUInt32BE(0);
    const chunk = buffer.subarray(4);
    const stream = this.#streams.get(streamId);
    if (!stream) {
      const tombstone = this.#tombstones.get(streamId);
      if (!tombstone) {
        this.#protocolViolation("The data connection sent data for an unknown stream");
        return;
      }
      if (tombstone.terminal) {
        this.#protocolViolation("The data connection sent data after the stream completed");
        return;
      }
      tombstone.inboundReceived += chunk.byteLength;
      if (tombstone.inboundReceived > RUNTIME_PROXY_DATA_INITIAL_CREDIT_BYTES + tombstone.inboundGranted) {
        this.#protocolViolation("The data connection exceeded the inbound credit window");
        return;
      }
      return;
    }
    if (stream.responseEnded) {
      this.#protocolViolation("The data connection sent data for an unknown stream");
      return;
    }
    // The Server may only send within the initial window plus granted credit.
    stream.inboundReceived += chunk.byteLength;
    if (stream.inboundReceived > RUNTIME_PROXY_DATA_INITIAL_CREDIT_BYTES + stream.inboundGranted) {
      this.#protocolViolation("The data connection exceeded the inbound credit window");
      return;
    }
    stream.inbound.push(chunk);
  }

  #completeIfDone(stream: ProxyStream): void {
    if (stream.settled) return;
    if (!stream.requestEnded || !stream.responseEnded) return;
    stream.settled = true;
    if (stream.openTimer) {
      clearTimeout(stream.openTimer);
      stream.openTimer = undefined;
    }
    stream.inbound.end();
    this.#streams.delete(stream.streamId);
    this.#drainOpenQueue();
  }

  /**
   * Bounded tombstones so a genuinely locally-cancelled stream can absorb the upstream completion
   * frames already in flight without tearing down a healthy connection. Normally completed streams
   * get no tombstone: over ordered WebSocket delivery nothing may follow their `end`.
   */
  #rememberTombstone(stream: ProxyStream): void {
    this.#tombstones.set(stream.streamId, {
      inboundGranted: stream.inboundGranted,
      inboundReceived: stream.inboundReceived,
      responded: stream.responded,
      terminal: false,
      sendCreditAvailable: stream.sendCredit.available,
    });
    while (this.#tombstones.size > this.#tombstoneLimit) {
      const oldest = this.#tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest);
    }
  }

  #cancelStream(stream: ProxyStream, code: string): void {
    if (stream.settled) return;
    this.#sendControl({ type: "cancel", streamId: stream.streamId, code });
    this.#failStream(stream, new RuntimeProxyDataError("aborted", `The data stream was cancelled: ${code}`), true);
  }

  #failStream(stream: ProxyStream, error: Error, tombstone = false): void {
    if (stream.settled) return;
    stream.settled = true;
    if (stream.openTimer) {
      clearTimeout(stream.openTimer);
      stream.openTimer = undefined;
    }
    for (const waiter of stream.sendCredit.waiters.splice(0)) waiter();
    stream.inbound.fail(error);
    this.#streams.delete(stream.streamId);
    if (tombstone) this.#rememberTombstone(stream);
    stream.rejectOpen?.(error);
    this.#drainOpenQueue();
  }

  #drainOpenQueue(): void {
    while (!this.#closed && this.#openQueue.length > 0 && this.#streams.size < this.#maxStreams) {
      const queued = this.#openQueue.shift();
      if (!queued) return;
      if (queued.request.signal?.aborted) {
        queued.reject(new RuntimeProxyDataError("aborted", "The queued stream was aborted"));
        continue;
      }
      this.#startStream(queued.request).then(queued.resolve, queued.reject);
    }
  }

  #failQueued(error: Error): void {
    for (const queued of this.#openQueue.splice(0)) queued.reject(error);
  }

  #protocolViolation(message: string): void {
    this.#logger.debug({ code: "data_protocol_violation" }, message);
    this.#closed = true;
    const error = new RuntimeProxyDataError("protocol_error", message);
    this.#failQueued(error);
    for (const stream of [...this.#streams.values()]) this.#failStream(stream, error);
    this.#socket.close(1008, "protocol_violation");
    this.#closeSocket();
  }

  #failAll(error: Error): void {
    this.#closed = true;
    this.#failQueued(error);
    for (const stream of [...this.#streams.values()]) this.#failStream(stream, error);
    this.#closeSocket();
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
