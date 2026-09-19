import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSkillManifest } from "@opentag/shared";
import { vi } from "vitest";
import type { ClientLogger } from "../../observability/logger.js";
import type { PackedSkillDirectory } from "../../skills/skill-archive.js";
import { packSkillDirectory } from "../../skills/skill-archive.js";
import { SkillSyncManager } from "../../skills/skill-sync.js";

/**
 * Shared fixtures for the Skill sync suites. Temp roots and loopback servers are registered here
 * and torn down by `cleanupSkillSyncHarness`, so split test files share one cleanup path.
 */

export interface LogRecord {
  readonly level: "debug" | "info" | "warn";
  readonly fields: Record<string, unknown>;
}

export function recordingLogger(records: LogRecord[]): ClientLogger {
  const logger: ClientLogger = {
    child: () => logger,
    debug: (fields) => records.push({ level: "debug", fields }),
    info: (fields) => records.push({ level: "info", fields }),
    warn: (fields) => records.push({ level: "warn", fields }),
    error: (fields) => records.push({ level: "warn", fields }),
  };
  return logger;
}

const roots: string[] = [];
const servers: Array<Server> = [];

export function registerServer(server: Server): void {
  servers.push(server);
}

export async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentag-skill-sync-"));
  roots.push(root);
  return root;
}

export async function cleanupSkillSyncHarness(): Promise<void> {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function buildSkill(root: string, name: string, body = "# Body\n"): Promise<PackedSkillDirectory> {
  const directory = join(root, `source-${name}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} description`, "---", "", body].join("\n"),
  );
  return packSkillDirectory(directory);
}

export function manifestEntry(packed: PackedSkillDirectory, name: string): RuntimeSkillManifest["skills"][number] {
  return {
    id: randomUUID(),
    name,
    archiveSha256: packed.sha256,
    archiveBytes: packed.archive.byteLength,
  };
}

export function fakeApi(
  manifests: RuntimeSkillManifest[],
  bundles: Map<string, Uint8Array>,
  overrides: { manifestError?: unknown; bundleError?: unknown } = {},
): {
  api: {
    getComputerSkillManifest: ReturnType<typeof vi.fn>;
    openComputerSkillBundle: ReturnType<typeof vi.fn>;
  };
  downloads: string[];
} {
  const downloads: string[] = [];
  let call = 0;
  const api = {
    getComputerSkillManifest: vi.fn(async () => {
      if (overrides.manifestError) throw overrides.manifestError;
      const value = manifests[Math.min(call, manifests.length - 1)];
      call += 1;
      return value ?? { skills: [] };
    }),
    openComputerSkillBundle: vi.fn(async (_token: string, _agentId: string, skillId: string) => {
      if (overrides.bundleError) throw overrides.bundleError;
      const bytes = bundles.get(skillId);
      if (!bytes) return new Response("missing", { status: 404 });
      downloads.push(skillId);
      return new Response(bytes, { status: 200 });
    }),
  };
  return { api, downloads };
}

export function managerFor(
  api: ReturnType<typeof fakeApi>["api"],
  records: LogRecord[],
  now: () => number = () => 1_700_000_000_000,
): SkillSyncManager {
  return new SkillSyncManager({
    api: api as never,
    machineToken: async () => "machine-token",
    logger: recordingLogger(records),
    now,
  });
}
