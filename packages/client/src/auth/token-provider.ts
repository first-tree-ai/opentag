import { constants } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { OpenTagApi } from "../api.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import {
  readCredentials,
  resolveOpenTagHome,
  type StoredCredentials,
  writeCredentialsAtomically,
} from "./credentials.js";

const CREDENTIAL_LOCK_FILE_NAME = ".credentials.lock";
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 5 * 60_000;
const MIN_REFRESH_EXPIRY_SECONDS = 30;

export interface AccessTokenLease {
  accessToken: string;
  expiresAt: string;
}

export interface TokenProviderOptions {
  api?: Pick<OpenTagApi, "refresh">;
  home?: string;
  now?: () => Date;
  refreshSkewSeconds?: number;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
}

export class AccessTokenProvider {
  readonly #home: string;
  readonly #now: () => Date;
  readonly #refreshSkewMilliseconds: number;
  readonly #api?: Pick<OpenTagApi, "refresh">;
  readonly #lockRetryMs: number;
  readonly #lockTimeoutMs: number;
  #refreshInFlight?: Promise<AccessTokenLease>;

  constructor(options: TokenProviderOptions = {}) {
    this.#home = options.home ?? resolveOpenTagHome();
    this.#now = options.now ?? (() => new Date());
    this.#refreshSkewMilliseconds = (options.refreshSkewSeconds ?? 60) * 1000;
    this.#api = options.api;
    this.#lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#lockRetryMs) || this.#lockRetryMs < 1) {
      throw new Error("lockRetryMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#lockTimeoutMs) || this.#lockTimeoutMs < this.#lockRetryMs) {
      throw new Error("lockTimeoutMs must be a safe integer greater than lockRetryMs");
    }
  }

  async getAccessToken(): Promise<string> {
    return (await this.getAccessTokenLease()).accessToken;
  }

  async getAccessTokenLease(forceRefresh = false): Promise<AccessTokenLease> {
    const credentials = await readCredentials(this.#home);
    if (!credentials) {
      throw new Error("OpenTag is not logged in");
    }
    if (
      !forceRefresh &&
      Date.parse(credentials.accessTokenExpiresAt) - this.#now().getTime() > this.#refreshSkewMilliseconds
    ) {
      return { accessToken: credentials.accessToken, expiresAt: credentials.accessTokenExpiresAt };
    }
    this.#refreshInFlight ??= this.#refreshWithLock(credentials, forceRefresh).finally(() => {
      this.#refreshInFlight = undefined;
    });
    return this.#refreshInFlight;
  }

  async #refreshWithLock(credentials: StoredCredentials, forceRefresh: boolean): Promise<AccessTokenLease> {
    return withCredentialLock(this.#home, this.#lockRetryMs, this.#lockTimeoutMs, async () => {
      const latest = await readCredentials(this.#home);
      if (!latest) throw new Error("OpenTag credentials disappeared while refreshing");
      const latestIsFresh =
        Date.parse(latest.accessTokenExpiresAt) - this.#now().getTime() > this.#refreshSkewMilliseconds;
      // A different provider may have completed the rotation while this provider waited for the lock.
      if (latestIsFresh && (!forceRefresh || latest.refreshToken !== credentials.refreshToken)) {
        return { accessToken: latest.accessToken, expiresAt: latest.accessTokenExpiresAt };
      }

      const response = await (this.#api ?? new OpenTagApi(latest.serverUrl)).refresh(latest.refreshToken);
      if (response.expiresIn < MIN_REFRESH_EXPIRY_SECONDS) {
        throw new Error("The OpenTag server returned an unsafe token expiry");
      }
      const expiresAt = new Date(this.#now().getTime() + response.expiresIn * 1000).toISOString();
      await writeCredentialsAtomically(
        {
          accessToken: response.accessToken,
          accessTokenExpiresAt: expiresAt,
          refreshToken: response.refreshToken,
          serverUrl: latest.serverUrl,
        },
        this.#home,
      );
      return { accessToken: response.accessToken, expiresAt };
    });
  }
}

async function withCredentialLock<T>(
  home: string,
  retryMs: number,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = join(resolveOpenTagHomeLayout(home).config, CREDENTIAL_LOCK_FILE_NAME);
  const handle = await acquireCredentialLock(lockPath, retryMs, timeoutMs);
  try {
    return await operation();
  } finally {
    await handle?.close();
    await rm(lockPath, { force: true });
  }
}

async function acquireCredentialLock(
  lockPath: string,
  retryMs: number,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof open>>> {
  const startedAt = Date.now();
  for (;;) {
    const handle = await tryCreateCredentialLock(lockPath);
    if (handle) {
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return handle;
    }
    await removeStaleCredentialLock(lockPath);
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for the OpenTag credential refresh lock");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}

async function tryCreateCredentialLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>> | undefined> {
  try {
    return await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

async function removeStaleCredentialLock(lockPath: string): Promise<void> {
  try {
    const lock = await stat(lockPath);
    if (Date.now() - lock.mtimeMs > STALE_LOCK_MS) await rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
