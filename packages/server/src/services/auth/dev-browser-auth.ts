import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { AuthServiceError } from "./errors.js";

/**
 * Resolves an explicitly configured existing user without creating identity or owned resources.
 *
 * It answers only *who* development sign-in is for. Minting the credential belongs to Better Auth, so a development
 * session is the same revocable thing every other sign-in produces.
 */
export class DevBrowserAuthService {
  readonly #database: DatabaseClient;
  readonly #email: string;

  constructor(database: DatabaseClient, email: string) {
    this.#database = database;
    this.#email = email;
  }

  async resolveUserId(): Promise<string> {
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
    return matches[0].id;
  }
}
