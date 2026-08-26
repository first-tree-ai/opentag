import {
  type AgentAdminConfig,
  AgentAdminConfigSchema,
  type AgentDetail,
  AgentDetailSchema,
  type AgentUsageDetail,
  AgentUsageDetailSchema,
  type AgentUsageWindowDays,
  type AuthProvidersResponse,
  AuthProvidersResponseSchema,
  agentByIdPath,
  agentConfigPath,
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingHandoffPath,
  agentImBindingPath,
  agentReactivatePath,
  agentSlackConfigurationPath,
  agentSuspendPath,
  agentUsagePath,
  type ComputerConnectCodeIssueResponse,
  ComputerConnectCodeIssueResponseSchema,
  type ConfigureSlackAppRequest,
  type CreateAgentRequest,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResponse,
  CreateWorkspaceResponseSchema,
  ErrorEnvelopeSchema,
  type FeishuSetupAttempt,
  FeishuSetupAttemptSchema,
  feishuSetupAttemptPath,
  HTTP_PATHS,
  type ImBindingAdminDetail,
  ImBindingAdminDetailSchema,
  type ImBindingDiagnostics,
  ImBindingDiagnosticsSchema,
  type ImBindingHandoffStatus,
  ImBindingHandoffStatusSchema,
  type ImBindingSummary,
  ImBindingSummarySchema,
  type InvitationAcceptanceResponse,
  InvitationAcceptanceResponseSchema,
  type InvitationPreview,
  InvitationPreviewSchema,
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  invitationAcceptPath,
  invitationPreviewPath,
  type ListAgentsResponse,
  ListAgentsResponseSchema,
  type ListWorkspaceAdminsResponse,
  ListWorkspaceAdminsResponseSchema,
  type ListWorkspaceComputersResponse,
  ListWorkspaceComputersResponseSchema,
  type MeResponse,
  MeResponseSchema,
  PROVIDER_READINESS_V1_HEADER,
  type SlackAppConfiguration,
  SlackAppConfigurationSchema,
  type SlackConfigurationResult,
  SlackConfigurationResultSchema,
  type UpdateAgentRequest,
  type UpdateUserProfileRequest,
  type UpdateWorkspaceProfileRequest,
  type UserProfile,
  UserProfileSchema,
  type ValidationIssue,
  type WorkspaceProfile,
  WorkspaceProfileSchema,
  type WorkspaceSetupCompletion,
  WorkspaceSetupCompletionSchema,
  workspaceAdminPath,
  workspaceAdminsPath,
  workspaceAgentsPath,
  workspaceByIdPath,
  workspaceComputerConnectCodesPath,
  workspaceComputersPath,
  workspaceSetupCompletePath,
} from "@opentag/shared/browser";

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly category?: string,
    readonly issues?: readonly ValidationIssue[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class BrowserApi {
  constructor(readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  me(): Promise<MeResponse> {
    return this.request("/api/v1/me", MeResponseSchema);
  }

  updateProfile(input: UpdateUserProfileRequest): Promise<UserProfile> {
    return this.request(HTTP_PATHS.me, UserProfileSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  authProviders(): Promise<AuthProvidersResponse> {
    return this.request(HTTP_PATHS.authProviders, AuthProvidersResponseSchema, undefined, false);
  }

  admins(workspaceId: string): Promise<ListWorkspaceAdminsResponse> {
    return this.request(workspaceAdminsPath(workspaceId), ListWorkspaceAdminsResponseSchema);
  }

  createWorkspace(input: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
    return this.request(HTTP_PATHS.workspaces, CreateWorkspaceResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  revokeWorkspaceAdmin(workspaceId: string, accountId: string): Promise<void> {
    return this.requestNoContent(workspaceAdminPath(workspaceId, accountId), {
      method: "DELETE",
      headers: this.csrfHeaders(),
    });
  }

  updateWorkspace(workspaceId: string, input: UpdateWorkspaceProfileRequest): Promise<WorkspaceProfile> {
    return this.request(workspaceByIdPath(workspaceId), WorkspaceProfileSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  completeWorkspaceSetup(workspaceId: string, agentId: string): Promise<WorkspaceSetupCompletion> {
    return this.request(workspaceSetupCompletePath(workspaceId), WorkspaceSetupCompletionSchema, {
      method: "POST",
      body: JSON.stringify({ agentId }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  agents(workspaceId: string): Promise<ListAgentsResponse> {
    return this.request(workspaceAgentsPath(workspaceId), ListAgentsResponseSchema);
  }

  agent(agentId: string): Promise<AgentDetail> {
    return this.request(agentByIdPath(agentId), AgentDetailSchema);
  }

  agentUsage(agentId: string, windowDays: AgentUsageWindowDays): Promise<AgentUsageDetail> {
    return this.request(agentUsagePath(agentId, windowDays), AgentUsageDetailSchema);
  }

  agentConfig(agentId: string): Promise<AgentAdminConfig> {
    return this.request(agentConfigPath(agentId), AgentAdminConfigSchema);
  }

  createAgent(workspaceId: string, input: CreateAgentRequest): Promise<AgentAdminConfig> {
    return this.request(workspaceAgentsPath(workspaceId), AgentAdminConfigSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  updateAgent(agentId: string, input: UpdateAgentRequest): Promise<AgentAdminConfig> {
    return this.request(agentByIdPath(agentId), AgentAdminConfigSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  suspendAgent(agentId: string): Promise<AgentAdminConfig> {
    return this.request(agentSuspendPath(agentId), AgentAdminConfigSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  reactivateAgent(agentId: string): Promise<AgentAdminConfig> {
    return this.request(agentReactivatePath(agentId), AgentAdminConfigSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  deleteAgent(agentId: string): Promise<void> {
    return this.requestNoContent(agentByIdPath(agentId), {
      method: "DELETE",
      headers: this.csrfHeaders(),
    });
  }

  imBinding(agentId: string): Promise<ImBindingSummary | undefined> {
    return this.requestOptional(agentImBindingPath(agentId), ImBindingSummarySchema);
  }

  imBindingHandoff(agentId: string): Promise<ImBindingHandoffStatus | undefined> {
    return this.requestOptional(agentImBindingHandoffPath(agentId), ImBindingHandoffStatusSchema);
  }

  imBindingConfig(agentId: string): Promise<ImBindingAdminDetail | undefined> {
    return this.requestOptional(agentImBindingConfigPath(agentId), ImBindingAdminDetailSchema);
  }

  createFeishuSetupAttempt(
    agentId: string,
    intent: "create" | "reauthorize" | "replace" = "create",
  ): Promise<FeishuSetupAttempt> {
    return this.request(agentFeishuSetupAttemptsPath(agentId), FeishuSetupAttemptSchema, {
      method: "POST",
      body: JSON.stringify({ intent }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  feishuSetupAttempt(attemptId: string): Promise<FeishuSetupAttempt> {
    return this.request(feishuSetupAttemptPath(attemptId), FeishuSetupAttemptSchema);
  }

  slackAppConfiguration(agentId: string): Promise<SlackAppConfiguration> {
    return this.request(agentSlackConfigurationPath(agentId), SlackAppConfigurationSchema);
  }

  configureSlackApp(agentId: string, input: ConfigureSlackAppRequest): Promise<SlackConfigurationResult> {
    return this.request(agentSlackConfigurationPath(agentId), SlackConfigurationResultSchema, {
      method: "PUT",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  imBindingDiagnostics(imBindingId: string): Promise<ImBindingDiagnostics> {
    return this.request(imBindingDiagnosticsPath(imBindingId), ImBindingDiagnosticsSchema);
  }

  disableImBinding(imBindingId: string): Promise<void> {
    return this.requestNoContent(imBindingDisablePath(imBindingId), {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  computers(workspaceId: string): Promise<ListWorkspaceComputersResponse> {
    return this.request(workspaceComputersPath(workspaceId), ListWorkspaceComputersResponseSchema, {
      headers: { [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
  }

  issueComputerConnectCode(workspaceId: string): Promise<ComputerConnectCodeIssueResponse> {
    return this.request(workspaceComputerConnectCodesPath(workspaceId), ComputerConnectCodeIssueResponseSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  invitationPreview(token: string): Promise<InvitationPreview> {
    return this.request(invitationPreviewPath(token), InvitationPreviewSchema, undefined, false);
  }

  acceptAdminInvitation(token: string): Promise<InvitationAcceptanceResponse> {
    return this.request(invitationAcceptPath(token), InvitationAcceptanceResponseSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  async health(path: "/healthz" | "/readyz"): Promise<{ latencyMs: number; observedAt: string; status: string }> {
    const startedAt = performance.now();
    const response = await this.fetchImpl(path, { credentials: "same-origin" });
    const body = (await response.json().catch(() => undefined)) as { status?: unknown } | undefined;
    if (!response.ok || typeof body?.status !== "string") throw new ApiError(response.status, "Health check failed");
    return {
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      observedAt: new Date().toISOString(),
      status: body.status,
    };
  }

  async logout(): Promise<void> {
    return this.requestNoContent("/api/v1/auth/browser/logout", {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  private async request<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit = {}, retry = true): Promise<T> {
    const response = await this.fetchWithRefresh(path, init, retry);
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw this.apiError(response, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(503, "The server returned an invalid response");
    return parsed.data;
  }

  private async requestOptional<T>(path: string, schema: RuntimeSchema<T>): Promise<T | undefined> {
    const response = await this.fetchWithRefresh(path);
    if (response.status === 204) return undefined;
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw this.apiError(response, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(503, "The server returned an invalid response");
    return parsed.data;
  }

  private async requestNoContent(path: string, init: RequestInit): Promise<void> {
    const response = await this.fetchWithRefresh(path, init);
    if (!response.ok) throw this.apiError(response, await response.json().catch(() => undefined));
  }

  private async fetchWithRefresh(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const response = await this.fetchImpl(path, { ...init, credentials: "same-origin" });
    if (response.status !== 401 || !retry || !this.csrfToken()) return response;
    const refreshed = await this.fetchImpl("/api/v1/auth/browser/refresh", {
      method: "POST",
      credentials: "same-origin",
      headers: this.csrfHeaders(),
    });
    if (!refreshed.ok) return response;
    const headers = new Headers(init.headers);
    const csrf = this.csrfToken();
    if (csrf && !["GET", "HEAD", "OPTIONS"].includes(init.method?.toUpperCase() ?? "GET")) {
      headers.set("X-OpenTag-CSRF", csrf);
    }
    return this.fetchWithRefresh(path, { ...init, headers }, false);
  }

  private apiError(response: Response, body: unknown): ApiError {
    const parsed = ErrorEnvelopeSchema.safeParse(body);
    if (!parsed.success) return new ApiError(response.status, "Request failed");
    const { error } = parsed.data;
    return new ApiError(response.status, error.message, error.code, error.category, error.issues);
  }

  private csrfHeaders(): HeadersInit {
    const token = this.csrfToken();
    return token ? { "X-OpenTag-CSRF": token } : {};
  }

  private csrfToken(): string | undefined {
    const row = document.cookie.split(";").find((part) => part.trim().startsWith("opentag_csrf="));
    if (!row) return undefined;
    try {
      return decodeURIComponent(row.slice(row.indexOf("=") + 1));
    } catch {
      return undefined;
    }
  }
}

export const browserApi = new BrowserApi();
