import { z } from "zod";
import {
  RuntimeImCliReadinessCollectionSchema,
  RuntimeProviderReadinessCollectionSchema,
  RuntimeRequestIdSchema,
} from "./runtime-protocol.js";

export const RUNTIME_SELF_CHECK_INTERVAL_MS = 30_000;
export const RUNTIME_SELF_CHECK_STALE_MS = 75_000;
export const RUNTIME_SELF_CHECK_INITIAL_TIMEOUT_MS = 15_000;
export const RUNTIME_CREDENTIAL_CHECK_INTERVAL_MS = 10 * 60_000;

export const RuntimeSelfCheckRequestSchema = z
  .object({
    type: z.literal("runtime:self-check"),
    requestId: RuntimeRequestIdSchema,
  })
  .strict();

export const RuntimeSelfCheckReportSchema = z
  .object({
    type: z.literal("runtime:self-check:report"),
    requestId: RuntimeRequestIdSchema,
    selfCheckId: RuntimeRequestIdSchema,
    sequence: z.number().int().safe().positive(),
    checkedAt: z.iso.datetime(),
    problems: z
      .array(
        z
          .object({
            part: z.enum(["runtime", "messaging_cli"]),
            reason: z.enum(["check_timed_out", "check_failed"]),
          })
          .strict(),
      )
      .max(2)
      .default([]),
    providerReadiness: RuntimeProviderReadinessCollectionSchema,
    imCliReadiness: RuntimeImCliReadinessCollectionSchema,
  })
  .strict();

export const RuntimeCredentialFailureHintSchema = z
  .object({
    type: z.literal("runtime:credential-failure"),
    requestId: RuntimeRequestIdSchema,
    agentId: z.string().uuid(),
    integrationId: z.string().uuid(),
    credentialGeneration: z.number().int().safe().nonnegative(),
    reason: z.enum(["authentication_failed", "credentials_revoked"]),
  })
  .strict();

export type RuntimeSelfCheckRequest = z.infer<typeof RuntimeSelfCheckRequestSchema>;
export type RuntimeSelfCheckReport = z.infer<typeof RuntimeSelfCheckReportSchema>;
export type RuntimeCredentialFailureHint = z.infer<typeof RuntimeCredentialFailureHintSchema>;
