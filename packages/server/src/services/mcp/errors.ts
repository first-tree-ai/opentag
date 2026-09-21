import { type ErrorCategory, MCP_ERROR_CODE_METADATA, MCP_ERROR_CODES, type MCPErrorCode } from "@opentag/shared";

/*
 * The controlled MCP failure vocabulary lives in @opentag/shared so the Account HTTP error envelope
 * accepts exactly the codes these services report. Messages never carry secret material: no bearer
 * key, no ciphertext, no OAuth state, PKCE verifier, authorization code, or token payload.
 */
export { MCP_ERROR_CODES, type MCPErrorCode };

/**
 * A controlled failure of the MCP management services. `category` and `statusCode` come from the
 * single published mapping so an HTTP response code can never be invented at a call site.
 */
export class McpServiceError extends Error {
  /** Extra bounded detail a caller may render; never a secret and never raw upstream text. */
  readonly detail: Readonly<Record<string, unknown>> | undefined;

  constructor(code: MCPErrorCode, message: string, detail?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpServiceError";
    this.code = code;
    this.detail = detail;
  }

  readonly code: MCPErrorCode;

  get category(): ErrorCategory {
    return MCP_ERROR_CODE_METADATA[this.code].category;
  }

  get statusCode(): number {
    return MCP_ERROR_CODE_METADATA[this.code].statusCode;
  }
}

/**
 * Render bounded detail into an error message so it stays observable through the strict HTTP error
 * envelope, which admits no extra fields. Values are never secrets — only counts and identifiers.
 */
export function mcpErrorWithDetail(
  code: MCPErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): McpServiceError {
  if (!detail) return new McpServiceError(code, message);
  const entries = Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`);
  return new McpServiceError(code, entries.length === 0 ? message : `${message} (${entries.join("; ")})`, detail);
}

export function mcpServerNotFound(): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.SERVER_NOT_FOUND, "The requested MCP Server was not found");
}

export function mcpBindingNotFound(): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.BINDING_NOT_FOUND, "The Agent has not mounted this MCP Server");
}

export function mcpAuthorizationNotFound(): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.AUTHORIZATION_NOT_FOUND, "The Agent has no authorization for this Server");
}

/** Whether a thrown error is a PostgreSQL unique violation on one named constraint. */
export function isMcpUniqueViolation(error: unknown, constraintName: string): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === constraintName
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Bound a summary so a `probe_error` or message never becomes a raw upstream payload. Public codes
 * pass through unchanged; anything else is reduced to its own first 200 characters.
 */
export function boundedMcpSummary(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 197)}...`;
}

/** Codes a row may persist in `failure_code` / `probe_error`; everything else is a generic failure. */
const PERSISTED_MCP_CODES = new Set<string>(Object.values(MCP_ERROR_CODES));

export function boundedMcpErrorCode(code: string): string {
  return PERSISTED_MCP_CODES.has(code) ? code : MCP_ERROR_CODES.PROBE_FAILED;
}
