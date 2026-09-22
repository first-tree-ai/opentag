import { isAbsolute } from "node:path";
import type { ContextTreeConnection } from "@opentag/shared";
import { ContextTreeAliasSchema, ContextTreeRepositorySchema } from "@opentag/shared";
import { z } from "zod";

const PathSchema = z
  .string()
  .min(1)
  .refine((path) => isAbsolute(path) && !/[\r\n\0]/u.test(path));
const TreeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), path: PathSchema, repository: ContextTreeRepositorySchema }).strict(),
  z.object({ kind: z.literal("local"), path: PathSchema }).strict(),
]);
export const StoredConnectionsSchema = z
  .object({
    schemaVersion: z.literal(2),
    connections: z.array(
      z.object({ alias: ContextTreeAliasSchema, projectPath: PathSchema, tree: TreeSchema }).strict(),
    ),
  })
  .strict();
const DiscoverySchema = z.object({
  schemaVersion: z.literal(2),
  connections: z.array(
    z.object({
      alias: ContextTreeAliasSchema,
      tree: TreeSchema,
      ok: z.boolean(),
      error: z.object({ code: z.string() }).optional(),
      branch: z.string().optional(),
      sha: z.string().optional(),
    }),
  ),
});
const ConnectedSchema = z.object({ schemaVersion: z.literal(2), alias: ContextTreeAliasSchema, tree: TreeSchema });
export type ContextTreeRun = (
  args: readonly string[],
  network: boolean,
) => Promise<{ payload: unknown; failureCode?: string }>;

export function connectedTree(payload: unknown, connection: ContextTreeConnection) {
  const parsed = ConnectedSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.alias !== connection.alias ||
    parsed.data.tree.kind !== "github" ||
    parsed.data.tree.repository.toLowerCase() !== connection.repository.toLowerCase()
  )
    return undefined;
  return parsed.data.tree;
}

export function syncedTree(payload: unknown, connection: ContextTreeConnection) {
  const parsed = DiscoverySchema.safeParse(payload);
  return parsed.success
    ? parsed.data.connections.find(
        (entry) =>
          entry.alias === connection.alias &&
          entry.tree.kind === "github" &&
          entry.tree.repository.toLowerCase() === connection.repository.toLowerCase(),
      )
    : undefined;
}

/** Remove linkage through the CLI only. Checkouts and unpublished work are never deleted. */
export async function reconcileContextTreeConnections(
  run: ContextTreeRun,
  workspace: string,
  wanted: readonly ContextTreeConnection[],
): Promise<{ failureCode?: string; attachedAliases: Set<string> }> {
  const attachedAliases = new Set<string>();
  const discovered = await run(["resolve", "--project-path", workspace, "--json"], false);
  if (discovered.failureCode === "NO_CONNECTION") return { attachedAliases };
  const parsed = DiscoverySchema.safeParse(discovered.payload);
  if (!parsed.success) return { failureCode: discovered.failureCode ?? "UNSUPPORTED_CONNECTIONS", attachedAliases };
  for (const entry of parsed.data.connections) {
    if (
      wanted.some(
        (connection) =>
          connection.alias === entry.alias &&
          entry.tree.kind === "github" &&
          connection.repository.toLowerCase() === entry.tree.repository.toLowerCase(),
      )
    ) {
      if (entry.ok) attachedAliases.add(entry.alias);
      continue;
    }
    const removed = await run(["disconnect", "--tree", entry.alias, "--project-path", workspace, "--json"], false);
    if (removed.failureCode) return { failureCode: removed.failureCode, attachedAliases };
  }
  return { attachedAliases };
}
