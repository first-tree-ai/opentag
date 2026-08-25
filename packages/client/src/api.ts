import {
  type AgentAdminConfig,
  AgentAdminConfigSchema,
  type AgentDetail,
  AgentDetailSchema,
  type AgentUsageDetail,
  AgentUsageDetailSchema,
  type AgentUsageWindowDays,
  agentByIdPath,
  agentConfigPath,
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingPath,
  agentReactivatePath,
  agentSuspendPath,
  agentUsagePath,
  type ComputerConnectCodeExchangeRequest,
  type ComputerConnectCodeExchangeResponse,
  ComputerConnectCodeExchangeResponseSchema,
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
  type ListComputersResponse,
  ListComputersResponseSchema,
  type ListTeamComputersConfigResponse,
  ListTeamComputersConfigResponseSchema,
  type ListTeamComputersResponse,
  ListTeamComputersResponseSchema,
  type ListTeamMembersConfigResponse,
  ListTeamMembersConfigResponseSchema,
  type ListTeamMembersResponse,
  ListTeamMembersResponseSchema,
  type MeResponse,
  MeResponseSchema,
  PROVIDER_READINESS_V1_HEADER,
  type RefreshTokenResponse,
  RefreshTokenResponseSchema,
  type RestoreTeamMemberRequest,
  runtimeImResourcePath,
  type TeamInvitation,
  TeamInvitationSchema,
  type TeamMemberAdminConfig,
  TeamMemberAdminConfigSchema,
  type TeamProfile,
  TeamProfileSchema,
  teamAgentsPath,
  teamByIdPath,
  teamComputersConfigPath,
  teamComputersPath,
  teamInvitationPath,
  teamInvitationRotatePath,
  teamLeavePath,
  teamMemberPath,
  teamMemberRemovePath,
  teamMemberRestorePath,
  teamMembersConfigPath,
  teamMembersPath,
  type UpdateAgentRequest,
  type UpdateTeamMemberRequest,
  type UpdateTeamProfileRequest,
  type ValidationIssue,
} from "@opentag/shared";

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class OpenTagApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly category: ErrorCategory,
    message: string,
    readonly status?: number,
    readonly issues?: readonly ValidationIssue[],
  ) {
    super(message);
    this.name = "OpenTagApiError";
  }
}

export class OpenTagApi {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;

  constructor(serverUrl: string, fetchImpl: typeof fetch = fetch) {
    this.#baseUrl = new URL(normalizeServerUrl(serverUrl));
    this.#fetch = fetchImpl;
  }

  exchangeConnectCode(code: string, expectedUserId?: string): Promise<ConnectCodeExchangeResponse> {
    return this.#request(HTTP_PATHS.authConnectExchange, ConnectCodeExchangeResponseSchema, {
      method: "POST",
      body: JSON.stringify({ code, ...(expectedUserId ? { expectedUserId } : {}) }),
      headers: { "content-type": "application/json" },
    });
  }

  exchangeComputerConnectCode(input: ComputerConnectCodeExchangeRequest): Promise<ComputerConnectCodeExchangeResponse> {
    return this.#request(HTTP_PATHS.computerConnectExchange, ComputerConnectCodeExchangeResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    });
  }

  refresh(refreshToken: string): Promise<RefreshTokenResponse> {
    return this.#request(HTTP_PATHS.authRefresh, RefreshTokenResponseSchema, {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
      headers: { "content-type": "application/json" },
    });
  }

  me(accessToken: string): Promise<MeResponse> {
    return this.#request(HTTP_PATHS.me, MeResponseSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  updateTeam(accessToken: string, teamId: string, input: UpdateTeamProfileRequest): Promise<TeamProfile> {
    return this.#request(teamByIdPath(teamId), TeamProfileSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    });
  }

  listComputers(accessToken: string): Promise<ListComputersResponse> {
    return this.#request(HTTP_PATHS.meComputers, ListComputersResponseSchema, {
      headers: { authorization: `Bearer ${accessToken}`, [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
  }

  listTeamMembers(accessToken: string, teamId: string): Promise<ListTeamMembersResponse> {
    return this.#request(teamMembersPath(teamId), ListTeamMembersResponseSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  listTeamMembersConfig(accessToken: string, teamId: string): Promise<ListTeamMembersConfigResponse> {
    return this.#request(teamMembersConfigPath(teamId), ListTeamMembersConfigResponseSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  updateTeamMember(
    accessToken: string,
    teamId: string,
    userId: string,
    input: UpdateTeamMemberRequest,
  ): Promise<TeamMemberAdminConfig> {
    return this.#request(teamMemberPath(teamId, userId), TeamMemberAdminConfigSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    });
  }

  removeTeamMember(accessToken: string, teamId: string, userId: string): Promise<void> {
    return this.#requestNoContent(teamMemberRemovePath(teamId, userId), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  restoreTeamMember(
    accessToken: string,
    teamId: string,
    userId: string,
    input: RestoreTeamMemberRequest,
  ): Promise<TeamMemberAdminConfig> {
    return this.#request(teamMemberRestorePath(teamId, userId), TeamMemberAdminConfigSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    });
  }

  leaveTeam(accessToken: string, teamId: string): Promise<void> {
    return this.#requestNoContent(teamLeavePath(teamId), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  getTeamInvitation(accessToken: string, teamId: string): Promise<TeamInvitation | undefined> {
    return this.#requestOptional(teamInvitationPath(teamId), TeamInvitationSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  createTeamInvitation(accessToken: string, teamId: string): Promise<TeamInvitation> {
    return this.#request(teamInvitationPath(teamId), TeamInvitationSchema, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  rotateTeamInvitation(accessToken: string, teamId: string): Promise<TeamInvitation> {
    return this.#request(teamInvitationRotatePath(teamId), TeamInvitationSchema, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  listTeamComputers(accessToken: string, teamId: string): Promise<ListTeamComputersResponse> {
    return this.#request(teamComputersPath(teamId), ListTeamComputersResponseSchema, {
      headers: { authorization: `Bearer ${accessToken}`, [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
  }

  listTeamComputersConfig(accessToken: string, teamId: string): Promise<ListTeamComputersConfigResponse> {
    return this.#request(teamComputersConfigPath(teamId), ListTeamComputersConfigResponseSchema, {
      headers: { authorization: `Bearer ${accessToken}`, [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
  }

  createAgent(accessToken: string, teamId: string, input: CreateAgentRequest): Promise<AgentAdminConfig> {
    return this.#request(teamAgentsPath(teamId), AgentAdminConfigSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    });
  }

  listAgents(accessToken: string, teamId: string): Promise<ListAgentsResponse> {
    return this.#request(teamAgentsPath(teamId), ListAgentsResponseSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  getAgent(accessToken: string, agentId: string): Promise<AgentDetail> {
    return this.#request(agentByIdPath(agentId), AgentDetailSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  getAgentUsage(accessToken: string, agentId: string, windowDays: AgentUsageWindowDays): Promise<AgentUsageDetail> {
    return this.#request(agentUsagePath(agentId, windowDays), AgentUsageDetailSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  getAgentConfig(accessToken: string, agentId: string): Promise<AgentAdminConfig> {
    return this.#request(agentConfigPath(agentId), AgentAdminConfigSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  updateAgent(accessToken: string, agentId: string, input: UpdateAgentRequest): Promise<AgentAdminConfig> {
    return this.#request(agentByIdPath(agentId), AgentAdminConfigSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    });
  }

  suspendAgent(accessToken: string, agentId: string): Promise<AgentAdminConfig> {
    return this.#request(agentSuspendPath(agentId), AgentAdminConfigSchema, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  reactivateAgent(accessToken: string, agentId: string): Promise<AgentAdminConfig> {
    return this.#request(agentReactivatePath(agentId), AgentAdminConfigSchema, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  deleteAgent(accessToken: string, agentId: string): Promise<void> {
    return this.#requestNoContent(agentByIdPath(agentId), {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  getAgentImBinding(accessToken: string, agentId: string): Promise<ImBindingSummary | undefined> {
    return this.#requestOptional(agentImBindingPath(agentId), ImBindingSummarySchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  getAgentImBindingConfig(accessToken: string, agentId: string): Promise<ImBindingAdminDetail | undefined> {
    return this.#requestOptional(agentImBindingConfigPath(agentId), ImBindingAdminDetailSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  createFeishuSetupAttempt(
    accessToken: string,
    agentId: string,
    intent: "create" | "reauthorize" | "replace" = "create",
  ): Promise<FeishuSetupAttempt> {
    return this.#request(agentFeishuSetupAttemptsPath(agentId), FeishuSetupAttemptSchema, {
      method: "POST",
      body: JSON.stringify({ intent }),
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    });
  }

  getFeishuSetupAttempt(accessToken: string, attemptId: string): Promise<FeishuSetupAttempt> {
    return this.#request(feishuSetupAttemptPath(attemptId), FeishuSetupAttemptSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  cancelFeishuSetupAttempt(accessToken: string, attemptId: string): Promise<FeishuSetupAttempt> {
    return this.#request(`${feishuSetupAttemptPath(attemptId)}/cancel`, FeishuSetupAttemptSchema, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  getImBindingDiagnostics(accessToken: string, imBindingId: string): Promise<ImBindingDiagnostics> {
    return this.#request(imBindingDiagnosticsPath(imBindingId), ImBindingDiagnosticsSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  disableImBinding(accessToken: string, imBindingId: string): Promise<void> {
    return this.#requestNoContent(imBindingDisablePath(imBindingId), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  async openImResource(
    machineToken: string,
    imMessageId: string,
    ordinal: number,
    scope: { sessionId: string; instanceId: string; placementGeneration: number },
  ): Promise<Response> {
    const response = await this.#fetchResponse(runtimeImResourcePath(imMessageId, ordinal, scope), {
      headers: { authorization: `Bearer ${machineToken}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      this.#throwResponseError(response.status, body);
    }
    return response;
  }

  async #request<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit): Promise<T> {
    const response = await this.#fetchResponse(path, init);
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      this.#throwResponseError(response.status, body);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new OpenTagApiError("SERVICE_UNAVAILABLE", "transient", "The OpenTag server returned an invalid response");
    }
    return parsed.data;
  }

  async #requestNoContent(path: string, init: RequestInit): Promise<void> {
    const response = await this.#fetchResponse(path, init);
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      this.#throwResponseError(response.status, body);
    }
    if (response.status !== 204) {
      throw new OpenTagApiError("SERVICE_UNAVAILABLE", "transient", "The OpenTag server returned an invalid response");
    }
  }

  async #requestOptional<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit): Promise<T | undefined> {
    const response = await this.#fetchResponse(path, init);
    if (response.status === 204) return undefined;
    const body = await response.json().catch(() => undefined);
    if (!response.ok) this.#throwResponseError(response.status, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new OpenTagApiError("SERVICE_UNAVAILABLE", "transient", "The OpenTag server returned an invalid response");
    }
    return parsed.data;
  }

  async #fetchResponse(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(new URL(path, this.#baseUrl), init);
    } catch {
      throw new OpenTagApiError("SERVICE_UNAVAILABLE", "transient", "The OpenTag server is unavailable");
    }
  }

  #throwResponseError(status: number, body: unknown): never {
    const parsed = ErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) {
      throw new OpenTagApiError(
        parsed.data.error.code,
        parsed.data.error.category,
        parsed.data.error.message,
        status,
        parsed.data.error.issues,
      );
    }
    if (status === 429) {
      throw new OpenTagApiError("RATE_LIMITED", "rate_limit", "The OpenTag server rate limit was reached", 429);
    }
    if (status >= 500) {
      throw new OpenTagApiError("SERVICE_UNAVAILABLE", "transient", "The OpenTag server is unavailable", status);
    }
    throw new OpenTagApiError("AUTH_INVALID_TOKEN", "credential", "Authentication failed", status);
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
