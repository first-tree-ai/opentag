import {
  type AccountComputerConnectCodeIssueRequest,
  type AccountSetupResetMode,
  type AgentAdminConfig,
  AgentAdminConfigSchema,
  type AgentDetail,
  AgentDetailSchema,
  type AgentRuntimeTestRequest,
  type AgentRuntimeTestResponse,
  AgentRuntimeTestResponseSchema,
  type AgentUsageDetail,
  AgentUsageDetailSchema,
  type AgentUsageWindowDays,
  type AuthProvidersResponse,
  AuthProvidersResponseSchema,
  accountComputerConnectCodePath,
  agentByIdPath,
  agentComputerRebindPath,
  agentConfigPath,
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingHandoffPath,
  agentImBindingPath,
  agentReactivatePath,
  agentRuntimeTestPath,
  agentSlackOAuthStartPath,
  agentSuspendPath,
  agentUsagePath,
  type ComputerConnectCodeIssueResponse,
  ComputerConnectCodeIssueResponseSchema,
  type ComputerConnectCodeStatus,
  ComputerConnectCodeStatusSchema,
  type CreateAgentRequest,
  type EmailSignInRequest,
  type EmailSignUpRequest,
  ErrorEnvelopeSchema,
  type FeishuSetupAttempt,
  FeishuSetupAttemptSchema,
  feishuSetupAttemptCancelPath,
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
  PROVIDER_READINESS_V1_HEADER,
  type RebindAgentComputerRequest,
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
    return this.request(HTTP_PATHS.authProviders, AuthProvidersResponseSchema);
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

  testAgentRuntime(
    agentId: string,
    input: AgentRuntimeTestRequest,
    signal?: AbortSignal,
  ): Promise<AgentRuntimeTestResponse> {
    return this.request(agentRuntimeTestPath(agentId), AgentRuntimeTestResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
      ...(signal ? { signal } : {}),
    });
  }

  suspendAgent(agentId: string): Promise<AgentAdminConfig> {
    return this.request(agentSuspendPath(agentId), AgentAdminConfigSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  rebindAgentComputer(agentId: string, computerId: string): Promise<AgentAdminConfig> {
    return this.request(agentComputerRebindPath(agentId), AgentAdminConfigSchema, {
      method: "POST",
      body: JSON.stringify({ computerId } satisfies RebindAgentComputerRequest),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
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

  cancelFeishuSetupAttempt(attemptId: string): Promise<FeishuSetupAttempt> {
    return this.request(feishuSetupAttemptCancelPath(attemptId), FeishuSetupAttemptSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
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

  /**
   * Issues a Computer connect code. Without a target this creates a new Computer; naming one
   * repairs that exact Computer instead, which is what a reinstalled or re-enrolled machine needs —
   * it keeps its identity rather than becoming a second Computer beside the one it replaced.
   */
  issueComputerConnectCode(input?: AccountComputerConnectCodeIssueRequest): Promise<ComputerConnectCodeIssueResponse> {
    return this.request(HTTP_PATHS.accountComputerConnectCodes, ComputerConnectCodeIssueResponseSchema, {
      method: "POST",
      ...(input ? { body: JSON.stringify(input) } : {}),
      headers: { ...(input ? { "content-type": "application/json" } : {}), ...this.csrfHeaders() },
    });
  }

  /**
   * Whether this deployment offers the staging internal tools. Outside staging the interface is
   * absent rather than closed, and everything behind it is open to any authenticated Account where
   * it is present, so reachability is the whole answer.
   */
  async internalToolsOffered(): Promise<boolean> {
    const response = await this.fetchWithRefresh(HTTP_PATHS.accountSetupReset);
    if (response.status === 204) return true;
    if (response.status === 404) return false;
    throw this.apiError(response, await response.json().catch(() => undefined));
  }

  /**
   * Undoes setup for the authenticated staging Account; it accepts no client-selected Account.
   * `all` also destroys that Account's Agents and Computer access, `reboard` keeps them.
   */
  resetAccountSetup(mode: AccountSetupResetMode): Promise<void> {
    return this.requestNoContent(HTTP_PATHS.accountSetupReset, {
      method: "POST",
      body: JSON.stringify({ mode }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  /**
   * The Server's own verdict on a code this Account issued: pending until a machine redeems it,
   * then the exact Computer that did. This — never a Computers-list heuristic — is how a waiting
   * page learns which Computer its command enrolled.
   */
  computerConnectCodeStatus(connectCodeId: string): Promise<ComputerConnectCodeStatus> {
    return this.request(accountComputerConnectCodePath(connectCodeId), ComputerConnectCodeStatusSchema);
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

  /*
   * No CSRF header on either of these: a signed-out browser has no double-submit token, and these are the requests
   * that mint one. The server fences them on the request origin instead.
   */
  async signUpWithPassword(input: EmailSignUpRequest): Promise<void> {
    return this.requestNoContent(HTTP_PATHS.authEmailSignUp, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    });
  }

  async signInWithPassword(input: EmailSignInRequest): Promise<void> {
    return this.requestNoContent(HTTP_PATHS.authEmailSignIn, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    });
  }

  async logout(): Promise<void> {
    return this.requestNoContent("/api/v1/auth/browser/logout", {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  private async request<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchWithRefresh(path, init);
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

  /*
   * A session renews itself as it is used, so there is nothing left to exchange a `401` for: it now means the session
   * is genuinely gone, and the retry this used to make could only ever have failed a second time.
   */
  private fetchWithRefresh(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(path, { ...init, credentials: "same-origin" });
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
