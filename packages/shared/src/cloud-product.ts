import { z } from "zod";
import { RuntimeModelSchema } from "./runtime-config.js";
import { SandboxLifecycleSchema } from "./sandbox.js";
import { SessionKindSchema } from "./session.js";

/** Deployment configuration, not evidence that an Instance is already running. */
export const CloudAvailabilitySchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    reason: z.enum(["disabled", "execution_unavailable", "model_unavailable"]).nullable(),
    observedAt: z.string().datetime(),
  })
  .strict();
export type CloudAvailability = z.infer<typeof CloudAvailabilitySchema>;

/**
 * Upper bound on the Router-offered model list the Server relays. The Server-side catalog applies
 * the same bound before caching, so a response larger than this can never be published.
 */
export const CLOUD_MODEL_OPTIONS_MAX_MODELS = 256;

/**
 * The Cloud model choices the account surface offers, sourced ONLY from the deployment Router's
 * authenticated model list (`GET {upstreamBaseUrl}/models`): the Router already applies tenant
 * permissions and the priced registry, and no Server-side static list restricts or extends it.
 * The default an Agent without an explicit model executes with is the FIRST Router model. The
 * shape is coherent by construction: `available: false` always pairs with an empty list and a
 * null default, and an available list is non-empty with the default as its first entry.
 */
export const CloudModelOptionsSchema = z
  .object({
    available: z.boolean(),
    models: z.array(RuntimeModelSchema).max(CLOUD_MODEL_OPTIONS_MAX_MODELS),
    defaultModel: RuntimeModelSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.available) {
      if (value.models.length !== 0 || value.defaultModel !== null) {
        context.addIssue({
          code: "custom",
          message: "An unavailable Cloud model list carries no models and no default",
        });
      }
      return;
    }
    if (value.models.length === 0 || value.defaultModel !== value.models[0]) {
      context.addIssue({
        code: "custom",
        message: "An available Cloud model list is non-empty and defaults to its first model",
      });
    }
  });
export type CloudModelOptions = z.infer<typeof CloudModelOptionsSchema>;

export const CloudSessionSummarySchema = z
  .object({
    sessionId: z.string().uuid(),
    sandboxId: z.string().uuid(),
    kind: SessionKindSchema,
    lifecycle: SandboxLifecycleSchema,
    environmentGeneration: z.number().int().nonnegative().safe(),
    runnerConnected: z.boolean(),
    runnerReady: z.boolean(),
    taskState: z.enum(["idle", "queued", "running", "unknown"]),
    lastErrorCode: z.string().max(128).nullable(),
    lastErrorAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
    canRelease: z.boolean(),
    canDiscard: z.boolean(),
  })
  .strict();
export type CloudSessionSummary = z.infer<typeof CloudSessionSummarySchema>;

export const AgentCloudOverviewSchema = z
  .object({
    agentId: z.string().uuid(),
    observedAt: z.string().datetime(),
    capacity: z
      .object({
        accountUsed: z.number().int().nonnegative().safe(),
        accountLimit: z.number().int().positive().safe(),
      })
      .strict(),
    counts: z
      .object({
        allocated: z.number().int().nonnegative().safe(),
        queued: z.number().int().nonnegative().safe(),
        running: z.number().int().nonnegative().safe(),
        attention: z.number().int().nonnegative().safe(),
      })
      .strict(),
    sessions: z.array(CloudSessionSummarySchema).max(100),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export type AgentCloudOverview = z.infer<typeof AgentCloudOverviewSchema>;

export const AgentCloudOverviewQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine((value) => !value.cursor || !value.sessionId, {
    message: "A Session filter cannot be combined with a cursor",
  });
export type AgentCloudOverviewQuery = z.infer<typeof AgentCloudOverviewQuerySchema>;
