import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { RuntimeBusinessFrame, RuntimeConnection } from "./runtime-connection.js";
import {
  MCP_GATEWAY_PATH,
  parseRuntimeCredentialServerFrame,
  RUNTIME_PROVIDER_PROXY_PATH,
  type RuntimeCredentialGrant,
  type RuntimeExecutionOpenResult,
  type RuntimeExecutionProvider,
  type RuntimeExecutionSandbox,
  type RuntimeExecutionService,
  type RuntimeExecutionServiceRequest,
  type RuntimeExecutionSource,
  type RuntimeMcpGatewayResult,
  type RuntimeProxyCliMetadata,
  type RuntimeProxyProvider,
  type RuntimeProxyTicketResult,
  runtimeProxyErrorReason,
} from "./runtime-credential-frames.js";
import {
  RuntimeProxyDataConnection,
  RuntimeProxyDataError,
  type RuntimeProxyStreamResponse,
} from "./runtime-proxy-data-client.js";

const DEFAULT_CONTROL_RESULT_TIMEOUT_MS = 10_000;
const DEFAULT_OPEN_BUDGET_MS = 15_000;
const DEFAULT_NOT_READY_RETRY_MS = 250;
const EXPIRY_MARGIN_MS = 250;
const RENEW_RETRY_MS = 5_000;
const RENEW_JITTER_MAX_MS = 2_000;
/** Renewal rejections that only mean the owner is momentarily unavailable. */
const RENEW_RETRYABLE_CODES = new Set(["owner_unavailable"]);

export type RuntimeCredentialRelayErrorCode =
  | "aborted"
  | "acquire_failed"
  | "capability_expired"
  | "data_connect_failed"
  | "execution_not_ready"
  | "execution_rejected"
  | "execution_timeout"
  | "provider_unavailable"
  | "relay_closed"
  | "ticket_failed"
  | "unsupported_negotiation";

/** Controlled trusted-Relay failure. Server rejection codes stay in `serverCode`. */
export class RuntimeCredentialRelayError extends Error {
  constructor(
    readonly code: RuntimeCredentialRelayErrorCode,
    message: string,
    readonly serverCode?: string,
  ) {
    super(message);
    this.name = "RuntimeCredentialRelayError";
  }
}

export interface RuntimeCredentialExecutionSubject {
  readonly agentId: string;
  readonly placementGeneration: number;
  readonly runId: string;
  readonly sandbox?: RuntimeExecutionSandbox;
  readonly sessionId: string;
  readonly source: RuntimeExecutionSource;
  /**
   * Platform services the Client opts into for this execution. Each is sent only when that
   * service's own capability was negotiated; the Server grants per its own policy.
   */
  readonly services?: readonly RuntimeExecutionServiceRequest[];
}

/** Structural data-connection surface so the parent harness can drive the real Relay. */
export interface RuntimeProxyDataConnectionLike {
  readonly closed: boolean;
  close(): Promise<void>;
  openStream(request: {
    readonly bindingId: string;
    readonly body?: AsyncIterable<Uint8Array>;
    readonly capability: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly method: string;
    readonly path: string;
    readonly provider: RuntimeProxyProvider;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeProxyStreamResponse>;
  settled(): Promise<void>;
}

export interface RuntimeProxyDataConnectInput {
  readonly executionId: string;
  readonly path: string;
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
  readonly ticket: string;
}

export type RuntimeProxyDataConnectionFactory = (
  input: RuntimeProxyDataConnectInput,
) => Promise<RuntimeProxyDataConnectionLike>;

export interface RuntimeRelayScheduleHandle {
  cancel(): void;
}

export interface RuntimeRelayScheduler {
  schedule(delayMs: number, callback: () => void): RuntimeRelayScheduleHandle;
}

export interface RuntimeCredentialRelayOptions {
  readonly connection: Pick<RuntimeConnection, "send" | "subscribeBusinessFrames" | "subscribeState">;
  readonly controlResultTimeoutMs?: number;
  readonly dataConnectionFactory?: RuntimeProxyDataConnectionFactory;
  readonly jitter?: () => number;
  readonly logger?: Pick<ClientLogger, "debug" | "warn">;
  readonly notReadyRetryMs?: number;
  readonly now?: () => number;
  readonly openBudgetMs?: number;
  readonly randomBytes?: (bytes: number) => Uint8Array;
  readonly scheduler?: RuntimeRelayScheduler;
  /** Base Server URL used to derive the data WSS endpoint from the ticket path. */
  readonly serverUrl: string;
}

interface ProviderGrantState {
  bindingId: string;
  capability: string;
  cli: RuntimeProxyCliMetadata;
  expiresAtMs: number;
  grantId: string;
  refreshAfterMs: number;
  renewTimer?: RuntimeRelayScheduleHandle;
  dead: boolean;
}

interface PendingControl {
  readonly reject: (error: Error) => void;
  readonly resolve: (frame: RuntimeBusinessFrame) => void;
  readonly timer: RuntimeRelayScheduleHandle;
}

const defaultScheduler: RuntimeRelayScheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export async function defaultRuntimeProxyDataConnectionFactory(
  input: RuntimeProxyDataConnectInput,
): Promise<RuntimeProxyDataConnectionLike> {
  const url = new URL(input.path, input.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return RuntimeProxyDataConnection.connect({
    executionId: input.executionId,
    ticket: input.ticket,
    url: url.toString(),
  });
}

/**
 * Trusted per-execution Relay. Holds short-lived capabilities in memory only, renews
 * them at `refreshAfter` while the Sandbox-facing local handle stays constant, and
 * injects the newest capability into every data-channel stream. A local handle is a
 * random 256-bit value stored hash-only and bound to its execution/provider; it is
 * never forwarded upstream. Connection replacement or Server revocation closes the
 * whole execution; nothing is replayed or resurrected.
 */
export class RuntimeCredentialRelay {
  readonly #abort = new AbortController();
  readonly #connection: RuntimeCredentialRelayOptions["connection"];
  readonly #controlResultTimeoutMs: number;
  readonly #dataFactory: RuntimeProxyDataConnectionFactory;
  readonly #jitter: () => number;
  readonly #logger: Pick<ClientLogger, "debug" | "warn">;
  readonly #notReadyRetryMs: number;
  readonly #now: () => number;
  readonly #openBudgetMs: number;
  readonly #pending = new Map<string, PendingControl>();
  readonly #providerHandles = new Map<RuntimeProxyProvider, { hash: string; value: string }>();
  readonly #grants = new Map<RuntimeProxyProvider, ProviderGrantState>();
  readonly #randomBytes: (bytes: number) => Uint8Array;
  readonly #scheduler: RuntimeRelayScheduler;
  readonly #serverUrl: string;
  readonly #unsubscribeBusiness: () => void;
  readonly #unsubscribeState: () => void;
  #closed = false;
  #data?: RuntimeProxyDataConnectionLike;
  #executionId = "";
  #providers: readonly RuntimeExecutionProvider[] = [];
  #services: readonly RuntimeExecutionService[] = [];

  private constructor(options: RuntimeCredentialRelayOptions) {
    this.#connection = options.connection;
    this.#controlResultTimeoutMs = options.controlResultTimeoutMs ?? DEFAULT_CONTROL_RESULT_TIMEOUT_MS;
    this.#dataFactory = options.dataConnectionFactory ?? defaultRuntimeProxyDataConnectionFactory;
    this.#jitter = options.jitter ?? Math.random;
    this.#logger = options.logger ?? createLogger("runtime-credential-relay");
    this.#notReadyRetryMs = options.notReadyRetryMs ?? DEFAULT_NOT_READY_RETRY_MS;
    this.#now = options.now ?? Date.now;
    this.#openBudgetMs = options.openBudgetMs ?? DEFAULT_OPEN_BUDGET_MS;
    this.#randomBytes = options.randomBytes ?? ((bytes) => randomBytes(bytes));
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#serverUrl = options.serverUrl;
    this.#unsubscribeBusiness = this.#connection.subscribeBusinessFrames((frame) => this.#handleFrame(frame));
    this.#unsubscribeState = this.#connection.subscribeState((state) => {
      // Control connection replacement closes this execution; no cross-connection revival.
      if (state !== "registered") {
        void this.#closeInternal("control_connection_lost", false).catch(() => undefined);
      }
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get executionId(): string {
    return this.#executionId;
  }

  get providers(): readonly RuntimeExecutionProvider[] {
    return this.#providers;
  }

  /** Platform services the Server granted this execution (e.g. `web` with exact scopes). */
  get services(): readonly RuntimeExecutionService[] {
    return this.#services;
  }

  /** Fires when the execution is revoked, closed, or loses its control/data connection. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /**
   * Open a trusted execution: bounded `execution_not_ready` retry until Server custody
   * accepts, acquire every granted provider, then establish the data channel with a
   * single-use ticket. Any failure closes the partial execution before throwing.
   */
  static async open(
    options: RuntimeCredentialRelayOptions,
    subject: RuntimeCredentialExecutionSubject,
    signal?: AbortSignal,
  ): Promise<RuntimeCredentialRelay> {
    const relay = new RuntimeCredentialRelay(options);
    try {
      await relay.#openExecution(subject, signal);
      await relay.#acquireProviders(signal);
      await relay.#connectData(signal);
      return relay;
    } catch (error) {
      await relay.#closeInternal("open_failed", true).catch(() => undefined);
      throw error;
    }
  }

  /** Plaintext local handle for CLI material assembly. Never leaves the Runner boundary. */
  localHandleFor(provider: RuntimeProxyProvider): string {
    const handle = this.#providerHandles.get(provider);
    if (!handle) throw new RuntimeCredentialRelayError("provider_unavailable", `Provider is not open: ${provider}`);
    return handle.value;
  }

  /** Hash-verified handle check for the loopback entry; the entry itself binds the execution. */
  verifyLocalHandle(provider: RuntimeProxyProvider, candidate: string): boolean {
    const handle = this.#providerHandles.get(provider);
    if (!handle || this.#closed) return false;
    const candidateHash = createHash("sha256").update(candidate, "utf8").digest();
    const recorded = Buffer.from(handle.hash, "hex");
    return recorded.length === candidateHash.length && timingSafeEqual(recorded, candidateHash);
  }

  /** CLI metadata for the provider, when an open execution/grant described it. */
  cliMetadataFor(provider: RuntimeProxyProvider): RuntimeProxyCliMetadata | undefined {
    const grant = this.#grants.get(provider);
    if (grant) return grant.cli;
    const opened = this.#providers.find((candidate) => candidate.provider === provider);
    return opened?.cli;
  }

  /**
   * Open one data stream with the current capability for the provider. Expired or
   * missing capability fails the stream; the local handle is never attached.
   */
  openProviderStream(request: {
    readonly body?: AsyncIterable<Uint8Array>;
    readonly headers: Readonly<Record<string, string>>;
    readonly method: string;
    readonly path: string;
    readonly provider: RuntimeProxyProvider;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeProxyStreamResponse> {
    if (this.#closed) {
      return Promise.reject(new RuntimeCredentialRelayError("relay_closed", "The execution Relay is closed"));
    }
    const grant = this.#grants.get(request.provider);
    const data = this.#data;
    if (!grant || !data || grant.dead) {
      return Promise.reject(
        new RuntimeCredentialRelayError("provider_unavailable", `Provider is not open: ${request.provider}`),
      );
    }
    if (grant.expiresAtMs - EXPIRY_MARGIN_MS <= this.#now()) {
      return Promise.reject(
        new RuntimeCredentialRelayError(
          "capability_expired",
          `Provider capability expired and has not renewed: ${request.provider}`,
        ),
      );
    }
    return data.openStream({
      bindingId: grant.bindingId,
      capability: grant.capability,
      provider: request.provider,
      method: request.method,
      path: request.path,
      headers: request.headers,
      ...(request.body ? { body: request.body } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  /** Close/release the execution: cancel renewals, close the data channel, then release. */
  async close(reason: string): Promise<void> {
    await this.#closeInternal(reason, true);
  }

  async #openExecution(subject: RuntimeCredentialExecutionSubject, signal?: AbortSignal): Promise<void> {
    const deadline = this.#now() + this.#openBudgetMs;
    for (;;) {
      signal?.throwIfAborted();
      const result = (await this.#controlRequest(
        {
          type: "runtime:execution:open",
          sessionId: subject.sessionId,
          agentId: subject.agentId,
          placementGeneration: subject.placementGeneration,
          runId: subject.runId,
          source: subject.source,
          ...(subject.sandbox ? { sandbox: subject.sandbox } : {}),
          ...(subject.services && subject.services.length > 0 ? { services: [...subject.services] } : {}),
        },
        "runtime:execution:result",
        signal,
      )) as Extract<RuntimeExecutionOpenResult, { requestId: string }>;
      if (result.status === "succeeded") {
        this.#executionId = result.executionId;
        this.#providers = result.providers;
        this.#services = result.services ?? [];
        return;
      }
      // Only `execution_not_ready` is retryable: Server custody has not accepted yet.
      if (result.code !== "execution_not_ready") {
        throw new RuntimeCredentialRelayError(
          "execution_rejected",
          `The Server rejected the execution open: ${result.code}`,
          result.code,
        );
      }
      if (this.#now() + this.#notReadyRetryMs > deadline) {
        throw new RuntimeCredentialRelayError(
          "execution_not_ready",
          "The Server did not accept execution custody within the bounded open budget",
          result.code,
        );
      }
      await this.#wait(this.#notReadyRetryMs, signal);
    }
  }

  async #acquireProviders(signal?: AbortSignal): Promise<void> {
    for (const provider of this.#providers) {
      signal?.throwIfAborted();
      const grant = await this.#acquireProvider(provider, signal);
      this.#grants.set(provider.provider, grant);
      this.#providerHandles.set(provider.provider, this.#newLocalHandle());
      this.#scheduleRenewal(provider.provider);
    }
  }

  async #acquireProvider(provider: RuntimeExecutionProvider, signal?: AbortSignal): Promise<ProviderGrantState> {
    const result = (await this.#controlRequest(
      {
        type: "runtime:credential:acquire",
        executionId: this.#executionId,
        provider: provider.provider,
        bindingId: provider.bindingId,
      },
      "runtime:credential:result",
      signal,
    )) as RuntimeCredentialGrant | { status: "rejected"; code: string };
    if (result.status === "rejected") {
      throw new RuntimeCredentialRelayError(
        "acquire_failed",
        `The Server rejected the credential acquire for ${provider.provider}: ${result.code}`,
        result.code,
      );
    }
    return this.#grantState(provider.provider, provider.bindingId, result);
  }

  #grantState(provider: RuntimeProxyProvider, bindingId: string, result: RuntimeCredentialGrant): ProviderGrantState {
    if (result.executionId !== this.#executionId || result.provider !== provider) {
      throw new RuntimeCredentialRelayError(
        "acquire_failed",
        "The credential result fence does not match the execution",
      );
    }
    return {
      bindingId: result.bindingId || bindingId,
      capability: result.opaqueToken,
      cli: result.cli,
      expiresAtMs: Date.parse(result.expiresAt),
      grantId: result.grantId,
      refreshAfterMs: Date.parse(result.refreshAfter),
      dead: false,
    };
  }

  #scheduleRenewal(provider: RuntimeProxyProvider): void {
    const grant = this.#grants.get(provider);
    if (!grant || this.#closed) return;
    grant.renewTimer?.cancel();
    const jitterMs = Math.floor(this.#jitter() * RENEW_JITTER_MAX_MS);
    const delay = Math.max(0, grant.refreshAfterMs - this.#now()) + jitterMs;
    grant.renewTimer = this.#scheduler.schedule(delay, () => {
      void this.#renewProvider(provider).catch((error: unknown) => {
        this.#logger.debug(
          { code: "credential_renew_failed", error: runtimeProxyErrorReason(error), provider },
          "Credential renewal failed",
        );
      });
    });
  }

  async #renewProvider(provider: RuntimeProxyProvider): Promise<void> {
    const grant = this.#grants.get(provider);
    if (!grant || grant.dead || this.#closed) return;
    try {
      const result = (await this.#controlRequest(
        { type: "runtime:credential:renew", executionId: this.#executionId, grantId: grant.grantId },
        "runtime:credential:result",
      )) as RuntimeCredentialGrant | { status: "rejected"; code: string };
      if (result.status === "rejected") {
        this.#renewRejected(provider, grant, result.code);
        return;
      }
      const next = this.#grantState(provider, grant.bindingId, result);
      this.#grants.set(provider, next);
      // The local handle stays constant; only the in-memory capability rotates.
      this.#scheduleRenewal(provider);
    } catch (error) {
      if (this.#closed || grant.dead) return;
      // Transient renewal failure: the old capability stays usable until its expiry.
      if (grant.expiresAtMs - EXPIRY_MARGIN_MS > this.#now() + RENEW_RETRY_MS) {
        grant.renewTimer?.cancel();
        grant.renewTimer = this.#scheduler.schedule(RENEW_RETRY_MS, () => {
          void this.#renewProvider(provider).catch(() => undefined);
        });
        return;
      }
      this.#logger.debug(
        { code: "credential_renew_expired", error: runtimeProxyErrorReason(error), provider },
        "Credential renewal could not complete before expiry",
      );
    }
  }

  #renewRejected(provider: RuntimeProxyProvider, grant: ProviderGrantState, code: string): void {
    // Only a temporary owner outage may retry; every other rejection is terminal for this grant.
    // The capability still fences until expiry; the local handle is never resurrected afterwards.
    if (RENEW_RETRYABLE_CODES.has(code) && grant.expiresAtMs - EXPIRY_MARGIN_MS > this.#now() + RENEW_RETRY_MS) {
      grant.renewTimer?.cancel();
      grant.renewTimer = this.#scheduler.schedule(RENEW_RETRY_MS, () => {
        void this.#renewProvider(provider).catch(() => undefined);
      });
      return;
    }
    grant.dead = true;
  }

  /**
   * Fetch this execution's MCP gateway bearer.
   *
   * Its own request rather than a field on the open result, matching the proxy ticket: the open
   * result carries authorization statements, and every secret in this protocol is fetched. The URL
   * is never taken from the Server — only the fixed path is checked against the constant, and the
   * caller composes it against the origin it already pinned.
   *
   * Returns `undefined` rather than throwing when the Server refuses. A missing gateway costs the
   * Agent its MCP tools; it must not cost it the turn.
   */
  async acquireMcpGatewayToken(signal?: AbortSignal): Promise<{ token: string; expiresAt: string } | undefined> {
    const granted = this.#services.some((service) => service.service === "mcp" && service.scopes.includes("mcp:tools"));
    if (!granted) return undefined;
    let result: RuntimeMcpGatewayResult;
    try {
      result = (await this.#controlRequest(
        { type: "runtime:mcp:gateway", executionId: this.#executionId },
        "runtime:mcp:gateway:result",
        signal,
      )) as RuntimeMcpGatewayResult;
    } catch (error) {
      this.#logger.warn(
        { code: "mcp_gateway_token_failed", reason: runtimeProxyErrorReason(error) },
        "The MCP gateway token request failed",
      );
      return undefined;
    }
    if (result.status === "rejected") {
      this.#logger.warn(
        { code: "mcp_gateway_token_rejected", reason: result.code },
        "The Server refused an MCP gateway token",
      );
      return undefined;
    }
    if (result.executionId !== this.#executionId || result.path !== MCP_GATEWAY_PATH) {
      this.#logger.warn({ code: "mcp_gateway_token_fence_mismatch" }, "The MCP gateway token fence does not match");
      return undefined;
    }
    return { token: result.token, expiresAt: result.expiresAt };
  }

  async #connectData(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const result = (await this.#controlRequest(
      { type: "runtime:proxy:ticket", executionId: this.#executionId },
      "runtime:proxy:ticket:result",
      signal,
    )) as RuntimeProxyTicketResult;
    if (result.status === "rejected") {
      throw new RuntimeCredentialRelayError(
        "ticket_failed",
        `The Server rejected the data ticket request: ${result.code}`,
        result.code,
      );
    }
    if (result.executionId !== this.#executionId || result.path !== RUNTIME_PROVIDER_PROXY_PATH) {
      throw new RuntimeCredentialRelayError(
        "ticket_failed",
        "The data ticket result fence does not match the execution",
      );
    }
    let data: RuntimeProxyDataConnectionLike;
    try {
      data = await this.#dataFactory({
        executionId: this.#executionId,
        path: result.path,
        serverUrl: this.#serverUrl,
        ticket: result.ticket,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new RuntimeCredentialRelayError(
        "data_connect_failed",
        `The data connection could not be established: ${runtimeProxyErrorReason(error)}`,
      );
    }
    this.#data = data;
    // Server owner loss closes the data channel; this execution never migrates.
    void data.settled().then(() => {
      if (!this.#closed) void this.#closeInternal("data_connection_lost", false).catch(() => undefined);
    });
  }

  #newLocalHandle(): { hash: string; value: string } {
    const value = `otrh_${Buffer.from(this.#randomBytes(32)).toString("base64url")}`;
    return { hash: createHash("sha256").update(value, "utf8").digest("hex"), value };
  }

  #controlRequest(
    frame: Readonly<Record<string, unknown>>,
    resultType: string,
    signal?: AbortSignal,
    options?: { readonly allowWhileClosed?: boolean },
  ): Promise<RuntimeBusinessFrame> {
    if (this.#closed && options?.allowWhileClosed !== true) {
      return Promise.reject(new RuntimeCredentialRelayError("relay_closed", "The execution Relay is closed"));
    }
    if (signal?.aborted) {
      return Promise.reject(new RuntimeCredentialRelayError("aborted", "The control request was aborted"));
    }
    const requestId = randomUUID();
    return new Promise<RuntimeBusinessFrame>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(requestId);
        timer.cancel();
      };
      const onAbort = () => {
        cleanup();
        reject(new RuntimeCredentialRelayError("aborted", "The control request was aborted"));
      };
      const timer = this.#scheduler.schedule(this.#controlResultTimeoutMs, () => {
        cleanup();
        reject(new RuntimeCredentialRelayError("execution_timeout", `The control result for ${resultType} timed out`));
      });
      this.#pending.set(requestId, {
        timer,
        reject: (error) => {
          cleanup();
          reject(error);
        },
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.#connection.send({ ...frame, requestId }, { priority: "result", signal }).catch((error: unknown) => {
        cleanup();
        reject(
          new RuntimeCredentialRelayError(
            "relay_closed",
            `The control request could not be sent: ${runtimeProxyErrorReason(error)}`,
          ),
        );
      });
    });
  }

  #handleFrame(frame: RuntimeBusinessFrame): void {
    const parsed = parseRuntimeCredentialServerFrame(frame);
    if (!parsed) return;
    if (parsed.type === "runtime:credential:revoked") {
      if (parsed.executionId === this.#executionId) {
        void this.#closeInternal(`revoked:${parsed.code}`, false).catch(() => undefined);
      }
      return;
    }
    const requestId = "requestId" in parsed && typeof parsed.requestId === "string" ? parsed.requestId : undefined;
    if (!requestId) return;
    this.#pending.get(requestId)?.resolve(parsed as unknown as RuntimeBusinessFrame);
  }

  #wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        timer.cancel();
        reject(new RuntimeCredentialRelayError("aborted", "The wait was aborted"));
      };
      const timer = this.#scheduler.schedule(milliseconds, () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async #closeInternal(reason: string, release: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const grant of this.#grants.values()) {
      grant.dead = true;
      grant.renewTimer?.cancel();
    }
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      pending.timer.cancel();
      pending.reject(new RuntimeCredentialRelayError("relay_closed", `The execution Relay is closing: ${reason}`));
    }
    this.#abort.abort(new RuntimeCredentialRelayError("relay_closed", `The execution Relay is closing: ${reason}`));
    const data = this.#data;
    this.#data = undefined;
    if (data) await data.close().catch(() => undefined);
    if (release && this.#executionId) {
      // Close/release runs before any later report; the result is acknowledged best-effort.
      // This is the one control request allowed after the Relay stops accepting new work.
      await this.#controlRequest(
        { type: "runtime:execution:close", executionId: this.#executionId },
        "runtime:execution:closed",
        undefined,
        { allowWhileClosed: true },
      ).catch((error: unknown) => {
        this.#logger.debug(
          { code: "execution_close_failed", error: runtimeProxyErrorReason(error) },
          "Execution close failed",
        );
      });
    }
    this.#unsubscribeBusiness();
    this.#unsubscribeState();
  }
}

export { RuntimeProxyDataError };
