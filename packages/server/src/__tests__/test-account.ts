import type { BootstrapAdminInput, BootstrapAdminResult } from "../admin/bootstrap.js";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import type { DatabaseClient } from "../db/client.js";

/** Test-only Account bootstrap using the production Account-creation path. */
export async function bootstrapTestAccount(
  database: DatabaseClient,
  input: BootstrapAdminInput,
  now = new Date(),
): Promise<BootstrapAdminResult> {
  return bootstrapInitialAdmin(database, input, now);
}
