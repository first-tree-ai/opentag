import type { DaemonServiceInfo } from "../daemon/service/index.js";
import { createDaemonServiceManager, type DaemonServiceManager } from "../daemon/service/index.js";
import { type LoginOptions, type LoginResult, runLogin } from "./login.js";

export interface LoginWithServiceOptions extends LoginOptions {
  login?: (options: LoginOptions) => Promise<LoginResult>;
  manager?: DaemonServiceManager;
  noStart?: boolean;
}

export interface LoginWithServiceResult extends LoginResult {
  service?: DaemonServiceInfo;
}

export class LoginServiceInstallError extends Error {
  override readonly name = "LoginServiceInstallError";

  constructor(
    readonly loginResult: LoginResult,
    options?: ErrorOptions,
  ) {
    super("Login succeeded, but the daemon service could not be installed", options);
  }
}

export async function runLoginWithService(options: LoginWithServiceOptions): Promise<LoginWithServiceResult> {
  const login = options.login ?? runLogin;
  if (options.noStart) return login(options);

  const manager = options.manager ?? (await createDaemonServiceManager({ home: options.home }));
  await manager.preflight();
  const loginResult = await login(options);
  try {
    const service = await manager.installAndStart();
    return { ...loginResult, service };
  } catch (error) {
    throw new LoginServiceInstallError(loginResult, { cause: error });
  }
}
