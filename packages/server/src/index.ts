import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { parseServerConfig } from "./config.js";
import { createDatabaseClient } from "./db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "./db/migrate.js";
import { AuthService, AuthTokenService, formatStartupError } from "./services/auth/index.js";
import { ComputerService } from "./services/computers/index.js";

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
export { AuthService, AuthServiceError, AuthTokenService } from "./services/auth/index.js";
export { ComputerService } from "./services/computers/index.js";

export async function startServer(): Promise<void> {
  const readiness = new BootstrapReadiness();
  let app: ReturnType<typeof createApp> | undefined;
  const knownSecrets: string[] = [];

  try {
    const config = parseServerConfig(process.env);
    knownSecrets.push(config.jwtSecret);
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
    app = createApp({ authService, computerService, readiness });
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
