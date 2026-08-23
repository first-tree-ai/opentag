import { z } from "zod";

export const ErrorCategorySchema = z.enum(["credential", "deterministic", "validation", "transient", "rate_limit"]);

export const ErrorCodeSchema = z.enum([
  "AUTH_CODE_CONSUMED",
  "AUTH_CODE_EXPIRED",
  "AUTH_DEV_USER_UNAVAILABLE",
  "AUTH_DEV_USER_UNAVAILABLE",
  "AUTH_INVALID_CODE",
  "AUTH_INVALID_TOKEN",
  "AUTH_OAUTH_FAILED",
  "AUTH_PROVIDER_DISABLED",
  "AUTH_IDENTITY_CONFLICT",
  "AUTH_MEMBERSHIP_REQUIRED",
  "AUTH_USER_SUSPENDED",
  "AUTH_USER_MISMATCH",
  "INVITATION_INVALID",
  "INVITATION_CORRUPT",
  "MEMBERSHIP_ACTIVE_AGENTS",
  "MEMBERSHIP_FORBIDDEN",
  "MEMBERSHIP_LAST_ADMIN",
  "MEMBERSHIP_NOT_FOUND",
  "TEAM_LIMIT_REACHED",
  "TEAM_NAME_CONFLICT",
  "AGENT_FORBIDDEN",
  "AGENT_CREATION_INTENT_CONFLICT",
  "AGENT_NAME_CONFLICT",
  "AGENT_LIFECYCLE_CONFLICT",
  "AGENT_REVISION_CONFLICT",
  "IM_BINDING_FORBIDDEN",
  "IM_BINDING_NOT_FOUND",
  "IM_BINDING_PROVIDER_IMMUTABLE",
  "IM_BINDING_SCOPE_REAUTH_REQUIRED",
  "FEISHU_UPSTREAM_UNAVAILABLE",
  "SLACK_ACTIVATION_INCOMPLETE",
  "SLACK_APP_TEAM_ALREADY_BOUND",
  "SLACK_AUTH_INVALID",
  "SLACK_BINDING_IDENTITY_MISMATCH",
  "SLACK_IM_BINDING_ALREADY_EXISTS",
  "SLACK_REAUTHORIZATION_REQUIRES_BINDING",
  "SLACK_REPLACEMENT_REQUIRES_BINDING",
  "SLACK_REPLACEMENT_REQUIRES_DIFFERENT_APP",
  "SLACK_SCOPE_REAUTH_REQUIRED",
  "SLACK_SETUP_CONFLICT",
  "SLACK_SETUP_EXPIRED",
  "SLACK_SETUP_INTENT_CONFLICT",
  "SLACK_SETUP_NOT_ACTIVE",
  "SLACK_SETUP_NOT_FOUND",
  "SLACK_SETUP_NOT_READY",
  "SLACK_SIGNING_CHALLENGE_REQUIRED",
  "SLACK_SIGNING_SECRET_INVALID",
  "SLACK_UPSTREAM_UNAVAILABLE",
  "COMPUTER_IDENTITY_CONFLICT",
  "COMPUTER_NOT_FOUND",
  "COMPUTER_NOT_REGISTERED",
  "PROTOCOL_CAPABILITY_UNSUPPORTED",
  "PROTOCOL_ERROR",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "RUNTIME_AUTH_TIMEOUT",
  "RUNTIME_REGISTER_TIMEOUT",
  "INTERNAL_ERROR",
  "RATE_LIMITED",
  "RESOURCE_NOT_FOUND",
  "SERVICE_UNAVAILABLE",
  "VALIDATION_ERROR",
]);

export const ValidationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const ErrorDetailSchema = z
  .object({
    code: ErrorCodeSchema,
    category: ErrorCategorySchema,
    message: z.string().min(1),
    requestId: z.string().min(1).optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
    issues: z.array(ValidationIssueSchema).optional(),
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
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
