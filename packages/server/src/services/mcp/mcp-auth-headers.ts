import { MCPAuthKindSchema, MCPCustomAuthHeaderSchema, MCPExtraHeadersSchema } from "@opentag/shared";
import type { z } from "zod";
import { MCP_ERROR_CODES, McpServiceError } from "./errors.js";

/**
 * The one place an outbound MCP request's authorization headers are built. Probing and any future
 * runtime call take the same path, so a header rule can never be enforced in one and forgotten in
 * the other.
 *
 * The input is the *effective* configuration for one Agent — the shared definition with that Agent's
 * overrides already applied — never a raw `mcp_servers` row.
 */

export interface McpAuthHeaderInput {
  kind: z.infer<typeof MCPAuthKindSchema>;
  /** `auth_header` from the effective configuration. Only read for `kind='bearer'`. */
  authHeader: string;
  /**
   * `auth_scheme` from the effective configuration. An empty string is a legitimate value meaning
   * the stored secret is sent verbatim (`X-API-Key: <key>`); it is not "unset".
   */
  authScheme: string;
  extraHeaders: Record<string, string>;
  /** The decrypted credential; required for `bearer`, absent for `none` and `oauth`. */
  bearerKey?: string;
  /** The current access token; required for `oauth`. */
  accessToken?: string;
}

/** The `Authorization: Bearer <token>` header OAuth always uses, per the specification. */
export const MCP_OAUTH_AUTHORIZATION_HEADER = "authorization";

function invalid(message: string): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.AUTH_HEADER_INVALID, message);
}

/**
 * Build the exact header set for one outbound request.
 *
 * - `oauth` always uses `Authorization: Bearer <token>`; the specification requires the token to
 *   travel in that header and forbids it in the query string.
 * - `bearer` uses the effective `auth_header` and `auth_scheme`; an empty scheme sends the value
 *   unchanged.
 * - `none` sends no authorization header at all.
 * - `extraHeaders` apply to all three kinds, because they are configuration rather than credentials.
 *
 * A header name appearing twice is impossible to send deterministically, so a collision between the
 * resolved authorization header and an extra header is rejected here rather than silently losing one.
 * Comparison is case-insensitive: HTTP field names are.
 */
export function buildMcpAuthHeaders(input: McpAuthHeaderInput): Record<string, string> {
  const kind = MCPAuthKindSchema.parse(input.kind);
  const extraHeaders = parseExtraHeaders(input.extraHeaders);
  const headers: Record<string, string> = {};
  let authHeaderName: string | undefined;

  if (kind === "oauth") {
    if (!input.accessToken) throw invalid("An OAuth authorization has no access token");
    authHeaderName = MCP_OAUTH_AUTHORIZATION_HEADER;
    headers[authHeaderName] = `Bearer ${input.accessToken}`;
  } else if (kind === "bearer") {
    if (!input.bearerKey) throw invalid("A bearer authorization has no key");
    authHeaderName = validateAuthHeaderName(input.authHeader);
    headers[authHeaderName] = input.authScheme === "" ? input.bearerKey : `${input.authScheme} ${input.bearerKey}`;
  }

  if (authHeaderName) {
    const colliding = Object.keys(extraHeaders).find((name) => name === authHeaderName);
    if (colliding) {
      throw invalid("An extra header may not repeat the authorization header name");
    }
  }
  for (const [name, value] of Object.entries(extraHeaders)) headers[name] = value;
  return headers;
}

/** The same rules the store enforces, re-applied so a value read from elsewhere is still checked. */
export function parseExtraHeaders(value: Record<string, string>): Record<string, string> {
  const parsed = MCPExtraHeadersSchema.safeParse(value ?? {});
  if (!parsed.success) throw invalid("The extra headers are invalid");
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(parsed.data)) result[name] = headerValue;
  return result;
}

export function validateAuthHeaderName(value: string): string {
  const parsed = MCPCustomAuthHeaderSchema.safeParse(value);
  if (!parsed.success) throw invalid("The authorization header name is invalid");
  return parsed.data;
}
