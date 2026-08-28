import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import type { DatabaseClient } from "../db/client.js";
import { authIdentities, authSessions, authVerifications, users } from "../db/schema/index.js";
import { devSignInPlugin, type LegacyUpgradeOptions, legacyUpgradePlugin } from "./internal-sign-in.js";

/**
 * Where the instance will be mounted, under the repository's `/api/v1` versioning convention rather than Better Auth's
 * `/api/auth` default, so the Google callback becomes `/api/v1/auth/callback/google`.
 *
 * Nothing serves this prefix yet. Mounting Better Auth's catch-all publishes its entire endpoint surface — including
 * `/update-user`, a second Account-profile writer that would bypass `UserDisplayNameSchema` and the canonical
 * `/api/v1/me` boundary — so the routes arrive with the stage that needs them and can guard them, not ahead of it.
 */
export const BETTER_AUTH_BASE_PATH = "/api/v1/auth";

export interface BetterAuthConfig {
  /**
   * Runs before any session row exists, and must throw to prevent one.
   *
   * Better Auth owns account creation on its own sign-in paths, so this is where OpenTag decides whether an Account
   * may hold a session at all — which is a question about identity, not authority. A suspended Account is refused, and
   * an Account that has never been provisioned gets its default Workspace before it can sign in.
   *
   * It deliberately does not require an *active* Workspace grant. Revoking every grant removes an Account's authority,
   * not its ability to sign in: it can still authenticate and see that it has no Workspace, and re-provisioning it
   * here would hand the revoked authority straight back. Routes derive authority from grants read live per request.
   */
  onSessionCreating: (userId: string) => Promise<void>;
  /** Origin the browser reaches the server on; also the only trusted origin. */
  publicUrl: string;
  secret: string;
  secureCookies: boolean;
  /**
   * How long an issued session lives, and therefore how long a client may be idle and still be signed in.
   *
   * Left to the library this would default to seven days and quietly shorten what a CLI was promised, so it is
   * required rather than optional: a lifetime this visible should not be something a caller can forget to state.
   */
  sessionTtlSeconds: number;
  /**
   * Resolves the single Account development sign-in may issue a session for.
   *
   * Supplied only when development sign-in is configured, so the endpoint does not exist on a server without it.
   */
  devSignIn?: () => Promise<string>;
  google?: { clientId: string; clientSecret: string };
  /**
   * Verifies a refresh credential the previous revision issued and answers whose it is.
   *
   * Supplied while the compatibility window is open. It must reject anything it cannot verify: it is the only thing
   * standing between the upgrade endpoint and an unauthenticated session.
   */
  legacyUpgrade?: LegacyUpgradeOptions;
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
    /*
     * One credential replaces a pair, so this single lifetime has to carry what the refresh token's did: how long a
     * client may go unused and still be signed in. Inheriting the library's seven days would have shortened that from
     * thirty without anyone choosing it, and left an idle CLI unable to refresh.
     */
    session: { expiresIn: config.sessionTtlSeconds },
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
      account: {
        /*
         * OpenTag never calls a provider on the Account's behalf, so it has no use for these credentials and the
         * pre-migration resolver never persisted them either. Dropping them keeps long-lived provider tokens out of the
         * database entirely, which no encryption-at-rest option can match: Better Auth 1.7.2's `encryptOAuthTokens`
         * covers the access and refresh tokens but writes `idToken` through in the clear.
         */
        create: { before: async (account) => ({ data: withoutProviderCredentials(account) }) },
        update: { before: async (account) => ({ data: withoutProviderCredentials(account) }) },
      },
      session: {
        create: {
          // Throwing here aborts the sign-in that asked for the session, so the caller sees why rather than a
          // session that silently failed to appear.
          before: async (session) => {
            await config.onSessionCreating(session.userId);
          },
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
    plugins: [
      // The CLI authenticates with `Authorization: Bearer <session token>`; the browser keeps using cookies.
      bearer(),
      ...(config.devSignIn ? [devSignInPlugin(config.devSignIn)] : []),
      ...(config.legacyUpgrade ? [legacyUpgradePlugin(config.legacyUpgrade)] : []),
    ],
  });
}

/** Blanks every provider credential Better Auth would otherwise persist on the identity row. */
function withoutProviderCredentials<T extends Record<string, unknown>>(account: T): T {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}
