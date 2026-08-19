import { fileURLToPath } from "node:url";
import { defaultAdminWebRoot } from "./admin-web.js";
import { createApp } from "./app.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { parseServerConfig } from "./config.js";
import { createDatabaseClient } from "./db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "./db/migrate.js";
import { AgentService } from "./services/agents/index.js";
import {
  AuthIdentityService,
  AuthService,
  AuthTokenService,
  DefaultGoogleIdentityClient,
  formatStartupError,
  GoogleBrowserAuthService,
  OAuthFlowService,
  PostAuthenticationService,
} from "./services/auth/index.js";
import { ComputerService } from "./services/computers/index.js";
import { ApplicationCipher } from "./services/crypto.js";
import { InvitationService } from "./services/invitations/index.js";
import { TeamMembershipService } from "./services/teams/index.js";

export { bootstrapInitialAdmin } from "./admin/bootstrap.js";
export { createApp } from "./app.js";
export { BootstrapReadiness } from "./bootstrap-readiness.js";
export { type DatabaseConfig, parseDatabaseConfig, parseServerConfig, type ServerConfig } from "./config.js";
export { createDatabaseClient, type DatabaseClient } from "./db/client.js";
export {
  MigrationVerificationError,
  migrateDatabase,
  verifyDatabaseMigrations,
  withMigrationLock,
} from "./db/migrate.js";
export {
  ConnectionRegistry,
  type RuntimeConnectionEntry,
  RuntimeRegistrySendError,
} from "./runtime/connection-registry.js";
export {
  type AcceptedDeliveryRecord,
  type RecordedTurnRecord,
  RuntimeDomainConflictError,
  RuntimeDomainOwner,
  type RuntimeDomainOwnerOptions,
  RuntimeDomainRequestError,
} from "./runtime/runtime-domain-owner.js";
export { AgentService, AgentServiceError } from "./services/agents/index.js";
export { AuthService, AuthServiceError, AuthTokenService } from "./services/auth/index.js";
export { ComputerService } from "./services/computers/index.js";

export async function startServer(): Promise<void> {
  const readiness = new BootstrapReadiness();
  let app: ReturnType<typeof createApp> | undefined;
  const knownSecrets: string[] = [];

  try {
    knownSecrets.push(
      process.env.OPENTAG_DATABASE_URL ?? "",
      process.env.OPENTAG_JWT_SECRET ?? "",
      process.env.OPENTAG_GOOGLE_CLIENT_SECRET ?? "",
      process.env.OPENTAG_ENCRYPTION_KEY ?? "",
    );
    const config = parseServerConfig(process.env);
    readiness.complete("configuration");
    if (config.autoMigrate) {
      await migrateDatabase(config.databaseUrl, config.migrationsDirectory);
    } else {
      await verifyDatabaseMigrations(config.databaseUrl, config.migrationsDirectory);
    }
    readiness.complete("migration");

    const { database, sql } = createDatabaseClient(config.databaseUrl);
    const authService = new AuthService(
      database,
      new AuthTokenService(config.jwtSecret, config.accessTokenTtlSeconds, config.refreshTokenTtlSeconds),
    );
    const computerService = new ComputerService(database, authService);
    const teamService = new TeamMembershipService(database);
    const agentService = new AgentService(database, { membershipService: teamService });
    const invitationService = new InvitationService(
      database,
      teamService,
      new ApplicationCipher(config.encryptionKey),
      config.publicUrl,
    );
    const identityService = new AuthIdentityService(database);
    const postAuthentication = new PostAuthenticationService(database, invitationService, {
      membershipService: teamService,
    });
    const google = config.google
      ? new GoogleBrowserAuthService({
          database,
          flow: new OAuthFlowService(config.jwtSecret),
          google: new DefaultGoogleIdentityClient(config.google.clientId, config.google.clientSecret),
          identities: identityService,
          postAuthentication,
          publicUrl: config.publicUrl,
          tokenIssuer: authService,
        })
      : undefined;
    app = createApp({
      adminWebRoot: defaultAdminWebRoot,
      agentService,
      authService,
      browserAuth: {
        google,
        publicOrigin: config.publicUrl,
        refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
        secureCookies: config.environment === "production",
      },
      computerService,
      invitationService,
      readiness,
      teamService,
    });
    app.addHook("onClose", async () => sql.end());
    readiness.complete("application");
    await app.listen({ host: config.host, port: config.port });
    readiness.complete("listen");
  } catch (error) {
    if (app) {
      app.log.error({ detail: formatStartupError(error, knownSecrets) }, "Failed to start OpenTag server");
      await app.close();
    } else {
      process.stderr.write(`Failed to start OpenTag server: ${formatStartupError(error, knownSecrets)}\n`);
    }
    process.exitCode = 1;
  }
}

const isProcessEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isProcessEntry) {
  await startServer();
}
