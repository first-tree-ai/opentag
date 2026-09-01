import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

/**
 * Retired ownership persistence and connection compatibility are fully removed. Nothing in active
 * product code or documentation may name the retired tables, columns, services, scope resolvers,
 * response aliases, or product terminology. Immutable SQL migrations live outside the scanned roots;
 * only these exact TypeScript files are historical migration-upgrade fixtures.
 */
const EXPLICIT_MIGRATION_FIXTURES = new Set([
  "packages/server/src/__tests__/integration/account-ownership-backfill.test.ts",
  "packages/server/src/__tests__/integration/account-ownership-expansion.test.ts",
  "packages/server/src/__tests__/integration/auth-migrations.test.ts",
  "packages/server/src/__tests__/integration/setup-completion-backfill.test.ts",
  "packages/server/src/__tests__/integration/workspace-ownership-contract-migration.test.ts",
]);
const SCANNER_PATH = "packages/server/src/__tests__/legacy-persistence-allowlist.test.ts";
const LEGACY_PATTERNS = [
  /\b(workspaceComputers|workspaceComputerCredentials|workspaceAdminGrants|WorkspaceAdminAccess|WorkspaceAdminService|MachineEnrollmentCredential|storeMachineEnrollmentCredential|MachineEnrollmentInput|MachineEnrollmentResult|issueForWorkspaceAdmin|establishDefaultWorkspaceForNewAccount|SchemaRequiredLegacyError|schemaRequiredAgentProjection|schemaRequiredComputerProjection|schemaRequiredConnectCodeProjection|schemaRequiredSlackInstallationProjection|ensureSchemaWorkspaceId|schemaWorkspaceIdForComputer|insertSchemaWorkspaceComputer|lockSchemaWorkspaceComputer|updateSchemaWorkspaceComputerInstallationForRepair|WorkspaceSetupService|WorkspaceSetupServiceError|WORKSPACE_SETUP_AGENT_NOT_FOUND|WORKSPACE_SETUP_NOT_READY|ListWorkspaceComputersResponse|WorkspaceComputerSummary|CompleteWorkspaceSetupRequest|WorkspaceSetupCompletion|MeWorkspace|WorkspaceNameInputSchema|WorkspaceDisplayNameSchema|enrolledAt|enrolledByUserId)\b/,
  /\b(workspace_computers|workspace_computer_credentials|workspace_admin_grants|admin_invitations|account_computers|workspace_computer_id|consumed_workspace_computer_id|enrolled_by_user_id)\b/,
  /\b(?:enrollment|enrollments|enroll|enrolled|enrolling)\b/i,
  /\bOpenTag workspaces?\b/i,
  /\bworkspace installation\b/i,
  /\b(?:agents|sessionPlacements|sessionCliProofs|slackInstallations|computerConnectCodes)\.(?:workspaceId|workspaceComputerId)\b/,
  /\.(?:from|insert|update|delete)\(workspaces\)/,
  /["'`]\/api\/v1\/workspaces(?:\/|["'`])/,
];

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") return [];
        return walk(path);
      }
      return [".json", ".md", ".mjs", ".ts", ".tsx", ".yaml", ".yml"].includes(extname(entry.name)) ? [path] : [];
    }),
  );
  return files.flat();
}

describe("retired ownership persistence allowlist", () => {
  it("keeps retired persistence and terminology in exact migration fixtures only", async () => {
    const roots = [
      resolve(repoRoot, "packages/server/src"),
      resolve(repoRoot, "packages/client/src"),
      resolve(repoRoot, "packages/shared/src"),
      resolve(repoRoot, "apps/cli/src"),
      resolve(repoRoot, "apps/web/src"),
      resolve(repoRoot, "apps/web/messages"),
      resolve(repoRoot, "docs"),
      resolve(repoRoot, "e2e"),
      resolve(repoRoot, "scripts"),
      resolve(repoRoot, ".github/workflows"),
    ];
    const files = [
      ...(await Promise.all(roots.map(walk))).flat(),
      resolve(repoRoot, "README.md"),
      resolve(repoRoot, "README.zh-CN.md"),
      resolve(repoRoot, "DEVELOPMENT.md"),
      resolve(repoRoot, "DEVELOPMENT.zh-CN.md"),
    ];
    const hits: string[] = [];
    for (const file of files) {
      const path = relative(repoRoot, file);
      if (path === SCANNER_PATH || EXPLICIT_MIGRATION_FIXTURES.has(path)) continue;
      const source = await readFile(file, "utf8");
      if (LEGACY_PATTERNS.some((pattern) => pattern.test(source))) hits.push(path);
    }
    expect(hits).toEqual([]);
  });
});
