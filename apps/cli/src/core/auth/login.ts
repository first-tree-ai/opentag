import {
  credentialsPath,
  normalizeServerUrl,
  type OpenTagApi,
  readComputerIdentity,
  resolveOpenTagHome,
  type StoredCredentials,
  writeCredentialsAtomically,
} from "@opentag/client";
import { resolveCommandContext } from "../command/context.js";

/** Reading the Account back is best effort, so a caller may hand in an API that cannot do it. */
type LoginApi = Pick<OpenTagApi, "exchangeConnectCode"> & Partial<Pick<OpenTagApi, "me">>;

export interface LoginOptions {
  api?: LoginApi;
  code: string;
  home?: string;
  now?: () => Date;
  serverUrl: string;
}

export interface LoginResult {
  credentialsPath: string;
  message: string;
}

export async function runLogin(options: LoginOptions): Promise<LoginResult> {
  const home = options.home ?? resolveOpenTagHome();
  const now = options.now ?? (() => new Date());
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const computer = await readComputerIdentity(home);
  if (computer && computer.serverUrl !== serverUrl) {
    throw new Error("This OpenTag home is bound to another server; choose a different OPENTAG_HOME");
  }
  const api = options.api ?? (await resolveCommandContext({ home, serverUrl })).api;
  if (!api) throw new Error("Command context did not resolve an API");
  const response = await api.exchangeConnectCode(options.code);
  const userId = await resolveUserId(api, response.accessToken);
  const credentials: StoredCredentials = {
    accessToken: response.accessToken,
    accessTokenExpiresAt: new Date(now().getTime() + response.expiresIn * 1000).toISOString(),
    refreshToken: response.refreshToken,
    serverUrl,
    ...(userId ? { userId } : {}),
  };
  await writeCredentialsAtomically(credentials, home);
  return {
    credentialsPath: credentialsPath(home),
    message: `Logged in to OpenTag at ${serverUrl}`,
  };
}

/**
 * Which Account these tokens belong to, recorded so a later diagnostic report can name them without
 * a round trip on a path that is already failing.
 *
 * Best effort on purpose: the sign-in has already succeeded by the time this runs, and refusing it
 * over a diagnostic detail would turn a working login into a failed one. An installation that signs
 * in while the Server cannot answer simply reports no Account until it signs in again.
 */
async function resolveUserId(api: LoginApi, accessToken: string): Promise<string | undefined> {
  try {
    return (await api.me?.(accessToken))?.user.id;
  } catch {
    return undefined;
  }
}
