import {
  type ClientLogger,
  createLogger,
  credentialsFingerprint,
  credentialsPath,
  normalizeServerUrl,
  type OpenTagApi,
  readComputerIdentity,
  removeAccountIdentity,
  resolveOpenTagHome,
  type StoredCredentials,
  writeAccountIdentityAtomically,
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
  /** Where a best-effort step that did not change the outcome is noted. */
  logger?: Pick<ClientLogger, "warn">;
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
  };
  await writeCredentialsAtomically(credentials, home);
  await recordAccountIdentity(home, credentials, userId, options.logger ?? createLogger("login"));
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

/**
 * Record the Account beside the credentials, in its own file, or forget the one that was there.
 *
 * Beside rather than inside: `credentials.json` is read strictly by every CLI already installed,
 * and a key an older reader does not know would break the documented rollback. Best effort on
 * purpose, for the same reason `resolveUserId` is: the credentials are already written, and a
 * diagnostic detail must not turn a working login into a failed one. A sign-in that could not name
 * its Account removes any identity a previous sign-in left, so a report never names an Account the
 * current tokens may not belong to. The identity carries a fingerprint of the credentials it is
 * written beside, so a later sign-in by an older CLI — which rewrites only the credentials — leaves
 * a file the report path can tell is no longer about the tokens it holds.
 */
async function recordAccountIdentity(
  home: string,
  credentials: StoredCredentials,
  userId: string | undefined,
  logger: Pick<ClientLogger, "warn">,
): Promise<void> {
  try {
    if (userId) {
      await writeAccountIdentityAtomically(
        { userId, serverUrl: credentials.serverUrl, credentialsFingerprint: credentialsFingerprint(credentials) },
        home,
      );
    } else await removeAccountIdentity(home);
  } catch (error) {
    logger.warn(
      { code: "account_identity_write_failed", reason: error instanceof Error ? error.message : String(error) },
      "Signed in, but the Account could not be recorded for diagnostics",
    );
  }
}
