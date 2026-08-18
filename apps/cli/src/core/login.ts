import {
  AuthApi,
  credentialsPath,
  normalizeServerUrl,
  resolveOpenTagHome,
  type StoredCredentials,
  writeCredentialsAtomically,
} from "@opentag/client";

export interface LoginOptions {
  authApi?: Pick<AuthApi, "exchangeConnectCode">;
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
  const authApi = options.authApi ?? new AuthApi(serverUrl);
  const response = await authApi.exchangeConnectCode(options.code);
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
