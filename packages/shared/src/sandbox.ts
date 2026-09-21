import { z } from "zod";
import { ImConversationKindSchema } from "./im-message.js";

export const SandboxLifecycleSchema = z.enum(["unallocated", "preparing", "ready", "releasing"]);

const AccountSandboxEnsureScopeSchema = {
  imBindingId: z.string().uuid(),
  channelId: z.string().min(1).max(512),
  conversationKind: ImConversationKindSchema,
};

/**
 * Account-owned Sandbox ensure input. Session identity is derived from an existing owned IM binding
 * plus channel/thread scope; `internal` Sessions are out of scope. `threadKey` is required for
 * thread Sessions and forbidden for channel Sessions.
 */
export const AccountSandboxEnsureRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...AccountSandboxEnsureScopeSchema, kind: z.literal("channel") }).strict(),
  z
    .object({
      ...AccountSandboxEnsureScopeSchema,
      kind: z.literal("thread"),
      threadKey: z.string().min(1).max(512),
    })
    .strict(),
]);

/**
 * Durable Sandbox identity as an Account may read it. Resource fields are null while unallocated;
 * a later phase may still report a resource name/UID until removal is verified. This is not
 * evidence that compute is allocated or that Pi can execute.
 */
export const AccountSandboxResponseSchema = z
  .object({
    sandboxId: z.string().uuid(),
    sessionId: z.string().uuid(),
    computerId: z.string().uuid(),
    storageUri: z.string().min(1).max(2048),
    lifecycle: SandboxLifecycleSchema,
    environmentGeneration: z.number().int().nonnegative(),
    currentResourceName: z.string().min(1).max(1024).nullable(),
    currentResourceUid: z.string().min(1).max(128).nullable(),
    currentOperationName: z.string().min(1).max(1024).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type SandboxLifecycle = z.infer<typeof SandboxLifecycleSchema>;
export type AccountSandboxEnsureRequest = z.infer<typeof AccountSandboxEnsureRequestSchema>;
export type AccountSandboxResponse = z.infer<typeof AccountSandboxResponseSchema>;
