import { z } from "zod";
import { ContextTreeAliasSchema, ContextTreeRepositorySchema } from "./context-tree.js";

export const ContextTreeOperationRequestSchema = z
  .object({
    alias: ContextTreeAliasSchema,
    operationId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    expectedRuntimeConfigRevision: z.number().int().positive(),
    action: z.enum(["connect", "create", "disconnect"]),
    repository: ContextTreeRepositorySchema.nullable(),
  })
  .strict()
  .refine((input) => (input.action === "disconnect" ? input.repository === null : input.repository !== null));
export const ContextTreeOperationResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), repository: ContextTreeRepositorySchema.nullable() }).strict(),
  z
    .object({
      status: z.literal("failed"),
      code: z.enum([
        "alias_conflict",
        "repository_conflict",
        "stale_configuration",
        "computer_unavailable",
        "capability_missing",
        "busy",
        "pause_required",
        "authentication_required",
        "permission_denied",
        "repository_exists",
        "invalid_tree",
        "publication_uncertain",
        "failed",
      ]),
    })
    .strict(),
]);
export const ContextTreeOperationFrameSchema = z
  .object({
    type: z.literal("context-tree:operation"),
    requestId: z.string().uuid(),
    agentId: z.string().uuid(),
    computerId: z.string().uuid(),
    requireStopped: z.boolean(),
    input: ContextTreeOperationRequestSchema,
  })
  .strict();
export const ContextTreeOperationResultFrameSchema = z
  .object({
    type: z.literal("context-tree:operation:result"),
    requestId: z.string().uuid(),
    result: ContextTreeOperationResponseSchema,
  })
  .strict();
export type ContextTreeOperationRequest = z.infer<typeof ContextTreeOperationRequestSchema>;
export type ContextTreeOperationResponse = z.infer<typeof ContextTreeOperationResponseSchema>;
export type ContextTreeOperationFrame = z.infer<typeof ContextTreeOperationFrameSchema>;
export type ContextTreeOperationResultFrame = z.infer<typeof ContextTreeOperationResultFrameSchema>;
