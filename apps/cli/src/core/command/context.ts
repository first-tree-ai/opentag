import {
  AccessTokenProvider,
  OpenTagApi,
  readCredentials,
  resolveOpenTagHome,
  type StoredCredentials,
} from "@opentag/client";
import { resolveChannelEnvironment } from "../channel/environment.js";

export interface CommandContextOptions {
  accessToken?: string;
  api?: OpenTagApi;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  requireAuth?: boolean;
  serverUrl?: string;
}

export interface CommandContext {
  readonly accessToken?: string;
  readonly api?: OpenTagApi;
  readonly credentials?: StoredCredentials;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
}

/** Resolve home, credentials, token, and API from one detached command context. */
export async function resolveCommandContext(options: CommandContextOptions = {}): Promise<CommandContext> {
  const environment = resolveChannelEnvironment(options.environment ?? process.env);
  const home = options.home ?? resolveOpenTagHome(environment);
  if (options.serverUrl) return { api: new OpenTagApi(options.serverUrl), environment, home };
  if (!options.requireAuth && !options.api && !options.accessToken) {
    return { environment, home };
  }
  if (options.api && options.accessToken) {
    return { accessToken: options.accessToken, api: options.api, environment, home };
  }
  if (options.api || options.accessToken) {
    throw new Error("Command context test dependencies must provide both api and accessToken");
  }
  const credentials = await readCredentials(home);
  if (!credentials) throw new Error("OpenTag is not logged in; run login first");
  const accessToken = await new AccessTokenProvider({ home }).getAccessToken();
  return { accessToken, api: new OpenTagApi(credentials.serverUrl), credentials, environment, home };
}
