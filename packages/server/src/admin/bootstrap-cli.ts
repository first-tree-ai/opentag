import { parseDatabaseConfig } from "../config.js";
import { createDatabaseClient } from "../db/client.js";
import { migrateDatabase } from "../db/migrate.js";
import { BootstrapAdminInputSchema, bootstrapInitialAdmin } from "./bootstrap.js";

const config = parseDatabaseConfig(process.env);
await migrateDatabase(config.databaseUrl, config.migrationsDirectory);
const { database, sql } = createDatabaseClient(config.databaseUrl);

try {
  const input = BootstrapAdminInputSchema.parse({
    displayName: process.env.OPENTAG_BOOTSTRAP_DISPLAY_NAME,
    email: process.env.OPENTAG_BOOTSTRAP_EMAIL,
    workspaceDisplayName: process.env.OPENTAG_BOOTSTRAP_WORKSPACE_DISPLAY_NAME,
    workspaceName: process.env.OPENTAG_BOOTSTRAP_WORKSPACE_NAME,
  });
  const result = await bootstrapInitialAdmin(database, input);
  process.stdout.write(`${JSON.stringify({ ...result, expiresAt: result.expiresAt.toISOString() })}\n`);
} finally {
  await sql.end();
}
