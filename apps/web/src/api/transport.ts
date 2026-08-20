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

export class BrowserTransport {
  constructor(private readonly fetchImpl: typeof fetch) {}

  async request<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit = {}, retry = true): Promise<T> {
    const response = await this.fetchWithRefresh(path, init, retry);
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw this.apiError(response, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(503, "The server returned an invalid response");
    return parsed.data;
  }

  async requestOptional<T>(path: string, schema: RuntimeSchema<T>): Promise<T | undefined> {
    const response = await this.fetchWithRefresh(path);
    if (response.status === 204) return undefined;
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw this.apiError(response, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(503, "The server returned an invalid response");
    return parsed.data;
  }

  async requestNoContent(path: string, init: RequestInit): Promise<void> {
    const response = await this.fetchWithRefresh(path, init);
    if (!response.ok) throw this.apiError(response, await response.json().catch(() => undefined));
  }

  csrfHeaders(): HeadersInit {
    const token = this.csrfToken();
    return token ? { "X-OpenTag-CSRF": token } : {};
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
