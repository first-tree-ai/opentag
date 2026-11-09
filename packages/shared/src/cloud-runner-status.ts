import { z } from "zod";
import { SandboxLifecycleSchema } from "./sandbox.js";

const UuidSchema = z.string().uuid();
const ResourceNameSchema = z.string().min(1).max(1024);

/**
 * Native-sandbox/tool readiness as the Runner reported it after authentication. `runnerVersion`
 * is the pinned Runner build the image reports from its identity document; the Server requires
 * the exact configured version before an environment may become ready.
 */
export const RunnerReadinessSchema = z
  .object({
    sandboxName: z.string().min(1).max(128),
    rootfs: z.string().min(1).max(512),
    nodeVersion: z.string().min(1).max(64),
    piVersion: z.string().min(1).max(64),
    runnerVersion: z.string().min(1).max(64),
    reportedAt: z.string().datetime(),
  })
  .strict();

export type RunnerReadiness = z.infer<typeof RunnerReadinessSchema>;

/**
 * Runner state as an Account may read it. `runnerReady` is true only after an authenticated
 * Runner reported native sandbox/tool readiness for the CURRENT environment generation — never
 * from cloud provider readiness alone.
 */
export const AccountSandboxRunnerStatusResponseSchema = z
  .object({
    sandboxId: UuidSchema,
    sessionId: UuidSchema,
    lifecycle: SandboxLifecycleSchema,
    environmentGeneration: z.number().int().nonnegative(),
    currentResourceName: ResourceNameSchema.nullable(),
    currentResourceUid: z.string().min(1).max(128).nullable(),
    currentOperationName: ResourceNameSchema.nullable(),
    runnerConnected: z.boolean(),
    runnerReady: z.boolean(),
    runnerReadiness: RunnerReadinessSchema.nullable(),
    lastErrorCode: z.string().min(1).max(128).nullable(),
    lastErrorAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type AccountSandboxRunnerStatusResponse = z.infer<typeof AccountSandboxRunnerStatusResponseSchema>;
