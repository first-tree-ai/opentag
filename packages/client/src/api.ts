import {
  type AgentAdminConfig,
  AgentAdminConfigSchema,
  type AgentDetail,
  AgentDetailSchema,
  type AgentUsageDetail,
  AgentUsageDetailSchema,
  type AgentUsageWindowDays,
  accountComputerConnectCodePath,
  agentByIdPath,
  agentConfigPath,
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingPath,
  agentReactivatePath,
  agentSlackOAuthStartPath,
  agentSuspendPath,
  agentUsagePath,
  type ComputerConnectCodeExchangeRequest,
  type ComputerConnectCodeExchangeResponse,
  ComputerConnectCodeExchangeResponseSchema,
  type ComputerConnectCodeIssueResponse,
  ComputerConnectCodeIssueResponseSchema,
  type ComputerConnectCodeStatus,
  ComputerConnectCodeStatusSchema,
  type ConnectCodeExchangeResponse,
  ConnectCodeExchangeResponseSchema,
  type CreateAgentRequest,
  type ErrorCategory,
  type ErrorCode,
  ErrorEnvelopeSchema,
  type FeishuSetupAttempt,
  FeishuSetupAttemptSchema,
  feishuSetupAttemptPath,
  HTTP_PATHS,
  type ImBindingAdminDetail,
  ImBindingAdminDetailSchema,
  type ImBindingDiagnostics,
  ImBindingDiagnosticsSchema,
  type ImBindingSummary,
  ImBindingSummarySchema,
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  type ListAgentsResponse,
  ListAgentsResponseSchema,
  type ListWorkspaceComputersResponse,
  ListWorkspaceComputersResponseSchema,
  type MeResponse,
  MeResponseSchema,
  PROVIDER_READINESS_V1_HEADER,
  type RefreshTokenResponse,
  RefreshTokenResponseSchema,
  runtimeImResourcePath,
  SESSION_CLI_PROOF_HEADER,
  type SessionCliCommandResponse,
  SessionCliCommandResponseSchema,
  type SessionCliCreateRequest,
  type SessionCliListQuery,
  type SessionCliListResponse,
  SessionCliListResponseSchema,
  type SessionCliSendRequest,
  type StartSlackOAuthRequest,
  type StartSlackOAuthResponse,
  StartSlackOAuthResponseSchema,
  type UpdateAgentRequest,
  type ValidationIssue,
} from "@opentag/shared";
import {
  awaitWithAbort,
  defaultPhase,
  defaultRetryability,
  type ErrorPhase,
  type ErrorRetryability,
  OPEN_TAG_API_REQUEST_TIMEOUT_MS,
  prepareRequest,
  REQUEST_ID_HEADER,
  type RequestCause,
  type RequestOptions,
  safeCause,
  statusFallback,
} from "./request-policy.js";

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class OpenTagApiError extends Error {
  constructor(
    readonly code: ErrorCode | string,
    readonly category: ErrorCategory,
    message: string,
    readonly status?: number,
    readonly issues?: readonly ValidationIssue[],
    options: {
      cause?: unknown;
      retryability?: ErrorRetryability;
      phase?: ErrorPhase;
      requestId?: string;
      safeCause?: RequestCause;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpenTagApiError";
    this.retryability = options.retryability ?? defaultRetryability(category);
    this.phase = options.phase ?? defaultPhase(category);
    this.requestId = options.requestId;
    this.safeCause = options.safeCause ?? safeCause(options.cause);
  }

  readonly retryability: ErrorRetryability;
  readonly phase: ErrorPhase;
  readonly requestId?: string;
  readonly safeCause?: RequestCause;
}

export interface OpenTagApiConstructorOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OpenTagApi {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #responseRequestIds = new WeakMap<Response, string>();

  constructor(
    serverUrl: string,
    fetchOrOptions: typeof fetch | OpenTagApiConstructorOptions = fetch,
    options: OpenTagApiConstructorOptions = {},
  ) {
    this.#baseUrl = new URL(normalizeServerUrl(serverUrl));
    const constructorOptions = typeof fetchOrOptions === "function" ? options : fetchOrOptions;
    this.#fetch = typeof fetchOrOptions === "function" ? fetchOrOptions : (constructorOptions.fetchImpl ?? fetch);
    this.#timeoutMs = constructorOptions.timeoutMs ?? OPEN_TAG_API_REQUEST_TIMEOUT_MS;
  }

  exchangeConnectCode(
    code: string,
    expectedUserId?: string,
    options?: RequestOptions,
  ): Promise<ConnectCodeExchangeResponse> {
    return this.#request(
      HTTP_PATHS.authConnectExchange,
      ConnectCodeExchangeResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ code, ...(expectedUserId ? { expectedUserId } : {}) }),
        headers: { "content-type": "application/json" },
      },
      options,
    );
  }

  exchangeComputerConnectCode(
    input: ComputerConnectCodeExchangeRequest,
    options?: RequestOptions,
  ): Promise<ComputerConnectCodeExchangeResponse> {
    return this.#request(
      HTTP_PATHS.computerConnectExchange,
      ComputerConnectCodeExchangeResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
      },
      options,
    );
  }

  refresh(refreshToken: string, options?: RequestOptions): Promise<RefreshTokenResponse> {
    return this.#request(
      HTTP_PATHS.authRefresh,
      RefreshTokenResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
        headers: { "content-type": "application/json" },
      },
      options,
    );
  }

  me(accessToken: string, options?: RequestOptions): Promise<MeResponse> {
    return this.#request(
      HTTP_PATHS.me,
      MeResponseSchema,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  issueComputerConnectCode(accessToken: string, options?: RequestOptions): Promise<ComputerConnectCodeIssueResponse> {
    return this.#request(
      HTTP_PATHS.accountComputerConnectCodes,
      ComputerConnectCodeIssueResponseSchema,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  getComputerConnectCodeStatus(
    accessToken: string,
    connectCodeId: string,
    options?: RequestOptions,
  ): Promise<ComputerConnectCodeStatus> {
    return this.#request(
      accountComputerConnectCodePath(connectCodeId),
      ComputerConnectCodeStatusSchema,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  listAccountComputers(accessToken: string, options?: RequestOptions): Promise<ListWorkspaceComputersResponse> {
    return this.#request(
      HTTP_PATHS.accountComputers,
      ListWorkspaceComputersResponseSchema,
      {
        headers: { authorization: `Bearer ${accessToken}`, [PROVIDER_READINESS_V1_HEADER]: "1" },
      },
      options,
    );
  }

  createAgent(accessToken: string, input: CreateAgentRequest, options?: RequestOptions): Promise<AgentAdminConfig> {
    return this.#request(
      HTTP_PATHS.accountAgents,
      AgentAdminConfigSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      },
      options,
    );
  }

  listAgents(accessToken: string, options?: RequestOptions): Promise<ListAgentsResponse> {
    return this.#request(
      HTTP_PATHS.accountAgents,
      ListAgentsResponseSchema,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  getAgent(accessToken: string, agentId: string, options?: RequestOptions): Promise<AgentDetail> {
    return this.#request(
      agentByIdPath(agentId),
      AgentDetailSchema,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  getAgentUsage(
    accessToken: string,
    agentId: string,
    windowDays: AgentUsageWindowDays,
    options?: RequestOptions,
  ): Promise<AgentUsageDetail> {
    return this.#request(
      agentUsagePath(agentId, windowDays),
      AgentUsageDetailSchema,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  getAgentConfig(accessToken: string, agentId: string, options?: RequestOptions): Promise<AgentAdminConfig> {
    return this.#request(
      agentConfigPath(agentId),
      AgentAdminConfigSchema,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  updateAgent(
    accessToken: string,
    agentId: string,
    input: UpdateAgentRequest,
    options?: RequestOptions,
  ): Promise<AgentAdminConfig> {
    return this.#request(
      agentByIdPath(agentId),
      AgentAdminConfigSchema,
      {
        method: "PATCH",
        body: JSON.stringify(input),
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      },
      options,
    );
  }

  suspendAgent(accessToken: string, agentId: string, options?: RequestOptions): Promise<AgentAdminConfig> {
    return this.#request(
      agentSuspendPath(agentId),
      AgentAdminConfigSchema,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  reactivateAgent(accessToken: string, agentId: string, options?: RequestOptions): Promise<AgentAdminConfig> {
    return this.#request(
      agentReactivatePath(agentId),
      AgentAdminConfigSchema,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  deleteAgent(accessToken: string, agentId: string, options?: RequestOptions): Promise<void> {
    return this.#requestNoContent(
      agentByIdPath(agentId),
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  getAgentImBinding(
    accessToken: string,
    agentId: string,
    options?: RequestOptions,
  ): Promise<ImBindingSummary | undefined> {
    return this.#requestOptional(
      agentImBindingPath(agentId),
      ImBindingSummarySchema,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  getAgentImBindingConfig(
    accessToken: string,
    agentId: string,
    options?: RequestOptions,
  ): Promise<ImBindingAdminDetail | undefined> {
    return this.#requestOptional(
      agentImBindingConfigPath(agentId),
      ImBindingAdminDetailSchema,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  createFeishuSetupAttempt(
    accessToken: string,
    agentId: string,
    intent: "create" | "reauthorize" | "replace" = "create",
    options?: RequestOptions,
  ): Promise<FeishuSetupAttempt> {
    return this.#request(
      agentFeishuSetupAttemptsPath(agentId),
      FeishuSetupAttemptSchema,
      {
        method: "POST",
        body: JSON.stringify({ intent }),
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      },
      options,
    );
  }

  getFeishuSetupAttempt(accessToken: string, attemptId: string, options?: RequestOptions): Promise<FeishuSetupAttempt> {
    return this.#request(
      feishuSetupAttemptPath(attemptId),
      FeishuSetupAttemptSchema,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  cancelFeishuSetupAttempt(
    accessToken: string,
    attemptId: string,
    options?: RequestOptions,
  ): Promise<FeishuSetupAttempt> {
    return this.#request(
      `${feishuSetupAttemptPath(attemptId)}/cancel`,
      FeishuSetupAttemptSchema,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  startSlackOAuth(
    accessToken: string,
    agentId: string,
    input: StartSlackOAuthRequest,
    options?: RequestOptions,
  ): Promise<StartSlackOAuthResponse> {
    return this.#request(
      agentSlackOAuthStartPath(agentId),
      StartSlackOAuthResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      },
      options,
    );
  }

  getImBindingDiagnostics(
    accessToken: string,
    imBindingId: string,
    options?: RequestOptions,
  ): Promise<ImBindingDiagnostics> {
    return this.#request(
      imBindingDiagnosticsPath(imBindingId),
      ImBindingDiagnosticsSchema,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  disableImBinding(accessToken: string, imBindingId: string, options?: RequestOptions): Promise<void> {
    return this.#requestNoContent(
      imBindingDisablePath(imBindingId),
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      },
      options,
    );
  }

  async openImResource(
    machineToken: string,
    imMessageId: string,
    ordinal: number,
    scope: { sessionId: string; instanceId: string; placementGeneration: number },
    options?: RequestOptions,
  ): Promise<Response> {
    const response = await this.#fetchResponse(
      runtimeImResourcePath(imMessageId, ordinal, scope),
      {
        headers: { authorization: `Bearer ${machineToken}` },
      },
      options,
    );
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      this.#throwResponseError(response.status, body, this.#requestIdFromResponse(response));
    }
    return response;
  }

  createInternalSession(
    proof: string,
    input: SessionCliCreateRequest,
    options?: RequestOptions,
  ): Promise<SessionCliCommandResponse> {
    return this.#request(
      HTTP_PATHS.runtimeInternalSessions,
      SessionCliCommandResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  sendSessionMessage(
    proof: string,
    input: SessionCliSendRequest,
    options?: RequestOptions,
  ): Promise<SessionCliCommandResponse> {
    return this.#request(
      HTTP_PATHS.runtimeSessionMessages,
      SessionCliCommandResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  listInternalSessions(
    proof: string,
    input: SessionCliListQuery,
    options?: RequestOptions,
  ): Promise<SessionCliListResponse> {
    const query = new URLSearchParams({
      recursive: String(input.recursive),
      limit: String(input.limit),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.since ? { since: input.since } : {}),
    });
    return this.#request(
      `${HTTP_PATHS.runtimeSessions}?${query.toString()}`,
      SessionCliListResponseSchema,
      {
        headers: { [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  async #request<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit, options?: RequestOptions): Promise<T> {
    const response = await this.#fetchResponse(path, init, options);
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      this.#throwResponseError(response.status, body, this.#requestIdFromResponse(response));
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new OpenTagApiError(
        "SERVICE_UNAVAILABLE",
        "transient",
        "The OpenTag server returned an invalid response",
        response.status,
        undefined,
        {
          requestId: this.#requestIdFromResponse(response),
          phase: "serialization",
        },
      );
    }
    return parsed.data;
  }

  async #requestNoContent(path: string, init: RequestInit, options?: RequestOptions): Promise<void> {
    const response = await this.#fetchResponse(path, init, options);
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      this.#throwResponseError(response.status, body, this.#requestIdFromResponse(response));
    }
    if (response.status !== 204) {
      throw new OpenTagApiError(
        "SERVICE_UNAVAILABLE",
        "transient",
        "The OpenTag server returned an invalid response",
        response.status,
        undefined,
        {
          requestId: this.#requestIdFromResponse(response),
          phase: "serialization",
        },
      );
    }
  }

  async #requestOptional<T>(
    path: string,
    schema: RuntimeSchema<T>,
    init: RequestInit,
    options?: RequestOptions,
  ): Promise<T | undefined> {
    const response = await this.#fetchResponse(path, init, options);
    if (response.status === 204) return undefined;
    const body = await response.json().catch(() => undefined);
    if (!response.ok) this.#throwResponseError(response.status, body, this.#requestIdFromResponse(response));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new OpenTagApiError(
        "SERVICE_UNAVAILABLE",
        "transient",
        "The OpenTag server returned an invalid response",
        response.status,
        undefined,
        {
          requestId: this.#requestIdFromResponse(response),
          phase: "serialization",
        },
      );
    }
    return parsed.data;
  }

  async #fetchResponse(path: string, init: RequestInit, options: RequestOptions = {}): Promise<Response> {
    const prepared = prepareRequest(init, options, this.#timeoutMs);
    try {
      const response = await awaitWithAbort(this.#fetch(new URL(path, this.#baseUrl), prepared.init), prepared.signal);
      this.#responseRequestIds.set(response, prepared.requestId);
      return response;
    } catch (error) {
      if (prepared.reason() === "caller") {
        throw new OpenTagApiError(
          "REQUEST_CANCELLED",
          "deterministic",
          "The request was cancelled by the caller",
          undefined,
          undefined,
          { cause: options.signal?.reason ?? error, phase: "request", requestId: prepared.requestId },
        );
      }
      if (prepared.reason() === "deadline") {
        const cause = safeCause(error);
        throw new OpenTagApiError(
          "REQUEST_TIMEOUT",
          "transient",
          "The OpenTag server request timed out",
          undefined,
          undefined,
          { cause, safeCause: cause, phase: "transport", requestId: prepared.requestId },
        );
      }
      const cause = safeCause(error);
      throw new OpenTagApiError(
        "SERVICE_UNAVAILABLE",
        "transient",
        "The OpenTag server is unavailable",
        undefined,
        undefined,
        { cause, safeCause: cause, phase: "transport", requestId: prepared.requestId },
      );
    } finally {
      prepared.cleanup();
    }
  }

  #requestIdFromResponse(response: Response): string {
    const requestId =
      response.headers.get(REQUEST_ID_HEADER) ??
      response.headers.get("x-request-id") ??
      this.#responseRequestIds.get(response);
    if (!requestId) throw new Error("OpenTag response is missing a request ID");
    return requestId;
  }

  #throwResponseError(status: number, body: unknown, requestId = "unknown"): never {
    const parsed = ErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) {
      throw new OpenTagApiError(
        parsed.data.error.code,
        parsed.data.error.category,
        parsed.data.error.message,
        status,
        parsed.data.error.issues,
        { requestId: parsed.data.error.requestId ?? requestId },
      );
    }
    const fallback = statusFallback(status);
    throw new OpenTagApiError(fallback.code, fallback.category, fallback.message, status, undefined, { requestId });
  }
}

export function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("The OpenTag server URL must use HTTP(S) without embedded credentials");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("The OpenTag server URL must be an origin without a path, query, or fragment");
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !isLoopback) {
    throw new Error("Plain HTTP is allowed only for loopback OpenTag servers");
  }
  return url.origin;
}
