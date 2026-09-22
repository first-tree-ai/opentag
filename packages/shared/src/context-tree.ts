import { z } from "zod";

export const ContextTreeRepositorySchema = z
  .string()
  .trim()
  .max(140)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_][a-zA-Z0-9._-]{0,99}$/)
  .refine((value) => !value.toLowerCase().endsWith(".git"), "Use OWNER/REPO without .git");

/** Matches the upstream CLI's project-local treeNameSchema (aliases are case-sensitive). */
export const ContextTreeAliasSchema = z
  .string()
  .regex(/^[A-Za-z\d][A-Za-z\d._-]{0,99}$/u)
  .refine((value) => !/\.git$/iu.test(value), "Alias must not end with .git");

export const ContextTreeConnectionSchema = z
  .object({
    alias: ContextTreeAliasSchema,
    repository: ContextTreeRepositorySchema,
  })
  .strict();
// Bound per-Agent preparation work and runtime prompt size.
export const CONTEXT_TREES_MAX = 32;
export const ContextTreesSchema = z
  .array(ContextTreeConnectionSchema)
  .max(CONTEXT_TREES_MAX)
  .superRefine((connections, context) => {
    const aliases = new Set<string>();
    const repositories = new Set<string>();
    connections.forEach((connection, index) => {
      if (aliases.has(connection.alias))
        context.addIssue({ code: "custom", path: [index, "alias"], message: "Aliases must be unique" });
      if (repositories.has(connection.repository.toLowerCase()))
        context.addIssue({ code: "custom", path: [index, "repository"], message: "Repositories must be unique" });
      aliases.add(connection.alias);
      repositories.add(connection.repository.toLowerCase());
    });
  });
export type ContextTreeConnection = z.infer<typeof ContextTreeConnectionSchema>;

/** Array order is presentation only; no tree takes precedence over another. */
export function normalizeContextTrees(connections: readonly ContextTreeConnection[]): ContextTreeConnection[] {
  return connections
    .map(({ alias, repository }) => ({ alias, repository: repository.toLowerCase() }))
    .sort((left, right) => (left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0));
}
