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
  agentSlackOAuthStartPath,
  agentSuspendPath,
  agentUsagePath,
  type ComputerConnectCodeIssueResponse,
  ComputerConnectCodeIssueResponseSchema,
  type ConfigureSlackAppRequest,
  type CreateAgentRequest,
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
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  type ListAgentsResponse,
  ListAgentsResponseSchema,
  type ListTasksResponse,
  ListTasksResponseSchema,
  type ListWorkspaceComputersResponse,
  ListWorkspaceComputersResponseSchema,
  type MeResponse,
  MeResponseSchema,
  type OnboardingLabAccess,
  OnboardingLabAccessSchema,
  PROVIDER_READINESS_V1_HEADER,
  type SlackAppConfiguration,
  SlackAppConfigurationSchema,
  type SlackConfigurationResult,
  SlackConfigurationResultSchema,
  type StartSlackOAuthRequest,
  type StartSlackOAuthResponse,
  StartSlackOAuthResponseSchema,
  type TaskDetail,
  TaskDetailSchema,
  taskByIdPath,
  type UpdateAgentRequest,
  type UpdateUserProfileRequest,
  type UserProfile,
  UserProfileSchema,
  type ValidationIssue,
  type WorkspaceSetupCompletion,
  WorkspaceSetupCompletionSchema,
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
  private refreshInFlight?: Promise<Response>;

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

  completeSetup(agentId: string): Promise<WorkspaceSetupCompletion> {
    return this.request(HTTP_PATHS.accountSetupComplete, WorkspaceSetupCompletionSchema, {
      method: "POST",
      body: JSON.stringify({ agentId }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  agents(): Promise<ListAgentsResponse> {
    return this.request(HTTP_PATHS.accountAgents, ListAgentsResponseSchema);
  }

  tasks(input: { cursor?: string; agentId?: string; kind?: "channel" | "thread" } = {}): Promise<ListTasksResponse> {
    const query = new URLSearchParams();
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.agentId) query.set("agentId", input.agentId);
    if (input.kind) query.set("kind", input.kind);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request(`${HTTP_PATHS.accountTasks}${suffix}`, ListTasksResponseSchema);
  }

  task(sessionId: string, cursor?: string): Promise<TaskDetail> {
    const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : "";
    return this.request(`${taskByIdPath(sessionId)}${query}`, TaskDetailSchema);
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

  createAgent(input: CreateAgentRequest): Promise<AgentAdminConfig> {
    return this.request(HTTP_PATHS.accountAgents, AgentAdminConfigSchema, {
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

  startSlackOAuth(agentId: string, input: StartSlackOAuthRequest): Promise<StartSlackOAuthResponse> {
    return this.request(agentSlackOAuthStartPath(agentId), StartSlackOAuthResponseSchema, {
      method: "POST",
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

  computers(): Promise<ListWorkspaceComputersResponse> {
    return this.request(HTTP_PATHS.accountComputers, ListWorkspaceComputersResponseSchema, {
      headers: { [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
  }

  issueComputerConnectCode(): Promise<ComputerConnectCodeIssueResponse> {
    return this.request(HTTP_PATHS.accountComputerConnectCodes, ComputerConnectCodeIssueResponseSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  /**
   * Reports what this Account may do in the staging Onboarding Lab, and `undefined` outside staging,
   * where the interface is absent rather than merely closed.
   */
  async onboardingLabAccess(): Promise<OnboardingLabAccess | undefined> {
    const response = await this.fetchWithRefresh(HTTP_PATHS.internalOnboardingLab);
    if (response.status === 404) return undefined;
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw this.apiError(response, body);
    return OnboardingLabAccessSchema.parse(body);
  }

  /** Resets the authenticated staging Lab Account; it accepts no client-selected Account. */
  resetOnboardingLab(): Promise<void> {
    return this.requestNoContent(HTTP_PATHS.internalOnboardingLab, {
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
    const refreshed = await this.refreshOnce();
    if (!refreshed.ok) return response;
    const headers = new Headers(init.headers);
    const csrf = this.csrfToken();
    if (csrf && !["GET", "HEAD", "OPTIONS"].includes(init.method?.toUpperCase() ?? "GET")) {
      headers.set("X-OpenTag-CSRF", csrf);
    }
    return this.fetchWithRefresh(path, { ...init, headers }, false);
  }

  /**
   * Collapses concurrent refreshes into one.
   *
   * Several requests can meet a `401` at once — the page loads more than one resource — and each would otherwise send
   * the same cookie to an endpoint that exchanges it. The server converges those on one session regardless; this keeps
   * the browser from asking it to.
   */
  private refreshOnce(): Promise<Response> {
    this.refreshInFlight ??= this.fetchImpl("/api/v1/auth/browser/refresh", {
      method: "POST",
      credentials: "same-origin",
      headers: this.csrfHeaders(),
    }).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
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
