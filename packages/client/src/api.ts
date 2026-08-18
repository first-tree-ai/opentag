import {
  type ConnectCodeExchangeResponse,
  ConnectCodeExchangeResponseSchema,
  type ErrorCategory,
  type ErrorCode,
  ErrorEnvelopeSchema,
  HTTP_PATHS,
  type ListComputersResponse,
  ListComputersResponseSchema,
  type MeResponse,
  MeResponseSchema,
  type RefreshTokenResponse,
  RefreshTokenResponseSchema,
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

  async #request<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), init);
    } catch {
      throw new OpenTagApiError("SERVICE_UNAVAILABLE", "transient", "The OpenTag server is unavailable");
    }
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = ErrorEnvelopeSchema.safeParse(body);
      if (parsed.success) {
        throw new OpenTagApiError(
          parsed.data.error.code,
          parsed.data.error.category,
          parsed.data.error.message,
          response.status,
        );
      }
      if (response.status === 429) {
        throw new OpenTagApiError("RATE_LIMITED", "rate_limit", "The OpenTag server rate limit was reached", 429);
      }
      if (response.status >= 500) {
        throw new OpenTagApiError(
          "SERVICE_UNAVAILABLE",
          "transient",
          "The OpenTag server is unavailable",
          response.status,
        );
      }
      throw new OpenTagApiError("AUTH_INVALID_TOKEN", "credential", "Authentication failed", response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new OpenTagApiError("SERVICE_UNAVAILABLE", "transient", "The OpenTag server returned an invalid response");
    }
    return parsed.data;
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
