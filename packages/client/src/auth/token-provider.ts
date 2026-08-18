import { AuthApi } from "./api.js";
import {
  readCredentials,
  resolveOpenTagHome,
  type StoredCredentials,
  writeCredentialsAtomically,
} from "./credentials.js";

export interface TokenProviderOptions {
  authApi?: Pick<AuthApi, "refresh">;
  home?: string;
  now?: () => Date;
  refreshSkewSeconds?: number;
}

export class AccessTokenProvider {
  readonly #home: string;
  readonly #now: () => Date;
  readonly #refreshSkewMilliseconds: number;
  readonly #authApi?: Pick<AuthApi, "refresh">;
  #refreshInFlight?: Promise<string>;

  constructor(options: TokenProviderOptions = {}) {
    this.#home = options.home ?? resolveOpenTagHome();
    this.#now = options.now ?? (() => new Date());
    this.#refreshSkewMilliseconds = (options.refreshSkewSeconds ?? 60) * 1000;
    this.#authApi = options.authApi;
  }

  async getAccessToken(): Promise<string> {
    const credentials = await readCredentials(this.#home);
    if (!credentials) {
      throw new Error("OpenTag is not logged in");
    }
    if (Date.parse(credentials.accessTokenExpiresAt) - this.#now().getTime() > this.#refreshSkewMilliseconds) {
      return credentials.accessToken;
    }

    this.#refreshInFlight ??= this.#refresh(credentials).finally(() => {
      this.#refreshInFlight = undefined;
    });
    return this.#refreshInFlight;
  }

  async #refresh(credentials: StoredCredentials): Promise<string> {
    const response = await (this.#authApi ?? new AuthApi(credentials.serverUrl)).refresh(credentials.refreshToken);
    const next: StoredCredentials = {
      accessToken: response.accessToken,
      accessTokenExpiresAt: new Date(this.#now().getTime() + response.expiresIn * 1000).toISOString(),
      refreshToken: response.refreshToken,
      serverUrl: credentials.serverUrl,
    };
    await writeCredentialsAtomically(next, this.#home);
    return next.accessToken;
  }
}
