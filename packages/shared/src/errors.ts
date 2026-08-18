import { z } from "zod";

export const ErrorCategorySchema = z.enum(["credential", "deterministic", "validation", "transient", "rate_limit"]);

export const ErrorCodeSchema = z.enum([
  "AUTH_CODE_CONSUMED",
  "AUTH_CODE_EXPIRED",
  "AUTH_INVALID_CODE",
  "AUTH_INVALID_TOKEN",
  "AUTH_MEMBERSHIP_REQUIRED",
  "AUTH_SESSION_REVOKED",
  "AUTH_USER_SUSPENDED",
  "INTERNAL_ERROR",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "VALIDATION_ERROR",
]);

export const ErrorDetailSchema = z
  .object({
    code: ErrorCodeSchema,
    category: ErrorCategorySchema,
    message: z.string().min(1),
    requestId: z.string().min(1).optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
  })
  .strict();

export const ErrorEnvelopeSchema = z
  .object({
    error: ErrorDetailSchema,
  })
  .strict();

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
