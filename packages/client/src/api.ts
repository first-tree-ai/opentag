import {
  type Agent,
  AgentSchema,
  agentByIdPath,
  type ConnectCodeExchangeResponse,
  ConnectCodeExchangeResponseSchema,
  type CreateAgentRequest,
  type ErrorCategory,
  type ErrorCode,
  ErrorEnvelopeSchema,
  HTTP_PATHS,
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
  type RefreshTokenResponse,
  RefreshTokenResponseSchema,
  type RestoreTeamMemberRequest,
  type TeamInvitation,
  TeamInvitationSchema,
  type TeamMember,
  TeamMemberSchema,
  teamAgentsPath,
  teamComputersPath,
  teamInvitationPath,
  teamInvitationRotatePath,
  teamLeavePath,
  teamMemberPath,
  teamMemberRemovePath,
  teamMemberRestorePath,
  teamMembersPath,
  type UpdateAgentRequest,
  type UpdateTeamMemberRequest,
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

  listComputers(accessToken: string): Promise<ListComputersResponse> {
    return this.#request(HTTP_PATHS.meComputers, ListComputersResponseSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  listTeamMembers(accessToken: string, teamId: string): Promise<ListTeamMembersResponse> {
    return this.#request(teamMembersPath(teamId), ListTeamMembersResponseSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  updateTeamMember(
    accessToken: string,
    teamId: string,
    userId: string,
    input: UpdateTeamMemberRequest,
  ): Promise<TeamMember> {
    return this.#request(teamMemberPath(teamId, userId), TeamMemberSchema, {
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
  ): Promise<TeamMember> {
    return this.#request(teamMemberRestorePath(teamId, userId), TeamMemberSchema, {
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

  getTeamInvitation(accessToken: string, teamId: string): Promise<TeamInvitation> {
    return this.#request(teamInvitationPath(teamId), TeamInvitationSchema, {
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
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  createAgent(accessToken: string, teamId: string, input: CreateAgentRequest): Promise<Agent> {
    return this.#request(teamAgentsPath(teamId), AgentSchema, {
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

  getAgent(accessToken: string, agentId: string): Promise<Agent> {
    return this.#request(agentByIdPath(agentId), AgentSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  updateAgent(accessToken: string, agentId: string, input: UpdateAgentRequest): Promise<Agent> {
    return this.#request(agentByIdPath(agentId), AgentSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    });
  }

  deleteAgent(accessToken: string, agentId: string): Promise<void> {
    return this.#requestNoContent(agentByIdPath(agentId), {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });
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
      throw new OpenTagApiError(parsed.data.error.code, parsed.data.error.category, parsed.data.error.message, status);
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
