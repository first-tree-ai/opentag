import type { BootstrapAdminInput, BootstrapAdminResult } from "../admin/bootstrap.js";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import type { DatabaseClient } from "../db/client.js";

/** Test-only Account bootstrap: production Account creation with no Workspace-era persistence. */
export async function bootstrapTestAccount(
  database: DatabaseClient,
  input: BootstrapAdminInput,
  now = new Date(),
): Promise<BootstrapAdminResult> {
  return bootstrapInitialAdmin(database, input, now);
}
