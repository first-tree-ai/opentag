import { z } from "zod";
import { ImBindingUnbindRequiredDetailSchema } from "./im-binding.js";

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
  "ACCOUNT_SETUP_AGENT_NOT_FOUND",
  "ACCOUNT_SETUP_NOT_READY",
  "AGENT_COMPUTER_NOT_BOUND",
  "AGENT_FORBIDDEN",
  "AGENT_CREATION_INTENT_CONFLICT",
  "AGENT_NAME_CONFLICT",
  "AGENT_LIFECYCLE_CONFLICT",
  "AGENT_REVISION_CONFLICT",
  "AGENT_REBIND_BLOCKED",
  "ONBOARDING_RESET_OWNERSHIP_INCONSISTENT",
  "ONBOARDING_RESET_UNVERIFIED",
  "IM_BINDING_CONFIGURATION_CONFLICT",
  "IM_BINDING_FORBIDDEN",
  "IM_BINDING_GENERATION_STALE",
  "IM_BINDING_NOT_FOUND",
  "IM_BINDING_PROVIDER_IMMUTABLE",
  "IM_BINDING_SCOPE_REAUTH_REQUIRED",
  "IM_BINDING_TEMPORARILY_UNAVAILABLE",
  "IM_BINDING_UNBIND_REQUIRED",
  "FEISHU_APP_ALREADY_BOUND",
  "FEISHU_BINDING_IDENTITY_MISMATCH",
  "FEISHU_UPSTREAM_UNAVAILABLE",
  "SLACK_APP_TEAM_ALREADY_BOUND",
  "SLACK_AUTH_IDENTITY_INCOMPLETE",
  "SLACK_AUTH_INVALID",
  "SLACK_BINDING_IDENTITY_MISMATCH",
  "SLACK_CONFIGURATION_CONFLICT",
  "SLACK_OAUTH_FAILED",
  "SLACK_SCOPE_REAUTH_REQUIRED",
  "SLACK_UPSTREAM_UNAVAILABLE",
  /* GitHub connection/management failures; kept in step with GITHUB_CONNECTION_ERROR_CODES. */
  "GITHUB_ADMISSION_PROOF_INVALID",
  "GITHUB_ADMISSION_PROOF_STALE",
  "GITHUB_AGENT_OWNERSHIP_INVALID",
  "GITHUB_AUTHORIZATION_VERSION_CONFLICT",
  "GITHUB_CONNECTION_CONFLICT",
  "GITHUB_CONNECTION_NOT_FOUND",
  "GITHUB_CONNECTION_STATE_INVALID",
  "GITHUB_CREDENTIAL_INPUT_INVALID",
  "GITHUB_IDENTITY_MISMATCH",
  "GITHUB_INPUT_INVALID",
  "GITHUB_OAUTH_FLOW_EXPIRED",
  "GITHUB_OAUTH_FLOW_INVALID",
  "GITHUB_OAUTH_SESSION_MISMATCH",
  "GITHUB_INTEGRATION_UNAVAILABLE",
  "GITHUB_UPSTREAM_UNAVAILABLE",
  "GITHUB_UPSTREAM_ERROR",
  "GITHUB_RATE_LIMITED",
  "GITHUB_TOKEN_LIFETIME_UNSUPPORTED",
  "GITHUB_ADMISSION_INSTALLATION_MISSING",
  "GITHUB_ADMISSION_REPOSITORY_MISSING",
  "GITHUB_ADMISSION_PERMISSION_INSUFFICIENT",
  "GITHUB_APP_IDENTITY_MISMATCH",
  "GITHUB_OAUTH_DENIED",
  "GITHUB_DELEGATED_IM_BINDING_INVALID",
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
  "TASK_NOT_QUEUED",
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
    unbindRequired: ImBindingUnbindRequiredDetailSchema.optional(),
  })
  .strict()
  .superRefine((detail, context) => {
    if (detail.unbindRequired && detail.code !== "IM_BINDING_UNBIND_REQUIRED") {
      context.addIssue({
        code: "custom",
        path: ["unbindRequired"],
        message: "Only an unbind-required failure carries the unbind identity",
      });
    }
  });

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
