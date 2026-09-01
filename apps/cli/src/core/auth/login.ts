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

export interface LoginOptions {
  api?: Pick<OpenTagApi, "exchangeConnectCode">;
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
  const credentials: StoredCredentials = {
    accessToken: response.accessToken,
    accessTokenExpiresAt: new Date(now().getTime() + response.expiresIn * 1000).toISOString(),
    refreshToken: response.refreshToken,
    serverUrl,
  };
  await writeCredentialsAtomically(credentials, home);
  return {
    credentialsPath: credentialsPath(home),
    message: `Logged in to OpenTag at ${serverUrl}`,
  };
}
