import {
  checkServerHealth,
  ServerHealthConfigurationError,
  ServerHealthHttpError,
  ServerHealthNetworkError,
  ServerHealthResponseError,
} from "@opentag/client";
import type { ServerHealth } from "@opentag/shared";
import { channelConfig } from "../channel/config.js";

export type HealthChecker = (serverUrl: string) => Promise<ServerHealth>;

export interface DoctorOptions {
  serverUrl?: string;
  env?: NodeJS.ProcessEnv;
  healthChecker?: HealthChecker;
}

export interface DoctorResult {
  exitCode: 0 | 1;
  message: string;
}

export function resolveServerUrl(serverUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const resolved = serverUrl ?? env.OPENTAG_SERVER_URL ?? channelConfig.defaultServerUrl;
  if (!resolved) throw new ServerHealthConfigurationError(`The ${channelConfig.channel} channel requires a server URL`);
  return resolved;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  let serverUrl: string;
  try {
    serverUrl = resolveServerUrl(options.serverUrl, options.env);
  } catch (error) {
    return { exitCode: 1, message: formatDoctorError(error, "<not configured>") };
  }
  const healthChecker = options.healthChecker ?? checkServerHealth;

  try {
    const health = await healthChecker(serverUrl);
    return {
      exitCode: 0,
      message: `OpenTag server is healthy (${health.service}) at ${serverUrl}`,
    };
  } catch (error) {
    return {
      exitCode: 1,
      message: formatDoctorError(error, serverUrl),
    };
  }
}

function formatDoctorError(error: unknown, serverUrl: string): string {
  if (error instanceof ServerHealthConfigurationError) {
    return `Configuration error: invalid OpenTag server URL ${serverUrl}`;
  }
  if (error instanceof ServerHealthNetworkError) {
    return `Network error: could not reach the OpenTag server at ${serverUrl}`;
  }
  if (error instanceof ServerHealthHttpError) {
    return `HTTP error: the OpenTag server at ${serverUrl} returned status ${error.status}`;
  }
  if (error instanceof ServerHealthResponseError) {
    return `Response error: the OpenTag server at ${serverUrl} returned an invalid health response`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Unexpected error while checking ${serverUrl}: ${detail}`;
}
