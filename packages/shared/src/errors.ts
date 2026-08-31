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
  "AUTH_EMAIL_CONFLICT",
  "AUTH_USER_SUSPENDED",
  "AUTH_USER_MISMATCH",
  "WORKSPACE_SETUP_AGENT_NOT_FOUND",
  "WORKSPACE_SETUP_NOT_READY",
  "AGENT_COMPUTER_NOT_BOUND",
  "AGENT_FORBIDDEN",
  "AGENT_CREATION_INTENT_CONFLICT",
  "AGENT_NAME_CONFLICT",
  "AGENT_LIFECYCLE_CONFLICT",
  "AGENT_REVISION_CONFLICT",
  "AGENT_REBIND_BLOCKED",
  "ONBOARDING_RESET_OWNERSHIP_INCONSISTENT",
  "ONBOARDING_RESET_UNVERIFIED",
  "IM_BINDING_FORBIDDEN",
  "IM_BINDING_NOT_FOUND",
  "IM_BINDING_PROVIDER_IMMUTABLE",
  "IM_BINDING_SCOPE_REAUTH_REQUIRED",
  "FEISHU_UPSTREAM_UNAVAILABLE",
  "SLACK_APP_TEAM_ALREADY_BOUND",
  "SLACK_AUTH_IDENTITY_INCOMPLETE",
  "SLACK_AUTH_INVALID",
  "SLACK_BINDING_IDENTITY_MISMATCH",
  "SLACK_CONFIGURATION_CONFLICT",
  "SLACK_OAUTH_FAILED",
  "SLACK_SCOPE_REAUTH_REQUIRED",
  "SLACK_UPSTREAM_UNAVAILABLE",
  "CLIENT_VERSION_UNSUPPORTED",
  "COMPUTER_IDENTITY_CONFLICT",
  "COMPUTER_NOT_FOUND",
  "COMPUTER_NOT_REGISTERED",
  "PROTOCOL_CAPABILITY_UNSUPPORTED",
  "PROTOCOL_ERROR",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "RUNTIME_AUTH_TIMEOUT",
  "RUNTIME_REGISTER_TIMEOUT",
  "SESSION_CURSOR_INVALID",
  "SESSION_PROOF_INVALID",
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
