import { z } from "zod";

export const ContextTreeRepositorySchema = z
  .string()
  .trim()
  .max(140)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/)
  .refine((value) => !value.toLowerCase().endsWith(".git"), "Use OWNER/REPO without .git");
export const ContextTreePathSchema = z
  .string()
  .refine(
    (value) =>
      value === "." ||
      (value.length > 0 &&
        !value.includes("\\") &&
        !hasControl(value) &&
        value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git")),
    "Use a relative directory path",
  );
export const ContextTreeBranchSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/[\s~^:?*[\\]/u.test(value) &&
      !hasControl(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith(".") &&
      value !== "@" &&
      !value.startsWith("-") &&
      value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")),
    "Use a Git branch name",
  );
export const ContextTreeConnectionSchema = z
  .object({
    kind: z.literal("git"),
    repository: ContextTreeRepositorySchema,
    path: ContextTreePathSchema,
    ref: ContextTreeBranchSchema,
  })
  .strict();
export type ContextTreeConnection = z.infer<typeof ContextTreeConnectionSchema>;
export const CONTEXT_TREES_MAX = 32;
export function contextTreeIdentity(source: ContextTreeConnection): string {
  return JSON.stringify([source.repository.toLowerCase(), source.path, source.ref]);
}
export function contextTreeSelector(source: ContextTreeConnection): string {
  const path = source.path === "." ? "" : `/${source.path.split("/").map(encodeURIComponent).join("/")}`;
  return `https://github.com/${source.repository.toLowerCase()}/tree/${encodeURIComponent(source.ref)}${path}`;
}
export function contextTreeName(source: ContextTreeConnection): string {
  return (source.path === "." ? source.repository : source.path).split("/").at(-1) ?? source.repository;
}
export const ContextTreesSchema = z
  .array(ContextTreeConnectionSchema)
  .max(CONTEXT_TREES_MAX)
  .superRefine((sources, context) => {
    const identities = new Set<string>();
    sources.forEach((source, index) => {
      const identity = contextTreeIdentity(source);
      if (identities.has(identity))
        context.addIssue({ code: "custom", path: [index], message: "Sources must be unique" });
      identities.add(identity);
    });
  });
export function normalizeContextTrees(sources: readonly ContextTreeConnection[]): ContextTreeConnection[] {
  return sources
    .map((source) => ({ ...source, repository: source.repository.toLowerCase() }))
    .sort((left, right) => contextTreeIdentity(left).localeCompare(contextTreeIdentity(right)));
}

function hasControl(value: string): boolean {
  return [...value].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "\u2028" || char === "\u2029",
  );
}
