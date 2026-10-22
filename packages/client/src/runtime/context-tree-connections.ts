import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { projectConfigSchema, SCHEMA_VERSION, syncResultSchema } from "@first-tree-ai/context-tree/contracts";
import { type ContextTreeConnection, contextTreeIdentity } from "@opentag/shared";
import { ensurePrivateDirectory, writeDurableFile } from "../storage/durable-file.js";

/** Runtime facts shared by Local preparation, Cloud preparation, and managed prompts. */
export type ContextTreeStatus =
  | { status: "configured"; connections: readonly ContextTreeResult[] }
  | { status: "ready"; treePath: string; projectPath: string; branch?: string; sha?: string }
  | { status: "stale"; treePath: string; projectPath: string; reason: string }
  | { status: "unconfigured" }
  | { status: "unavailable"; reason: string };

export type ContextTreeResult = ContextTreeConnection &
  Exclude<ContextTreeStatus, { status: "configured" } | { status: "unconfigured" }>;

/** This configuration belongs to the host, never to a checked-out repository. Save before fetching. */
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

export function syncedTree(payload: unknown, source: ContextTreeConnection) {
  const parsed = syncResultSchema.safeParse(payload);
  return parsed.success
    ? parsed.data.connections.find(
        (entry) =>
          entry.connection.source.kind === "git" &&
          contextTreeIdentity(entry.connection.source) === contextTreeIdentity(source),
      )
    : undefined;
}
