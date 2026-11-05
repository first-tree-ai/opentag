import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { projectConfigSchema, SCHEMA_VERSION } from "@first-tree-ai/context-tree/contracts";
import type { ContextTreeConnection } from "@opentag/shared";
import { ensurePrivateDirectory, writeDurableFile } from "../storage/durable-file.js";

/**
 * Runtime facts shared by Local preparation, Cloud preparation, and managed prompts.
 *
 * Preparation never syncs, so these facts carry no snapshot path or commit: they change only
 * when the selection, the workspace, or local availability changes, which keeps the managed
 * prompt stable across Turns. Agents obtain read snapshots themselves through `context-tree sync`.
 */
export type ContextTreeStatus =
  | { status: "configured"; connections: readonly ContextTreeResult[] }
  | { status: "unconfigured" }
  | { status: "unavailable"; reason: string };

/** One selected source: available for Agent-run sync and writes at `projectPath`, or unavailable. */
export type ContextTreeResult = ContextTreeConnection &
  ({ status: "available"; projectPath: string } | { status: "unavailable"; reason: string });

/** This configuration belongs to the host, never to a checked-out repository. */
export async function configureContextTrees(
  workspace: string,
  wanted: readonly ContextTreeConnection[],
): Promise<string> {
  await mkdir(workspace, { recursive: true });
  const root = await realpath(workspace);
  const project = join(root, ".opentag", "context-tree", "project");
  await ensurePrivateDirectory(root, project);
  const config = projectConfigSchema.parse({ schemaVersion: SCHEMA_VERSION, trees: wanted });
  await writeDurableFile(join(project, ".context-tree.json"), `${JSON.stringify(config)}\n`);
  return project;
}

/** The prepared selection in source order; a managed authorization failure applies to every source. */
export function preparedConnections(
  connections: readonly ContextTreeConnection[],
  projectPath: string,
  denied?: string,
): ContextTreeStatus {
  return {
    status: "configured",
    connections: connections.map((connection) =>
      denied
        ? { ...connection, status: "unavailable", reason: denied }
        : { ...connection, status: "available", projectPath },
    ),
  };
}
