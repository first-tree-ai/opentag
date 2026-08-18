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
    tenantDisplayName: process.env.OPENTAG_BOOTSTRAP_TENANT_NAME,
    tenantSlug: process.env.OPENTAG_BOOTSTRAP_TENANT_SLUG,
  });
  const result = await bootstrapInitialAdmin(database, input);
  process.stdout.write(`${JSON.stringify({ ...result, expiresAt: result.expiresAt.toISOString() })}\n`);
} finally {
  await sql.end();
}
