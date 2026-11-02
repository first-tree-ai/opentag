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
  /** `auth_header` from the effective configuration. */
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

/** The `Authorization: Bearer <token>` header OAuth uses by default, per the specification. */
export const MCP_OAUTH_AUTHORIZATION_HEADER = "authorization";
/** Feishu's hosted MCP endpoint requires user OAuth access tokens in `X-Lark-MCP-UAT`. */
export const MCP_FEISHU_OAUTH_UAT_HEADER = "x-lark-mcp-uat";

function invalid(message: string): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.AUTH_HEADER_INVALID, message);
}

/**
 * Build the exact header set for one outbound request.
 *
 * - `oauth` uses `Authorization: Bearer <token>` unless `auth_header` is `x-lark-mcp-uat`, in which
 *   case it honors `x-lark-mcp-uat` and `auth_scheme` while keeping other definitions (such as a
 *   shared definition with `x-api-key` for a bearer Agent) on `Authorization: Bearer <token>`.
 * - `bearer` uses the effective `auth_header` and `auth_scheme`; an empty scheme sends the value
 *   unchanged.
 * - `none` sends no authorization header at all.
 * - `extraHeaders` apply to all three kinds, because they are configuration rather than credentials.
 *
 * A header name appearing twice is impossible to send deterministically, so a collision between the
 * resolved authorization header and an extra header is rejected here rather than silently losing one.
 * Comparison is case-insensitive: HTTP field names are.
 */
function formatSchemeCredential(scheme: string, secret: string): string {
  return scheme === "" ? secret : `${scheme} ${secret}`;
}

function resolveAuthorizationHeader(input: McpAuthHeaderInput): [string, string] | undefined {
  if (input.kind === "oauth") {
    if (!input.accessToken) throw invalid("An OAuth authorization has no access token");
    const configured = validateAuthHeaderName(input.authHeader);
    if (configured === MCP_FEISHU_OAUTH_UAT_HEADER) {
      return [configured, formatSchemeCredential(input.authScheme, input.accessToken)];
    }
    return [MCP_OAUTH_AUTHORIZATION_HEADER, `Bearer ${input.accessToken}`];
  }
  if (input.kind === "bearer") {
    if (!input.bearerKey) throw invalid("A bearer authorization has no key");
    return [validateAuthHeaderName(input.authHeader), formatSchemeCredential(input.authScheme, input.bearerKey)];
  }
  return undefined;
}

export function buildMcpAuthHeaders(input: McpAuthHeaderInput): Record<string, string> {
  MCPAuthKindSchema.parse(input.kind);
  const extraHeaders = parseExtraHeaders(input.extraHeaders);
  const headers: Record<string, string> = {};
  const resolved = resolveAuthorizationHeader(input);

  if (resolved) {
    const [authHeaderName, authHeaderValue] = resolved;
    headers[authHeaderName] = authHeaderValue;
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
