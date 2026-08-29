import { type ServerHealth, ServerHealthSchema } from "@opentag/shared";

export class ServerHealthConfigurationError extends Error {
  override readonly name = "ServerHealthConfigurationError";
}

export class ServerHealthNetworkError extends Error {
  override readonly name = "ServerHealthNetworkError";
}

export class ServerHealthTimeoutError extends Error {
  override readonly name = "ServerHealthTimeoutError";
}

export class ServerHealthHttpError extends Error {
  override readonly name = "ServerHealthHttpError";

  constructor(readonly status: number) {
    super(`OpenTag server health check returned HTTP ${status}`);
  }
}

export class ServerHealthResponseError extends Error {
  override readonly name = "ServerHealthResponseError";
}

export const SERVER_HEALTH_TIMEOUT_MS = 5_000;

export async function checkServerHealth(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = SERVER_HEALTH_TIMEOUT_MS,
): Promise<ServerHealth> {
  let healthUrl: URL;
  try {
    healthUrl = new URL("/healthz", serverUrl);
  } catch (error) {
    throw new ServerHealthConfigurationError(`Invalid OpenTag server URL: ${serverUrl}`, { cause: error });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(healthUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new ServerHealthHttpError(response.status);
    }
    try {
      return ServerHealthSchema.parse(await response.json());
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ServerHealthTimeoutError(`OpenTag server health check timed out after ${timeoutMs}ms`, {
          cause: error,
        });
      }
      throw new ServerHealthResponseError("OpenTag server returned an invalid health response", { cause: error });
    }
  } catch (error) {
    if (error instanceof ServerHealthHttpError || error instanceof ServerHealthResponseError) throw error;
    if (error instanceof ServerHealthTimeoutError) throw error;
    if (controller.signal.aborted) {
      throw new ServerHealthTimeoutError(`OpenTag server health check timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw new ServerHealthNetworkError("Could not reach the OpenTag server", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}
