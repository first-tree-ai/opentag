import { z } from "zod";

export const ErrorCategorySchema = z.enum(["credential", "deterministic", "validation", "transient", "rate_limit"]);

export const ErrorCodeSchema = z.enum([
  "AUTH_CODE_CONSUMED",
  "AUTH_CODE_EXPIRED",
  "AUTH_INVALID_CODE",
  "AUTH_INVALID_TOKEN",
  "AUTH_MEMBERSHIP_REQUIRED",
  "AUTH_USER_SUSPENDED",
  "AUTH_USER_MISMATCH",
  "COMPUTER_IDENTITY_CONFLICT",
  "COMPUTER_NOT_REGISTERED",
  "PROTOCOL_ERROR",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "RUNTIME_AUTH_TIMEOUT",
  "RUNTIME_REGISTER_TIMEOUT",
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
