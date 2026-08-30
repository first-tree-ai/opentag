import type { BootstrapAdminInput, BootstrapAdminResult } from "../admin/bootstrap.js";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import type { DatabaseClient } from "../db/client.js";
import { ensureSchemaWorkspaceId } from "../db/schema-required-legacy.js";

type LegacyBootstrapLabels = {
  workspaceDisplayName?: string;
  workspaceName?: string;
};

/**
 * Test-only historical-schema fixture. Product bootstrap creates only the Account; tests that still
 * exercise pre-contract tables obtain a schema-only Workspace through the one PR5 compatibility seam.
 */
export async function bootstrapTestAccount(
  database: DatabaseClient,
  input: BootstrapAdminInput & LegacyBootstrapLabels,
  now = new Date(),
): Promise<BootstrapAdminResult & { workspaceId: string }> {
  const { workspaceDisplayName: _workspaceDisplayName, workspaceName: _workspaceName, ...accountInput } = input;
  const bootstrap = await bootstrapInitialAdmin(database, accountInput, now);
  const workspaceId = await database.transaction((transaction) =>
    ensureSchemaWorkspaceId(transaction, bootstrap.userId, now),
  );
  return { ...bootstrap, workspaceId };
}
