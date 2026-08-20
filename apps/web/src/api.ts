import {
  type AgentAdminConfig,
  AgentAdminConfigSchema,
  type AgentDetail,
  AgentDetailSchema,
  type AuthProvidersResponse,
  AuthProvidersResponseSchema,
  agentByIdPath,
  agentConfigPath,
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingPath,
  type ConnectCodeIssueResponse,
  ConnectCodeIssueResponseSchema,
  type CreateAgentRequest,
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
  type InvitationPreview,
  InvitationPreviewSchema,
  type InvitationRedemptionResponse,
  InvitationRedemptionResponseSchema,
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  invitationPreviewPath,
  invitationRedeemPath,
  type ListAgentsResponse,
  ListAgentsResponseSchema,
  type ListComputersResponse,
  ListComputersResponseSchema,
  type ListTeamComputersResponse,
  ListTeamComputersResponseSchema,
  type ListTeamMembersResponse,
  ListTeamMembersResponseSchema,
  type MeResponse,
  MeResponseSchema,
  type TeamInvitation,
  TeamInvitationSchema,
  type TeamProfile,
  TeamProfileSchema,
  teamAgentsPath,
  teamByIdPath,
  teamComputersPath,
  teamInvitationPath,
  teamInvitationRotatePath,
  teamMembersPath,
  type UpdateAgentRequest,
  type UpdateTeamProfileRequest,
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

  authProviders(): Promise<AuthProvidersResponse> {
    return this.request(HTTP_PATHS.authProviders, AuthProvidersResponseSchema, undefined, false);
  }

  members(teamId: string): Promise<ListTeamMembersResponse> {
    return this.request(teamMembersPath(teamId), ListTeamMembersResponseSchema);
  }

  updateTeam(teamId: string, input: UpdateTeamProfileRequest): Promise<TeamProfile> {
    return this.request(teamByIdPath(teamId), TeamProfileSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  agents(teamId: string): Promise<ListAgentsResponse> {
    return this.request(teamAgentsPath(teamId), ListAgentsResponseSchema);
  }

  agent(agentId: string): Promise<AgentDetail> {
    return this.request(agentByIdPath(agentId), AgentDetailSchema);
  }

  agentConfig(agentId: string): Promise<AgentAdminConfig> {
    return this.request(agentConfigPath(agentId), AgentAdminConfigSchema);
  }

  createAgent(teamId: string, input: CreateAgentRequest): Promise<AgentAdminConfig> {
    return this.request(teamAgentsPath(teamId), AgentAdminConfigSchema, {
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

  imBinding(agentId: string): Promise<ImBindingSummary | undefined> {
    return this.requestOptional(agentImBindingPath(agentId), ImBindingSummarySchema);
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

  imBindingDiagnostics(imBindingId: string): Promise<ImBindingDiagnostics> {
    return this.request(imBindingDiagnosticsPath(imBindingId), ImBindingDiagnosticsSchema);
  }

  disableImBinding(imBindingId: string): Promise<void> {
    return this.requestNoContent(imBindingDisablePath(imBindingId), {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  computers(teamId: string): Promise<ListTeamComputersResponse> {
    return this.request(teamComputersPath(teamId), ListTeamComputersResponseSchema);
  }

  ownComputers(): Promise<ListComputersResponse> {
    return this.request(HTTP_PATHS.meComputers, ListComputersResponseSchema);
  }

  issueConnectCode(teamId: string): Promise<ConnectCodeIssueResponse> {
    return this.request(HTTP_PATHS.meConnectCodes, ConnectCodeIssueResponseSchema, {
      method: "POST",
      body: JSON.stringify({ teamId }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  invitation(teamId: string): Promise<TeamInvitation | undefined> {
    return this.requestOptional(teamInvitationPath(teamId), TeamInvitationSchema);
  }

  createInvitation(teamId: string): Promise<TeamInvitation> {
    return this.request(teamInvitationPath(teamId), TeamInvitationSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  rotateInvitation(teamId: string): Promise<TeamInvitation> {
    return this.request(teamInvitationRotatePath(teamId), TeamInvitationSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  invitationPreview(token: string): Promise<InvitationPreview> {
    return this.request(invitationPreviewPath(token), InvitationPreviewSchema, undefined, false);
  }

  redeemInvitation(token: string): Promise<InvitationRedemptionResponse> {
    return this.request(invitationRedeemPath(token), InvitationRedemptionResponseSchema, {
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
    const envelope =
      typeof body === "object" && body !== null && "error" in body
        ? (body as { error?: { category?: unknown; code?: unknown; message?: unknown } }).error
        : undefined;
    return new ApiError(
      response.status,
      typeof envelope?.message === "string" ? envelope.message : "Request failed",
      typeof envelope?.code === "string" ? envelope.code : undefined,
      typeof envelope?.category === "string" ? envelope.category : undefined,
    );
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
