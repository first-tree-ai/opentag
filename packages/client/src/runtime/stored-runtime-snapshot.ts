import {
  ContextTreesSchema,
  computeLegacyRuntimeSnapshotHashes,
  computeRuntimeSnapshotHashes,
  EffectiveRuntimeSnapshotSchema,
  hashTuple,
  type RuntimeSnapshotHashes,
} from "@opentag/shared";
import { z } from "zod";

// Frozen disk-only tree shape. New work still uses EffectiveRuntimeSnapshotSchema.
const AliasTreesSchema = z
  .array(
    z
      .object({
        alias: z
          .string()
          .regex(/^[A-Za-z\d][A-Za-z\d._-]{0,99}$/u)
          .refine((value) => !/\.git$/iu.test(value)),
        repository: z
          .string()
          .trim()
          .max(140)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_][a-zA-Z0-9._-]{0,99}$/)
          .refine((value) => !value.toLowerCase().endsWith(".git")),
      })
      .strict(),
  )
  .max(32)
  .refine(
    (trees) =>
      new Set(trees.map((tree) => tree.alias)).size === trees.length &&
      new Set(trees.map((tree) => tree.repository.toLowerCase())).size === trees.length,
  );

export const StoredRuntimeSnapshotSchema = EffectiveRuntimeSnapshotSchema.extend({
  contextTrees: z.union([ContextTreesSchema, AliasTreesSchema]),
});
export type StoredRuntimeSnapshot = z.infer<typeof StoredRuntimeSnapshotSchema>;

/** Verify original bytes semantically; never convert old selections into new connections. */
export function computeStoredRuntimeSnapshotHashes(
  snapshot: StoredRuntimeSnapshot,
  layout?: "0.1.0" | "self-configuration",
): RuntimeSnapshotHashes {
  const aliases = AliasTreesSchema.safeParse(snapshot.contextTrees);
  if (!aliases.success || aliases.data.length === 0) {
    const current = EffectiveRuntimeSnapshotSchema.parse(snapshot);
    return layout ? computeLegacyRuntimeSnapshotHashes(current, layout) : computeRuntimeSnapshotHashes(current);
  }
  const withoutTrees = { ...snapshot, contextTrees: [] };
  const { sessionConfigHash } = layout
    ? computeLegacyRuntimeSnapshotHashes(withoutTrees, layout)
    : computeRuntimeSnapshotHashes(withoutTrees);
  const trees = aliases.data
    .map(({ alias, repository }) => ({ alias, repository: repository.toLowerCase() }))
    .sort((left, right) => (left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0));
  const agentConfigHash = hashTuple([
    1,
    snapshot.agentId,
    snapshot.provider,
    snapshot.revision.agent.sequence,
    snapshot.revision.agent.id,
    snapshot.instructions.platform,
    snapshot.instructions.agent,
    ...(layout === "0.1.0" ? [] : [snapshot.selfConfigurationEnabled ?? false]),
    snapshot.workspace.workspaceId,
    snapshot.workspace.mode,
    snapshot.workspace.sharing,
    trees,
  ]);
  return {
    agentConfigHash,
    sessionConfigHash,
    effectiveSnapshotHash: hashTuple([1, agentConfigHash, sessionConfigHash]),
  };
}
