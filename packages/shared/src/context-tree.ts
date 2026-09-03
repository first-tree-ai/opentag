import { z } from "zod";

export const CONTEXT_TREE_CONFIG_SCHEMA_VERSION = 1;
export const CONTEXT_TREE_PREPARATION_SCHEMA_VERSION = 1;

/**
 * The Context Tree every Agent Session on one Computer uses.
 *
 * The three kinds mirror `context-tree connect`'s own argument shape, so OpenTag passes the target
 * through instead of reinterpreting it. `github` is the kind that lets several Computers share one
 * tree. Validating a target for real means running the CLI against it, which `opentag context-tree
 * connect` does before writing this file; these checks only keep the file well-formed.
 */
export const ContextTreeTargetSchema = z.discriminatedUnion("kind", [
  // The managed namespace is a directory name and the CLI only discovers safe lowercase
  // segments, so a name it could never accept must fail here as a usage error rather than
  // later as a confusing "no such tree".
  z
    .object({
      kind: z.literal("managed"),
      name: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[a-z0-9][a-z0-9._-]*$/),
    })
    .strict(),
  z.object({ kind: z.literal("github"), repository: z.string().trim().min(1) }).strict(),
  z
    .object({
      kind: z.literal("path"),
      path: z
        .string()
        .trim()
        .refine((value) => value.startsWith("/"), { message: "A Context Tree path must be absolute" }),
    })
    .strict(),
]);

export const ContextTreeConfigSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_TREE_CONFIG_SCHEMA_VERSION),
    target: ContextTreeTargetSchema,
  })
  .strict();

/** Last completed background preparation, exposed through non-blocking diagnostics. */
export const ContextTreePreparationSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_TREE_PREPARATION_SCHEMA_VERSION),
    target: z.string().min(1),
    status: z.enum(["ready", "unavailable"]),
    reason: z.string().min(1).optional(),
    at: z.iso.datetime(),
  })
  .strict();

/** Render a target back into the exact argument a user would type, for diagnostics and logs. */
export function formatContextTreeTarget(target: ContextTreeTarget): string {
  if (target.kind === "managed") return target.name;
  if (target.kind === "github") return target.repository;
  return target.path;
}

/**
 * Route the single positional argument accepted by `opentag context-tree connect`.
 *
 * An absolute path is unambiguous and a managed name cannot contain a slash, so the order is
 * decidable. Anything else is a usage error rather than a guess: this must not search the
 * filesystem on the caller's behalf.
 */
export function parseContextTreeTarget(value: string): ContextTreeTarget | undefined {
  const trimmed = value.trim();
  const candidate: unknown = trimmed.startsWith("/")
    ? { kind: "path", path: trimmed }
    : trimmed.includes("/")
      ? { kind: "github", repository: trimmed }
      : { kind: "managed", name: trimmed };
  const parsed = ContextTreeTargetSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export type ContextTreeTarget = z.infer<typeof ContextTreeTargetSchema>;
export type ContextTreeConfig = z.infer<typeof ContextTreeConfigSchema>;
export type ContextTreePreparation = z.infer<typeof ContextTreePreparationSchema>;
