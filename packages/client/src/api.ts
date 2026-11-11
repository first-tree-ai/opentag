import {
  type AccountApiEndpoint,
  type AccountApiNoContentEndpoint,
  type AgentAdminConfig,
  AgentAdminConfigSchema,
  type AgentDetail,
  type AgentRuntimeTestRequest,
  type AgentRuntimeTestResponse,
  type AgentSchedule,
  type AgentScheduleListResponse,
  AgentScheduleListResponseSchema,
  type AgentSchedulePreview,
  AgentSchedulePreviewSchema,
  AgentScheduleSchema,
  type AgentUsageDetail,
  type AgentUsageWindowDays,
  type AttachMCPServerRequest,
  accountApiEndpoints,
  agentSkillBundlePath,
  agentSkillsPath,
  type ComputerConnectCodeExchangeRequest,
  type ComputerConnectCodeExchangeResponse,
  ComputerConnectCodeExchangeResponseSchema,
  type ComputerConnectCodeIssueResponse,
  type ComputerConnectCodeStatus,
  type ConnectCodeExchangeResponse,
  ConnectCodeExchangeResponseSchema,
  type CreateAgentRequest,
  type CreateAgentScheduleRequest,
  type CreateMCPServerRequest,
  type CreateSelfMCPServerRequest,
  computerAgentSkillBundlePath,
  computerAgentSkillsPath,
  type ErrorCategory,
  type ErrorCode,
  ErrorEnvelopeSchema,
  type FeishuSetupAttempt,
  HTTP_PATHS,
  type ImBindingAdminDetail,
  type ImBindingDiagnostics,
  type ImBindingSummary,
  type InstallSkillPresetResponse,
  InstallSkillPresetResponseSchema,
  type ListAccountComputersResponse,
  type ListAgentMCPServersResponse,
  ListAgentMCPServersResponseSchema,
  type ListAgentSkillsResponse,
  ListAgentSkillsResponseSchema,
  type ListAgentsResponse,
  type ListAvailableMCPServersResponse,
  ListAvailableMCPServersResponseSchema,
  type ListMCPServersResponse,
  type ListSkillPresetsResponse,
  ListSkillPresetsResponseSchema,
  type MCPAgentServer,
  MCPAgentServerSchema,
  type MCPProbeResponse,
  type MCPServer,
  type MCPServerDetail,
  type MeResponse,
  type PreviewAgentScheduleRequest,
  type ProvisionSlackAgentRequest,
  type ProvisionSlackAgentResponse,
  ProvisionSlackAgentResponseSchema,
  type RefreshTokenResponse,
  RefreshTokenResponseSchema,
  RUNTIME_AGENT_MCP_SERVER_DEFINITIONS_PATH,
  RUNTIME_AGENT_MCP_SERVERS_AVAILABLE_PATH,
  RUNTIME_AGENT_MCP_SERVERS_PATH,
  RUNTIME_AGENT_PATH,
  RUNTIME_AGENT_SCHEDULE_PREVIEW_PATH,
  RUNTIME_AGENT_SCHEDULES_PATH,
  RUNTIME_AGENT_SLACK_PROVISION_PATH,
  RUNTIME_SKILL_PRESETS_PATH,
  RUNTIME_SKILLS_PATH,
  type RuntimeDurableWorkKind,
  RuntimeDurableWorkListResponseSchema,
  type RuntimeDurableWorkRecord,
  type RuntimeSkillManifest,
  RuntimeSkillManifestSchema,
  runtimeAgentMcpServerCredentialsPath,
  runtimeAgentMcpServerDefinitionPath,
  runtimeAgentMcpServerOAuthStartPath,
  runtimeAgentMcpServerOAuthStatusPath,
  runtimeAgentMcpServerPath,
  runtimeAgentSchedulePath,
  runtimeAgentSchedulePausePath,
  runtimeAgentScheduleResumePath,
  runtimeDurableWorkPath,
  runtimeImResourcePath,
  runtimeSkillBundlePath,
  runtimeSkillPresetInstallPath,
  SESSION_CLI_PROOF_HEADER,
  SESSION_CLI_RUN_INPUTS_HEADER,
  type SelfMCPOAuthStatus,
  SelfMCPOAuthStatusSchema,
  type SessionCliAgentListQuery,
  type SessionCliAgentListResponse,
  SessionCliAgentListResponseSchema,
  type SessionCliCommandResponse,
  SessionCliCommandResponseSchema,
  type SessionCliCreateRequest,
  type SessionCliListQuery,
  type SessionCliListResponse,
  SessionCliListResponseSchema,
  type SessionCliSendRequest,
  type SessionCliStopRequest,
  type SessionCliStopResponse,
  SessionCliStopResponseSchema,
  type SetMCPAuthorizationRequest,
  SKILL_FORMAT_HEADER,
  SKILL_REPLACE_HEADER,
  SKILL_SHA256_HEADER,
  SKILL_UPLOAD_CONTENT_TYPE,
  type SkillArchiveFormat,
  type SkillDetail,
  SkillDetailSchema,
  type StartMCPOAuthRequest,
  type StartMCPOAuthResponse,
  StartMCPOAuthResponseSchema,
  type StartSlackOAuthRequest,
  type StartSlackOAuthResponse,
  type StructuredError,
  StructuredErrorSchema,
  toAccountApiRequestInit,
  type UpdateAgentRequest,
  type UpdateAgentScheduleRequest,
  type UpdateMCPBindingRequest,
  type UpdateMCPServerRequest,
  type UpdateSelfAgentRequest,
  type UpdateSelfMCPBindingRequest,
  type UpdateSkillRequest,
  type ValidationIssue,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "./observability/logger.js";
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
import { parseResponseIgnoringUnknownKeys } from "./response-parse.js";

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class OpenTagApiError extends Error {
  readonly structuredError: StructuredError;

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
    this.structuredError = StructuredErrorSchema.parse({
      code: this.code,
      category: structuredCategory(category, this.code, status),
      retryability: this.retryability,
      phase: this.phase,
      ...(this.requestId ? { requestId: this.requestId.slice(0, 256) } : {}),
      message: message.slice(0, 2_048),
      ...(this.safeCause ? { cause: this.safeCause } : {}),
    });
  }

  readonly retryability: ErrorRetryability;
  readonly phase: ErrorPhase;
  readonly requestId?: string;
  readonly safeCause?: RequestCause;

  toStructuredError(): StructuredError {
    return this.structuredError;
  }
}

function structuredCategory(category: ErrorCategory, code: string, status?: number): StructuredError["category"] {
  if (category === "credential") return "auth";
  if (category === "validation") return "validation";
  if (category === "rate_limit") return "rate_limit";
  if (category === "transient") return "unavailable";
  if (code === "REQUEST_CANCELLED") return "cancelled";
  if (code === "RESOURCE_NOT_FOUND" || status === 404) return "not_found";
  if (status === 409 || /(?:CONFLICT|_CONFLICT)$/u.test(code)) return "conflict";
  return "internal";
}

export interface OpenTagApiConstructorOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: Pick<ClientLogger, "debug">;
}

export class OpenTagApi {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #logger: Pick<ClientLogger, "debug">;
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
    this.#logger = constructorOptions.logger ?? createLogger("api");
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

  async exchangeComputerConnectCode(
    input: ComputerConnectCodeExchangeRequest,
    options?: RequestOptions,
  ): Promise<ComputerConnectCodeExchangeResponse> {
    const send = (body: ComputerConnectCodeExchangeRequest) =>
      this.#request(
        HTTP_PATHS.computerConnectExchange,
        ComputerConnectCodeExchangeResponseSchema,
        { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
        options,
      );
    try {
      return await send(input);
    } catch (error) {
      // An older Server rejects the optional idempotency fields as unknown keys. Validation runs
      // before redemption, so the code is untouched and one legacy retry is safe.
      const { machineToken: _token, reportOutcome: _outcome, ...legacy } = input;
      if (!isUnknownExchangeFieldRejection(error, input)) throw error;
      return send(legacy);
    }
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
    return this.#requestAccount(accessToken, accountApiEndpoints.me(), options);
  }

  issueComputerConnectCode(accessToken: string, options?: RequestOptions): Promise<ComputerConnectCodeIssueResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.issueComputerConnectCode(), options);
  }

  getComputerConnectCodeStatus(
    accessToken: string,
    connectCodeId: string,
    options?: RequestOptions,
  ): Promise<ComputerConnectCodeStatus> {
    return this.#requestAccount(accessToken, accountApiEndpoints.computerConnectCodeStatus(connectCodeId), options);
  }

  listAccountComputers(accessToken: string, options?: RequestOptions): Promise<ListAccountComputersResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.listAccountComputers(), options);
  }

  createAgent(accessToken: string, input: CreateAgentRequest, options?: RequestOptions): Promise<AgentAdminConfig> {
    return this.#requestAccount(accessToken, accountApiEndpoints.createAgent(input), options);
  }

  listAgents(accessToken: string, options?: RequestOptions): Promise<ListAgentsResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.listAgents(), options);
  }

  getAgent(accessToken: string, agentId: string, options?: RequestOptions): Promise<AgentDetail> {
    return this.#requestAccount(accessToken, accountApiEndpoints.getAgent(agentId), options);
  }

  getAgentUsage(
    accessToken: string,
    agentId: string,
    windowDays: AgentUsageWindowDays,
    options?: RequestOptions,
  ): Promise<AgentUsageDetail> {
    return this.#requestAccount(accessToken, accountApiEndpoints.getAgentUsage(agentId, windowDays), options);
  }

  getAgentConfig(accessToken: string, agentId: string, options?: RequestOptions): Promise<AgentAdminConfig> {
    return this.#requestAccount(accessToken, accountApiEndpoints.getAgentConfig(agentId), options);
  }

  testAgentRuntime(
    accessToken: string,
    agentId: string,
    input: AgentRuntimeTestRequest,
    options?: RequestOptions,
  ): Promise<AgentRuntimeTestResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.testAgentRuntime(agentId, input), options);
  }

  rebindAgentComputer(accessToken: string, agentId: string, computerId: string): Promise<AgentAdminConfig> {
    return this.#requestAccount(accessToken, accountApiEndpoints.rebindAgentComputer(agentId, computerId));
  }

  updateAgent(
    accessToken: string,
    agentId: string,
    input: UpdateAgentRequest,
    options?: RequestOptions,
  ): Promise<AgentAdminConfig> {
    return this.#requestAccount(accessToken, accountApiEndpoints.updateAgent(agentId, input), options);
  }

  suspendAgent(accessToken: string, agentId: string, options?: RequestOptions): Promise<AgentAdminConfig> {
    return this.#requestAccount(accessToken, accountApiEndpoints.suspendAgent(agentId), options);
  }

  reactivateAgent(accessToken: string, agentId: string, options?: RequestOptions): Promise<AgentAdminConfig> {
    return this.#requestAccount(accessToken, accountApiEndpoints.reactivateAgent(agentId), options);
  }

  deleteAgent(accessToken: string, agentId: string, options?: RequestOptions): Promise<void> {
    return this.#requestNoContentAccount(accessToken, accountApiEndpoints.deleteAgent(agentId), options);
  }

  getAgentImBinding(
    accessToken: string,
    agentId: string,
    options?: RequestOptions,
  ): Promise<ImBindingSummary | undefined> {
    return this.#requestOptionalAccount(accessToken, accountApiEndpoints.getAgentImBinding(agentId), options);
  }

  getAgentImBindingConfig(
    accessToken: string,
    agentId: string,
    options?: RequestOptions,
  ): Promise<ImBindingAdminDetail | undefined> {
    return this.#requestOptionalAccount(accessToken, accountApiEndpoints.getAgentImBindingConfig(agentId), options);
  }

  createFeishuSetupAttempt(
    accessToken: string,
    agentId: string,
    intent: "create" | "reauthorize" | "replace" = "create",
    options?: RequestOptions,
  ): Promise<FeishuSetupAttempt> {
    return this.#requestAccount(accessToken, accountApiEndpoints.createFeishuSetupAttempt(agentId, intent), options);
  }

  getFeishuSetupAttempt(accessToken: string, attemptId: string, options?: RequestOptions): Promise<FeishuSetupAttempt> {
    return this.#requestAccount(accessToken, accountApiEndpoints.getFeishuSetupAttempt(attemptId), options);
  }

  cancelFeishuSetupAttempt(
    accessToken: string,
    attemptId: string,
    options?: RequestOptions,
  ): Promise<FeishuSetupAttempt> {
    return this.#requestAccount(accessToken, accountApiEndpoints.cancelFeishuSetupAttempt(attemptId), options);
  }

  startSlackOAuth(
    accessToken: string,
    agentId: string,
    input: StartSlackOAuthRequest,
    options?: RequestOptions,
  ): Promise<StartSlackOAuthResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.startSlackOAuth(agentId, input), options);
  }

  getImBindingDiagnostics(
    accessToken: string,
    imBindingId: string,
    options?: RequestOptions,
  ): Promise<ImBindingDiagnostics> {
    return this.#requestAccount(accessToken, accountApiEndpoints.getImBindingDiagnostics(imBindingId), options);
  }

  disableImBinding(accessToken: string, imBindingId: string, options?: RequestOptions): Promise<void> {
    return this.#requestNoContentAccount(accessToken, accountApiEndpoints.disableImBinding(imBindingId), options);
  }

  // ------------------------------------------------------------------ MCP management

  listMcpServers(accessToken: string, options?: RequestOptions): Promise<ListMCPServersResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.listMcpServers(), options);
  }

  createMcpServer(accessToken: string, input: CreateMCPServerRequest, options?: RequestOptions): Promise<MCPServer> {
    return this.#requestAccount(accessToken, accountApiEndpoints.createMcpServer(input), options);
  }

  getMcpServer(accessToken: string, mcpServerId: string, options?: RequestOptions): Promise<MCPServerDetail> {
    return this.#requestAccount(accessToken, accountApiEndpoints.getMcpServer(mcpServerId), options);
  }

  updateMcpServer(
    accessToken: string,
    mcpServerId: string,
    input: UpdateMCPServerRequest,
    options?: RequestOptions,
  ): Promise<MCPServer> {
    return this.#requestAccount(accessToken, accountApiEndpoints.updateMcpServer(mcpServerId, input), options);
  }

  removeMcpServer(accessToken: string, mcpServerId: string, options?: RequestOptions): Promise<void> {
    return this.#requestNoContentAccount(accessToken, accountApiEndpoints.removeMcpServer(mcpServerId), options);
  }

  listAgentMcpServers(
    accessToken: string,
    agentId: string,
    options?: RequestOptions,
  ): Promise<ListAgentMCPServersResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.listAgentMcpServers(agentId), options);
  }

  listAvailableMcpServers(
    accessToken: string,
    agentId: string,
    options?: RequestOptions,
  ): Promise<ListAvailableMCPServersResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.listAvailableMcpServers(agentId), options);
  }

  attachMcpServer(
    accessToken: string,
    agentId: string,
    input: AttachMCPServerRequest,
    options?: RequestOptions,
  ): Promise<MCPAgentServer> {
    return this.#requestAccount(accessToken, accountApiEndpoints.attachMcpServer(agentId, input), options);
  }

  updateAgentMcpServer(
    accessToken: string,
    agentId: string,
    mcpServerId: string,
    input: UpdateMCPBindingRequest,
    options?: RequestOptions,
  ): Promise<MCPAgentServer> {
    return this.#requestAccount(
      accessToken,
      accountApiEndpoints.updateAgentMcpServer(agentId, mcpServerId, input),
      options,
    );
  }

  detachMcpServer(accessToken: string, agentId: string, mcpServerId: string, options?: RequestOptions): Promise<void> {
    return this.#requestNoContentAccount(
      accessToken,
      accountApiEndpoints.detachMcpServer(agentId, mcpServerId),
      options,
    );
  }

  setMcpAuthorization(
    accessToken: string,
    agentId: string,
    mcpServerId: string,
    input: SetMCPAuthorizationRequest,
    options?: RequestOptions,
  ): Promise<MCPAgentServer> {
    return this.#requestAccount(
      accessToken,
      accountApiEndpoints.setMcpAuthorization(agentId, mcpServerId, input),
      options,
    );
  }

  revokeMcpAuthorization(
    accessToken: string,
    agentId: string,
    mcpServerId: string,
    options?: RequestOptions & { expectedOAuthState?: string },
  ): Promise<MCPAgentServer> {
    return this.#requestAccount(
      accessToken,
      accountApiEndpoints.revokeMcpAuthorization(agentId, mcpServerId, options?.expectedOAuthState),
      options,
    );
  }

  startMcpOAuth(
    accessToken: string,
    agentId: string,
    mcpServerId: string,
    input: StartMCPOAuthRequest = {},
    options?: RequestOptions,
  ): Promise<StartMCPOAuthResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.startMcpOAuth(agentId, mcpServerId, input), options);
  }

  probeMcpServer(
    accessToken: string,
    agentId: string,
    mcpServerId: string,
    options?: RequestOptions,
  ): Promise<MCPProbeResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.probeMcpServer(agentId, mcpServerId), options);
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

  async listRuntimeDurableWork(
    machineToken: string,
    kind: RuntimeDurableWorkKind,
    options?: RequestOptions,
  ): Promise<RuntimeDurableWorkRecord[]> {
    const records: RuntimeDurableWorkRecord[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ kind, ...(cursor ? { cursor } : {}) });
      const response = await this.#request(
        `${HTTP_PATHS.runtimeDurableWork}?${query.toString()}`,
        RuntimeDurableWorkListResponseSchema,
        { headers: { authorization: `Bearer ${machineToken}` } },
        options,
      );
      records.push(...response.items);
      cursor = response.nextCursor;
    } while (cursor);
    return records;
  }

  writeRuntimeDurableWork(
    machineToken: string,
    record: RuntimeDurableWorkRecord,
    options?: RequestOptions,
  ): Promise<void> {
    return this.#requestNoContent(
      runtimeDurableWorkPath(record.kind, record.key),
      {
        method: "PUT",
        body: JSON.stringify(record),
        headers: { authorization: `Bearer ${machineToken}`, "content-type": "application/json" },
      },
      options,
    );
  }

  createInternalSession(
    proof: string,
    input: SessionCliCreateRequest,
    options?: RequestOptions & { executionId?: string; runInputs?: string },
  ): Promise<SessionCliCommandResponse> {
    return this.#request(
      HTTP_PATHS.runtimeInternalSessions,
      SessionCliCommandResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          [SESSION_CLI_PROOF_HEADER]: proof,
          ...(options?.executionId ? { "x-opentag-execution-id": options.executionId } : {}),
          ...(options?.runInputs ? { [SESSION_CLI_RUN_INPUTS_HEADER]: options.runInputs } : {}),
        },
      },
      options,
    );
  }

  sendSessionMessage(
    proof: string,
    input: SessionCliSendRequest,
    options?: RequestOptions & { executionId?: string; runInputs?: string },
  ): Promise<SessionCliCommandResponse> {
    return this.#request(
      HTTP_PATHS.runtimeSessionMessages,
      SessionCliCommandResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          [SESSION_CLI_PROOF_HEADER]: proof,
          ...(options?.executionId ? { "x-opentag-execution-id": options.executionId } : {}),
          ...(options?.runInputs ? { [SESSION_CLI_RUN_INPUTS_HEADER]: options.runInputs } : {}),
        },
      },
      options,
    );
  }

  stopSession(
    proof: string,
    input: SessionCliStopRequest,
    options?: RequestOptions & { executionId?: string; runInputs?: string },
  ): Promise<SessionCliStopResponse> {
    return this.#request(
      HTTP_PATHS.runtimeSessionStop,
      SessionCliStopResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          [SESSION_CLI_PROOF_HEADER]: proof,
          ...(options?.executionId ? { "x-opentag-execution-id": options.executionId } : {}),
          ...(options?.runInputs ? { [SESSION_CLI_RUN_INPUTS_HEADER]: options.runInputs } : {}),
        },
      },
      options,
    );
  }

  listAgentSessions(
    proof: string,
    input: SessionCliAgentListQuery,
    options?: RequestOptions,
  ): Promise<SessionCliAgentListResponse> {
    const query = new URLSearchParams({
      limit: String(input.limit),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.visibleOnly ? { visibleOnly: "true" } : {}),
    });
    return this.#request(
      `${HTTP_PATHS.runtimeAgentSessions}?${query.toString()}`,
      SessionCliAgentListResponseSchema,
      {
        headers: { [SESSION_CLI_PROOF_HEADER]: proof },
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
      ...(input.includeStopped ? { includeStopped: "true" } : {}),
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

  // ------------------------------------------------------------------ Agent Skills

  listAgentSkills(accessToken: string, agentId: string, options?: RequestOptions): Promise<ListAgentSkillsResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.listAgentSkills(agentId), options);
  }

  getAgentSkill(accessToken: string, agentId: string, skillId: string, options?: RequestOptions): Promise<SkillDetail> {
    return this.#requestAccount(accessToken, accountApiEndpoints.getAgentSkill(agentId, skillId), options);
  }

  uploadAgentSkill(
    accessToken: string,
    agentId: string,
    input: SkillUploadInput,
    options?: RequestOptions,
  ): Promise<SkillDetail> {
    return this.#request(
      agentSkillsPath(agentId),
      SkillDetailSchema,
      {
        method: "POST",
        body: input.archive,
        headers: {
          authorization: `Bearer ${accessToken}`,
          [SKILL_SHA256_HEADER]: input.sha256,
          [SKILL_FORMAT_HEADER]: input.format,
          ...(input.replace ? { [SKILL_REPLACE_HEADER]: "true" } : {}),
          ...skillUploadHeaders(input.archive.byteLength),
        },
      },
      options,
    );
  }

  updateAgentSkill(
    accessToken: string,
    agentId: string,
    skillId: string,
    input: UpdateSkillRequest,
    options?: RequestOptions,
  ): Promise<SkillDetail> {
    return this.#requestAccount(accessToken, accountApiEndpoints.updateAgentSkill(agentId, skillId, input), options);
  }

  removeAgentSkill(accessToken: string, agentId: string, skillId: string, options?: RequestOptions): Promise<void> {
    return this.#requestNoContentAccount(accessToken, accountApiEndpoints.removeAgentSkill(agentId, skillId), options);
  }

  openAgentSkillBundle(accessToken: string, agentId: string, skillId: string, options?: RequestOptions) {
    return this.#openBinaryResponse(
      agentSkillBundlePath(agentId, skillId),
      { headers: { authorization: `Bearer ${accessToken}` } },
      options,
    );
  }

  getComputerSkillManifest(
    machineToken: string,
    agentId: string,
    options?: RequestOptions,
  ): Promise<RuntimeSkillManifest> {
    return this.#request(
      computerAgentSkillsPath(agentId),
      RuntimeSkillManifestSchema,
      { headers: { authorization: `Bearer ${machineToken}` } },
      options,
    );
  }

  openComputerSkillBundle(
    machineToken: string,
    agentId: string,
    skillId: string,
    options?: RequestOptions,
  ): Promise<Response> {
    return this.#openBinaryResponse(
      computerAgentSkillBundlePath(agentId, skillId),
      { headers: { authorization: `Bearer ${machineToken}` } },
      options,
    );
  }

  listRuntimeSkills(proof: string, options?: RequestOptions): Promise<ListAgentSkillsResponse> {
    return this.#request(
      RUNTIME_SKILLS_PATH,
      ListAgentSkillsResponseSchema,
      { headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  pushRuntimeSkill(proof: string, input: SkillUploadInput, options?: RequestOptions): Promise<SkillDetail> {
    return this.#request(
      RUNTIME_SKILLS_PATH,
      SkillDetailSchema,
      {
        method: "POST",
        body: input.archive,
        headers: {
          [SESSION_CLI_PROOF_HEADER]: proof,
          [SKILL_SHA256_HEADER]: input.sha256,
          [SKILL_FORMAT_HEADER]: input.format,
          ...(input.replace ? { [SKILL_REPLACE_HEADER]: "true" } : {}),
          ...skillUploadHeaders(input.archive.byteLength),
        },
      },
      options,
    );
  }

  openRuntimeSkillBundle(proof: string, name: string, options?: RequestOptions): Promise<Response> {
    return this.#openBinaryResponse(
      runtimeSkillBundlePath(name),
      { headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  listSkillPresets(accessToken: string, agentId: string, options?: RequestOptions): Promise<ListSkillPresetsResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.listSkillPresets(agentId), options);
  }

  installSkillPreset(
    accessToken: string,
    agentId: string,
    presetName: string,
    options?: RequestOptions,
  ): Promise<InstallSkillPresetResponse> {
    return this.#requestAccount(accessToken, accountApiEndpoints.installSkillPreset(agentId, presetName), options);
  }

  listRuntimeSkillPresets(proof: string, options?: RequestOptions): Promise<ListSkillPresetsResponse> {
    return this.#request(
      RUNTIME_SKILL_PRESETS_PATH,
      ListSkillPresetsResponseSchema,
      { headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  installRuntimeSkillPreset(
    proof: string,
    presetName: string,
    options?: RequestOptions,
  ): Promise<InstallSkillPresetResponse> {
    return this.#request(
      runtimeSkillPresetInstallPath(presetName),
      InstallSkillPresetResponseSchema,
      {
        method: "POST",
        body: "{}",
        headers: { [SESSION_CLI_PROOF_HEADER]: proof, "content-type": "application/json" },
      },
      options,
    );
  }

  // ------------------------------------------------------------------ Agent self-configuration

  getRuntimeAgentConfig(proof: string, options?: RequestOptions): Promise<AgentAdminConfig> {
    return this.#request(
      RUNTIME_AGENT_PATH,
      AgentAdminConfigSchema,
      { headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  updateRuntimeAgentConfig(
    proof: string,
    input: UpdateSelfAgentRequest,
    options?: RequestOptions,
  ): Promise<AgentAdminConfig> {
    return this.#request(
      RUNTIME_AGENT_PATH,
      AgentAdminConfigSchema,
      {
        method: "PATCH",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  createRuntimeAgentSchedule(
    proof: string,
    input: CreateAgentScheduleRequest,
    options?: RequestOptions & { executionId?: string; runInputs?: string },
  ): Promise<AgentSchedule> {
    return this.#request(
      RUNTIME_AGENT_SCHEDULES_PATH,
      AgentScheduleSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          [SESSION_CLI_PROOF_HEADER]: proof,
          ...(options?.executionId ? { "x-opentag-execution-id": options.executionId } : {}),
          ...(options?.runInputs ? { [SESSION_CLI_RUN_INPUTS_HEADER]: options.runInputs } : {}),
        },
      },
      options,
    );
  }

  listRuntimeAgentSchedules(
    proof: string,
    query: { limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<AgentScheduleListResponse> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const path =
      params.size > 0 ? `${RUNTIME_AGENT_SCHEDULES_PATH}?${params.toString()}` : RUNTIME_AGENT_SCHEDULES_PATH;
    return this.#request(
      path,
      AgentScheduleListResponseSchema,
      { headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  getRuntimeAgentSchedule(proof: string, scheduleId: string, options?: RequestOptions): Promise<AgentSchedule> {
    return this.#request(
      runtimeAgentSchedulePath(scheduleId),
      AgentScheduleSchema,
      { headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  updateRuntimeAgentSchedule(
    proof: string,
    scheduleId: string,
    input: UpdateAgentScheduleRequest,
    options?: RequestOptions & { executionId?: string; runInputs?: string },
  ): Promise<AgentSchedule> {
    return this.#request(
      runtimeAgentSchedulePath(scheduleId),
      AgentScheduleSchema,
      {
        method: "PATCH",
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          [SESSION_CLI_PROOF_HEADER]: proof,
          ...(options?.executionId ? { "x-opentag-execution-id": options.executionId } : {}),
          ...(options?.runInputs ? { [SESSION_CLI_RUN_INPUTS_HEADER]: options.runInputs } : {}),
        },
      },
      options,
    );
  }

  pauseRuntimeAgentSchedule(
    proof: string,
    scheduleId: string,
    expectedRevision: number,
    options?: RequestOptions,
  ): Promise<AgentSchedule> {
    return this.#request(
      runtimeAgentSchedulePausePath(scheduleId),
      AgentScheduleSchema,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision }),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  resumeRuntimeAgentSchedule(
    proof: string,
    scheduleId: string,
    expectedRevision: number,
    options?: RequestOptions & { executionId?: string; runInputs?: string },
  ): Promise<AgentSchedule> {
    return this.#request(
      runtimeAgentScheduleResumePath(scheduleId),
      AgentScheduleSchema,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision }),
        headers: {
          "content-type": "application/json",
          [SESSION_CLI_PROOF_HEADER]: proof,
          ...(options?.executionId ? { "x-opentag-execution-id": options.executionId } : {}),
          ...(options?.runInputs ? { [SESSION_CLI_RUN_INPUTS_HEADER]: options.runInputs } : {}),
        },
      },
      options,
    );
  }

  deleteRuntimeAgentSchedule(
    proof: string,
    scheduleId: string,
    expectedRevision: number,
    options?: RequestOptions,
  ): Promise<void> {
    const params = new URLSearchParams({ expectedRevision: String(expectedRevision) });
    return this.#requestNoContent(
      `${runtimeAgentSchedulePath(scheduleId)}?${params.toString()}`,
      { method: "DELETE", headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  previewRuntimeAgentSchedule(
    proof: string,
    input: PreviewAgentScheduleRequest,
    options?: RequestOptions,
  ): Promise<AgentSchedulePreview> {
    return this.#request(
      RUNTIME_AGENT_SCHEDULE_PREVIEW_PATH,
      AgentSchedulePreviewSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  provisionSlackAgent(
    proof: string,
    input: ProvisionSlackAgentRequest,
    options?: RequestOptions,
  ): Promise<ProvisionSlackAgentResponse> {
    return this.#request(
      RUNTIME_AGENT_SLACK_PROVISION_PATH,
      ProvisionSlackAgentResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  listRuntimeAgentMcpServers(proof: string, options?: RequestOptions): Promise<ListAgentMCPServersResponse> {
    return this.#request(
      RUNTIME_AGENT_MCP_SERVERS_PATH,
      ListAgentMCPServersResponseSchema,
      { headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  listRuntimeAgentAvailableMcpServers(
    proof: string,
    options?: RequestOptions,
  ): Promise<ListAvailableMCPServersResponse> {
    return this.#request(
      RUNTIME_AGENT_MCP_SERVERS_AVAILABLE_PATH,
      ListAvailableMCPServersResponseSchema,
      { headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  attachRuntimeAgentMcpServer(
    proof: string,
    input: AttachMCPServerRequest,
    options?: RequestOptions,
  ): Promise<MCPAgentServer> {
    return this.#request(
      RUNTIME_AGENT_MCP_SERVERS_PATH,
      MCPAgentServerSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  updateRuntimeAgentMcpBinding(
    proof: string,
    mcpServerId: string,
    input: UpdateSelfMCPBindingRequest,
    options?: RequestOptions,
  ): Promise<MCPAgentServer> {
    return this.#request(
      runtimeAgentMcpServerPath(mcpServerId),
      MCPAgentServerSchema,
      {
        method: "PATCH",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  detachRuntimeAgentMcpServer(proof: string, mcpServerId: string, options?: RequestOptions): Promise<void> {
    return this.#requestNoContent(
      runtimeAgentMcpServerPath(mcpServerId),
      { method: "DELETE", headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  createRuntimeAgentMcpServer(
    proof: string,
    input: CreateSelfMCPServerRequest,
    options?: RequestOptions,
  ): Promise<MCPAgentServer> {
    return this.#request(
      RUNTIME_AGENT_MCP_SERVER_DEFINITIONS_PATH,
      MCPAgentServerSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  deleteRuntimeAgentMcpServerDefinition(proof: string, mcpServerId: string, options?: RequestOptions): Promise<void> {
    return this.#requestNoContent(
      runtimeAgentMcpServerDefinitionPath(mcpServerId),
      { method: "DELETE", headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  setRuntimeAgentMcpBearerKey(
    proof: string,
    mcpServerId: string,
    apiKey: string,
    options?: RequestOptions,
  ): Promise<MCPAgentServer> {
    return this.#request(
      runtimeAgentMcpServerCredentialsPath(mcpServerId),
      MCPAgentServerSchema,
      {
        method: "POST",
        body: JSON.stringify({ apiKey }),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  startRuntimeAgentMcpOAuth(
    proof: string,
    mcpServerId: string,
    input: StartMCPOAuthRequest = {},
    options?: RequestOptions,
  ): Promise<StartMCPOAuthResponse> {
    return this.#request(
      runtimeAgentMcpServerOAuthStartPath(mcpServerId),
      StartMCPOAuthResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", [SESSION_CLI_PROOF_HEADER]: proof },
      },
      options,
    );
  }

  getRuntimeAgentMcpOAuthStatus(
    proof: string,
    mcpServerId: string,
    options?: RequestOptions,
  ): Promise<SelfMCPOAuthStatus> {
    return this.#request(
      runtimeAgentMcpServerOAuthStatusPath(mcpServerId),
      SelfMCPOAuthStatusSchema,
      { headers: { [SESSION_CLI_PROOF_HEADER]: proof } },
      options,
    );
  }

  #requestAccount<T>(accessToken: string, endpoint: AccountApiEndpoint<T>, options?: RequestOptions): Promise<T> {
    return this.#request(
      endpoint.path,
      endpoint.schema,
      toAccountApiRequestInit(endpoint, { authorization: `Bearer ${accessToken}` }),
      options,
    );
  }

  #requestOptionalAccount<T>(
    accessToken: string,
    endpoint: AccountApiEndpoint<T>,
    options?: RequestOptions,
  ): Promise<T | undefined> {
    return this.#requestOptional(
      endpoint.path,
      endpoint.schema,
      toAccountApiRequestInit(endpoint, { authorization: `Bearer ${accessToken}` }),
      options,
    );
  }

  #requestNoContentAccount(
    accessToken: string,
    endpoint: AccountApiNoContentEndpoint,
    options?: RequestOptions,
  ): Promise<void> {
    return this.#requestNoContent(
      endpoint.path,
      toAccountApiRequestInit(endpoint, { authorization: `Bearer ${accessToken}` }),
      options,
    );
  }

  async #openBinaryResponse(path: string, init: RequestInit, options?: RequestOptions): Promise<Response> {
    const response = await this.#fetchResponse(path, init, options);
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      this.#throwResponseError(response.status, body, this.#requestIdFromResponse(response));
    }
    return response;
  }

  async #request<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit, options?: RequestOptions): Promise<T> {
    const response = await this.#fetchResponse(path, init, options);
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      this.#throwResponseError(response.status, body, this.#requestIdFromResponse(response));
    }
    return this.#parseResponse(path, schema, body, response);
  }

  /**
   * Parses a response with its shared schema, ignoring fields this client does not know so that a
   * newer Server's additive fields never break an older CLI. See `response-parse.ts`.
   */
  #parseResponse<T>(path: string, schema: RuntimeSchema<T>, body: unknown, response: Response): T {
    const parsed = parseResponseIgnoringUnknownKeys(schema, body);
    if (parsed.ignoredKeys.length > 0) {
      // Key paths only, never values: enough to see version skew without logging response content.
      this.#logger.debug(
        { path: new URL(path, this.#baseUrl).pathname, ignoredKeys: parsed.ignoredKeys },
        "Ignored response fields unknown to this client",
      );
    }
    if (parsed.success) return parsed.data;
    throw new OpenTagApiError(
      "SERVICE_UNAVAILABLE",
      "transient",
      parsed.reason === "unknown_key_pass_limit"
        ? "The openTag server returned a response with too many unknown fields"
        : "The openTag server returned an invalid response",
      response.status,
      undefined,
      {
        requestId: this.#requestIdFromResponse(response),
        phase: "serialization",
      },
    );
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
        "The openTag server returned an invalid response",
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
    return this.#parseResponse(path, schema, body, response);
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
          "The openTag server request timed out",
          undefined,
          undefined,
          { cause, safeCause: cause, phase: "transport", requestId: prepared.requestId },
        );
      }
      const cause = safeCause(error);
      throw new OpenTagApiError(
        "SERVICE_UNAVAILABLE",
        "transient",
        "The openTag server is unavailable",
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
    if (!requestId) throw new Error("openTag response is missing a request ID");
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

export interface SkillUploadInput {
  readonly archive: Uint8Array;
  readonly sha256: string;
  readonly format: SkillArchiveFormat;
  readonly replace?: boolean;
}

function skillUploadHeaders(bytes: number): Record<string, string> {
  return { "content-type": SKILL_UPLOAD_CONTENT_TYPE, "content-length": String(bytes) };
}

function isUnknownExchangeFieldRejection(error: unknown, input: ComputerConnectCodeExchangeRequest): boolean {
  if (input.machineToken === undefined && input.reportOutcome === undefined) return false;
  return (
    error instanceof OpenTagApiError &&
    error.code === "VALIDATION_ERROR" &&
    error.status === 400 &&
    (error.issues ?? []).some((issue) => issue.code === "unrecognized_keys")
  );
}

export function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("The openTag server URL must use HTTP(S) without embedded credentials");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("The openTag server URL must be an origin without a path, query, or fragment");
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !isLoopback) {
    throw new Error("Plain HTTP is allowed only for loopback openTag servers");
  }
  return url.origin;
}
