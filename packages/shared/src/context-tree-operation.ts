import { z } from "zod";
import { ContextTreeBranchSchema, ContextTreeConnectionSchema, ContextTreeRepositorySchema } from "./context-tree.js";

export const ContextTreeOperationRequestSchema = z
  .object({
    ...ContextTreeConnectionSchema.shape,
    // Git HEAD requests the repository’s default branch; successful resolution returns its name.
    expectedRevision: z.number().int().positive(),
    expectedRuntimeConfigRevision: z.number().int().positive(),
    action: z.enum(["connect", "create", "disconnect"]),
  })
  .strict();
export const ContextTreeOperationResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      repository: ContextTreeRepositorySchema.nullable(),
      ref: ContextTreeBranchSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      code: z.enum([
        "tree_limit_reached",
        "stale_configuration",
        "computer_unavailable",
        "capability_missing",
        "busy",
        "pause_required",
        "authentication_required",
        "github_not_configured",
        "permission_denied",
        "invalid_tree",
        "publication_uncertain",
        "repository_rejected",
        "failed",
      ]),
    })
    .strict(),
]);
export type ContextTreeOperationRequest = z.infer<typeof ContextTreeOperationRequestSchema>;
export type ContextTreeOperationResponse = z.infer<typeof ContextTreeOperationResponseSchema>;
