import type { RefreshTokenResponse } from "@opentag/shared";
import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { AuthServiceError } from "./errors.js";

export interface DevBrowserTokenIssuer {
  issueTokensForUser(userId: string): Promise<RefreshTokenResponse>;
}

/** Resolves an explicitly configured existing user without creating identity or Team records. */
export class DevBrowserAuthService {
  readonly #database: DatabaseClient;
  readonly #email: string;
  readonly #tokenIssuer: DevBrowserTokenIssuer;

  constructor(database: DatabaseClient, tokenIssuer: DevBrowserTokenIssuer, email: string) {
    this.#database = database;
    this.#tokenIssuer = tokenIssuer;
    this.#email = email;
  }

  async signIn(): Promise<RefreshTokenResponse> {
    const matches = await this.#database
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${this.#email})`)
      .limit(2);
    if (matches.length !== 1 || !matches[0]) {
      throw new AuthServiceError(
        "AUTH_DEV_USER_UNAVAILABLE",
        "deterministic",
        "The configured development sign-in user is unavailable or ambiguous",
        503,
      );
    }
    return this.#tokenIssuer.issueTokensForUser(matches[0].id);
  }
}
