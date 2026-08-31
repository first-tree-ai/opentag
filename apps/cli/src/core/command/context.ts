import * as client from "@opentag/client";
import { resolveChannelEnvironment } from "../channel/environment.js";

type CommandContextAuthOptions = { accessToken?: string; api?: client.OpenTagApi; requireAuth?: boolean };
type CommandContextLocationOptions = { environment?: NodeJS.ProcessEnv; home?: string; serverUrl?: string };
export type CommandContextOptions = CommandContextAuthOptions & CommandContextLocationOptions;
type CommandContextIdentityAccess = { readonly accessToken?: string; readonly api?: client.OpenTagApi };
type CommandContextIdentity = CommandContextIdentityAccess & { readonly credentials?: client.StoredCredentials };
type CommandContextLocation = { readonly environment: NodeJS.ProcessEnv; readonly home: string };
export type CommandContext = CommandContextIdentity & CommandContextLocation;

/** Resolve home, credentials, token, and API from one detached command context. */
export async function resolveCommandContext(options: CommandContextOptions = {}): Promise<CommandContext> {
  const environment = resolveChannelEnvironment(options.environment ?? process.env);
  const home = options.home ?? client.resolveOpenTagHome(environment);
  if (options.serverUrl) return { api: new client.OpenTagApi(options.serverUrl), environment, home };
  if (!options.requireAuth && !options.api && !options.accessToken) {
    return { environment, home };
  }
  if (options.api && options.accessToken) {
    return { accessToken: options.accessToken, api: options.api, environment, home };
  }
  if (options.api || options.accessToken) {
    throw new Error("Command context test dependencies must provide both api and accessToken");
  }
  const credentials = await client.readCredentials(home);
  if (!credentials) throw new Error("OpenTag is not logged in; run login first");
  const accessToken = await new client.AccessTokenProvider({ home }).getAccessToken();
  return { accessToken, api: new client.OpenTagApi(credentials.serverUrl), credentials, environment, home };
}
