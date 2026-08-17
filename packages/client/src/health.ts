import { type ServerHealth, ServerHealthSchema } from "@opentag/shared";

export class ServerHealthConfigurationError extends Error {
  override readonly name = "ServerHealthConfigurationError";
}

export class ServerHealthNetworkError extends Error {
  override readonly name = "ServerHealthNetworkError";
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

export async function checkServerHealth(serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<ServerHealth> {
  let healthUrl: URL;
  try {
    healthUrl = new URL("/healthz", serverUrl);
  } catch (error) {
    throw new ServerHealthConfigurationError(`Invalid OpenTag server URL: ${serverUrl}`, { cause: error });
  }

  let response: Response;
  try {
    response = await fetchImpl(healthUrl);
  } catch (error) {
    throw new ServerHealthNetworkError("Could not reach the OpenTag server", { cause: error });
  }

  if (!response.ok) {
    throw new ServerHealthHttpError(response.status);
  }

  try {
    return ServerHealthSchema.parse(await response.json());
  } catch (error) {
    throw new ServerHealthResponseError("OpenTag server returned an invalid health response", { cause: error });
  }
}
