import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import type { DatabaseClient } from "../db/client.js";
import { authIdentities, authSessions, authVerifications, users } from "../db/schema/index.js";

/**
 * Mounted under the repository's `/api/v1` versioning convention rather than Better Auth's `/api/auth` default, so the
 * Google callback is `/api/v1/auth/callback/google`.
 */
export const BETTER_AUTH_BASE_PATH = "/api/v1/auth";

export interface BetterAuthConfig {
  /** Origin the browser reaches the server on; also the only trusted origin. */
  publicUrl: string;
  secret: string;
  secureCookies: boolean;
  google?: { clientId: string; clientSecret: string };
}

export type OpenTagBetterAuth = ReturnType<typeof createBetterAuth>;

/**
 * Builds the Better Auth instance over OpenTag's existing tables.
 *
 * The mapping is deliberately in-place rather than a parallel set of tables: `users` keeps its `uuid` primary key and
 * every foreign key that references it, and `auth_identities` keeps the rows that already link Accounts to Google.
 * Google's `providerId`/`issuer`/`accountId` triple is `google` / `https://accounts.google.com` / the OIDC `sub`, which
 * is byte-for-byte what the pre-migration rows already carry, so existing Accounts resolve instead of duplicating.
 */
export function createBetterAuth(database: DatabaseClient, config: BetterAuthConfig) {
  return betterAuth({
    appName: "OpenTag",
    baseURL: config.publicUrl,
    basePath: BETTER_AUTH_BASE_PATH,
    secret: config.secret,
    trustedOrigins: [config.publicUrl],
    database: drizzleAdapter(database, {
      provider: "pg",
      // Keyed by Better Auth's model names so the adapter resolves each table without a separate `modelName` map.
      schema: {
        user: users,
        session: authSessions,
        account: authIdentities,
        verification: authVerifications,
      },
    }),
    advanced: {
      database: {
        // `crypto.randomUUID()` per row, which Postgres accepts into the existing `uuid` columns.
        generateId: "uuid",
      },
      useSecureCookies: config.secureCookies,
    },
    user: { fields: { name: "displayName" } },
    account: {
      fields: { accountId: "subject", providerId: "provider" },
      // Google verifies the address before we ever see it, so a returning Account with a matching email links to the
      // existing user rather than creating a second one.
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({ data: { ...user, email: user.email.trim().toLowerCase() } }),
        },
        update: {
          before: async (user) => ({
            data: typeof user.email === "string" ? { ...user, email: user.email.trim().toLowerCase() } : user,
          }),
        },
      },
    },
    ...(config.google
      ? {
          socialProviders: {
            google: { clientId: config.google.clientId, clientSecret: config.google.clientSecret },
          },
        }
      : {}),
    // The CLI authenticates with `Authorization: Bearer <session token>`; the browser keeps using cookies.
    plugins: [bearer()],
  });
}
