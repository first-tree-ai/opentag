import { OpenTagApi } from "../api.js";
import {
  readCredentials,
  resolveOpenTagHome,
  type StoredCredentials,
  writeCredentialsAtomically,
} from "./credentials.js";

export interface AccessTokenLease {
  accessToken: string;
  expiresAt: string;
}

export interface TokenProviderOptions {
  api?: Pick<OpenTagApi, "refresh">;
  home?: string;
  now?: () => Date;
  refreshSkewSeconds?: number;
}

export class AccessTokenProvider {
  readonly #home: string;
  readonly #now: () => Date;
  readonly #refreshSkewMilliseconds: number;
  readonly #api?: Pick<OpenTagApi, "refresh">;
  #refreshInFlight?: Promise<AccessTokenLease>;

  constructor(options: TokenProviderOptions = {}) {
    this.#home = options.home ?? resolveOpenTagHome();
    this.#now = options.now ?? (() => new Date());
    this.#refreshSkewMilliseconds = (options.refreshSkewSeconds ?? 60) * 1000;
    this.#api = options.api;
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
    this.#refreshInFlight ??= this.#refresh(credentials).finally(() => {
      this.#refreshInFlight = undefined;
    });
    return this.#refreshInFlight;
  }

  async #refresh(credentials: StoredCredentials): Promise<AccessTokenLease> {
    const response = await (this.#api ?? new OpenTagApi(credentials.serverUrl)).refresh(credentials.refreshToken);
    const expiresAt = new Date(this.#now().getTime() + response.expiresIn * 1000).toISOString();
    await writeCredentialsAtomically(
      {
        accessToken: response.accessToken,
        accessTokenExpiresAt: expiresAt,
        refreshToken: response.refreshToken,
        serverUrl: credentials.serverUrl,
      },
      this.#home,
    );
    return { accessToken: response.accessToken, expiresAt };
  }
}
