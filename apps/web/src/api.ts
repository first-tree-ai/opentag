import {
  type Agent,
  type AuthProvidersResponse,
  AuthProvidersResponseSchema,
  HTTP_PATHS,
  type InvitationPreview,
  InvitationPreviewSchema,
  InvitationRedemptionResponseSchema,
  invitationPreviewPath,
  invitationRedeemPath,
  ListAgentsResponseSchema,
  type ListTeamComputersResponse,
  ListTeamComputersResponseSchema,
  type ListTeamMembersResponse,
  ListTeamMembersResponseSchema,
  type MeResponse,
  MeResponseSchema,
  type TeamInvitation,
  TeamInvitationSchema,
  teamAgentsPath,
  teamComputersPath,
  teamInvitationPath,
  teamMembersPath,
} from "@opentag/shared/browser";

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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

  agents(teamId: string): Promise<{ agents: Agent[] }> {
    return this.request(teamAgentsPath(teamId), ListAgentsResponseSchema);
  }

  computers(teamId: string): Promise<ListTeamComputersResponse> {
    return this.request(teamComputersPath(teamId), ListTeamComputersResponseSchema);
  }

  invitation(teamId: string): Promise<TeamInvitation> {
    return this.request(teamInvitationPath(teamId), TeamInvitationSchema);
  }

  invitationPreview(token: string): Promise<InvitationPreview> {
    return this.request(invitationPreviewPath(token), InvitationPreviewSchema, undefined, false);
  }

  async redeemInvitation(token: string): Promise<void> {
    await this.request(invitationRedeemPath(token), InvitationRedemptionResponseSchema, {
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
    const response = await this.fetchImpl("/api/v1/auth/browser/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: this.csrfHeaders(),
    });
    if (!response.ok) throw new ApiError(response.status, "Logout failed");
  }

  private async request<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit = {}, retry = true): Promise<T> {
    const response = await this.fetchImpl(path, { ...init, credentials: "same-origin" });
    if (response.status === 401 && retry && this.csrfToken()) {
      const refreshed = await this.fetchImpl("/api/v1/auth/browser/refresh", {
        method: "POST",
        credentials: "same-origin",
        headers: this.csrfHeaders(),
      });
      if (refreshed.ok) {
        const headers = new Headers(init.headers);
        const csrf = this.csrfToken();
        if (csrf && !["GET", "HEAD", "OPTIONS"].includes(init.method?.toUpperCase() ?? "GET")) {
          headers.set("X-OpenTag-CSRF", csrf);
        }
        return this.request(path, schema, { ...init, headers }, false);
      }
    }
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error?: { message?: unknown } }).error?.message ?? "Request failed")
          : "Request failed";
      throw new ApiError(response.status, message);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(503, "The server returned an invalid response");
    return parsed.data;
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
