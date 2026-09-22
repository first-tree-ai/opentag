import { z } from "zod";

/**
 * The fields of a Google service account key that the Error Reporting client needs. Keys use the
 * key file's own snake_case names because they are handed to the Google auth library unchanged.
 */
export interface ErrorReportingCredentials {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface ErrorReportingConfig {
  /** Unset keeps relayed errors in the server log only. */
  projectId?: string;
  /** Unset falls back to Application Default Credentials. */
  credentials?: ErrorReportingCredentials;
}

const ServiceAccountKeySchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string().trim().min(1),
  private_key: z.string().min(1),
  project_id: z.string().trim().min(1).optional(),
});

/**
 * The fixed message for an unusable key. It must never quote the value: the variable holds a private
 * key, and configuration errors are printed at startup.
 */
export const ERROR_REPORTING_CREDENTIALS_INVALID_MESSAGE =
  "OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON must be a Google service account key in JSON";

/** Parse the service account key JSON, or `undefined` when it is not one. Never throws. */
export function parseErrorReportingCredentials(raw: string): ErrorReportingCredentials | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = ServiceAccountKeySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { client_email, private_key, project_id } = parsed.data;
  return { client_email, private_key, ...(project_id ? { project_id } : {}) };
}

/**
 * Zod field for `OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON`: the whole key file as one value, for
 * platforms that can set environment variables but cannot mount a file for
 * `GOOGLE_APPLICATION_CREDENTIALS`.
 */
export const ErrorReportingCredentialsJsonSchema = z
  .string()
  .optional()
  .transform((raw, context) => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const credentials = parseErrorReportingCredentials(raw);
    if (!credentials) {
      context.addIssue({ code: "custom", message: ERROR_REPORTING_CREDENTIALS_INVALID_MESSAGE });
      return z.NEVER;
    }
    return credentials;
  });

/** The explicit project wins; otherwise the key's own project, so the key alone is enough to enable forwarding. */
export function resolveErrorReportingConfig(
  projectId: string | undefined,
  credentials: ErrorReportingCredentials | undefined,
): ErrorReportingConfig {
  const resolvedProjectId = projectId ?? credentials?.project_id;
  return {
    ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
    ...(credentials ? { credentials } : {}),
  };
}
