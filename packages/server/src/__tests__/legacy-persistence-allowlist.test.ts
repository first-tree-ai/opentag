import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

const LEGACY_PATTERN =
  /\b(workspaceComputers|workspaceComputerCredentials|workspaceAdminGrants|WorkspaceAdminAccess|WorkspaceAdminService|issueForWorkspaceAdmin|establishDefaultWorkspaceForNewAccount|MachineEnrollmentCredential|storeMachineEnrollmentCredential)\b|\b(?:agents|sessionPlacements|sessionCliProofs|slackInstallations|computerConnectCodes)\.(?:workspaceId|workspaceComputerId)\b|\.(?:from|insert|update|delete)\(workspaces\)|\.enrollments\b|\benrollments\s*:|["'`]\/api\/v1\/workspaces(?:\/|["'`])/;

const PRODUCT_ALLOWLIST = new Set(["packages/server/src/db/schema-required-legacy.ts"]);
const SCHEMA_DECLARATION_PREFIX = "packages/server/src/db/schema/";

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") return [];
        return walk(path);
      }
      return extname(entry.name) === ".ts" ? [path] : [];
    }),
  );
  return files.flat();
}

describe("legacy persistence allowlist", () => {
  it("keeps management Workspace persistence out of active product code", async () => {
    const roots = [
      resolve(repoRoot, "packages/server/src"),
      resolve(repoRoot, "packages/client/src"),
      resolve(repoRoot, "packages/shared/src"),
      resolve(repoRoot, "apps/cli/src"),
      resolve(repoRoot, "apps/web/src"),
    ];
    const files = (await Promise.all(roots.map(walk))).flat();
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(repoRoot, file);
      if (rel.startsWith(SCHEMA_DECLARATION_PREFIX) || PRODUCT_ALLOWLIST.has(rel)) continue;
      const source = await readFile(file, "utf8");
      if (LEGACY_PATTERN.test(source)) hits.push(rel);
    }
    expect(hits).toEqual([]);
    expect([...PRODUCT_ALLOWLIST]).toEqual(["packages/server/src/db/schema-required-legacy.ts"]);
  });
});
