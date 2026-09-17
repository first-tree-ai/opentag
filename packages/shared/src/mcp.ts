import { z } from "zod";
import { AgentDisplayNameSchema } from "./agent.js";

/**
 * MCP (Model Context Protocol) management contract.
 *
 * This release delivers the management plane only: Server definitions, per-Agent bindings, and
 * per-Agent authorization (Bearer key or OAuth). Runtime delivery of MCP credentials to Providers
 * is not implemented, so an Agent does not yet call MCP tools. See
 * `docs/design/mcp-server-integration.md`.
 *
 * Every schema here is strict and browser-compatible. None of them ever carries secrets: no
 * credential ciphertext or key IDs, no OAuth state/PKCE material, no bearer key values, and no
 * access or refresh tokens. A caller learns only whether a credential exists.
 *
 * Authorization is scoped strictly per Agent. One Server may be authorized differently for two
 * Agents of the same Account — Agent A with a bearer key, Agent B with OAuth — and there is no
 * Account-level fallback.
 */

const UuidSchema = z.string().uuid();

export const MCPServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "Server name must start with a lowercase letter or number and contain only lowercase letters, numbers, and hyphens",
  );
/**
 * The human-readable description an operator writes over the probed one.
 *
 * Bounded to 1024 bytes by the datastore as well; the plan's byte bound is enforced server-side.
 * This is an override, not the only source: the Server's own `serverInfo.description` arrives with a
 * probe and is reported separately, so a definition with no override still shows the peer's words.
 */
export const MCPServerDescriptionSchema = z.string().trim().min(1).max(1024);

/**
 * The three authorization kinds. `none` is a real authorization row, not an absence: an anonymous
 * Server still has exactly one row per bound Agent, with no credential.
 */
export const MCP_AUTH_KINDS = ["none", "bearer", "oauth"] as const;
export const MCPAuthKindSchema = z.enum(MCP_AUTH_KINDS);
export type MCPAuthKind = z.infer<typeof MCPAuthKindSchema>;

export const MCPAuthorizationStatusSchema = z.enum(["pending", "active", "expired", "revoked", "error"]);
export type MCPAuthorizationStatus = z.infer<typeof MCPAuthorizationStatusSchema>;
export const MCPProbeStateSchema = z.enum(["pending", "succeeded", "failed"]);
export type MCPProbeState = z.infer<typeof MCPProbeStateSchema>;
/**
 * The protocol era of the resolved origin, cached per authorization row because an Agent-level URL
 * override makes the origin differ per Agent. `modern` is the stateless per-request model;
 * `legacy` is the `initialize` handshake of 2025-03-26 through 2025-11-25; `null` means unknown and
 * forces a fresh downgrade detection.
 */
export const MCPProtocolEraSchema = z.enum(["modern", "legacy"]);
export type MCPProtocolEra = z.infer<typeof MCPProtocolEraSchema>;
export const MCPClientRegistrationSourceSchema = z.enum(["preregistered", "cimd", "dcr"]);
export type MCPClientRegistrationSource = z.infer<typeof MCPClientRegistrationSourceSchema>;

/**
 * RFC 9110 field-name token characters, lowercase only. The set excludes the empty string, so a field
 * name can never be blank, and it excludes every control character, so CR/LF injection into an
 * outbound request is impossible by construction.
 */
const HTTP_FIELD_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/**
 * A header name the Server always controls and a caller may never set: these either belong to the
 * transport (content negotiation, framing) or to the MCP request metadata the client must author.
 */
export const MCP_RESERVED_HEADER_NAMES = [
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "content-type",
  "accept",
  /*
   * Transport-owned or connection-scoped. undici throws on most of these, which a user met as "the
   * MCP endpoint could not be reached" — an error about the Server for a header this deployment
   * refused to send. `te` and `proxy-authorization` are worse than an error: they would be forwarded,
   * and both describe the hop rather than the request.
   */
  "keep-alive",
  "upgrade",
  "expect",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
] as const;

export const MCP_MAX_EXTRA_HEADERS = 16;
export const MCP_MAX_EXTRA_HEADER_VALUE_BYTES = 4096;
export const MCP_MAX_EXTRA_HEADERS_BYTES = 8 * 1024;
export const MCPAuthHeaderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toLowerCase())
  .refine((value) => HTTP_FIELD_NAME_PATTERN.test(value), {
    message: "The authorization header must be a valid lowercase HTTP field name",
  });

function isReservedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("mcp-")) return true;
  return (MCP_RESERVED_HEADER_NAMES as readonly string[]).includes(lower);
}

/**
 * Normalize extra headers to the stored form: names lowercased, values untouched. Comparison is
 * case-insensitive throughout, so `X-Workspace-Id` and `x-workspace-id` can never be stored as two
 * different headers and a rename cannot smuggle a duplicate past the reserved-name check.
 */
export function normalizeExtraHeaders(value: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    normalized[rawName.trim().toLowerCase()] = rawValue;
  }
  return normalized;
}

/** A custom authorization header name: an RFC 9110 token that is neither reserved nor transport-owned. */
export const MCPCustomAuthHeaderSchema = MCPAuthHeaderNameSchema.refine((value) => !isReservedHeaderName(value), {
  message: "The authorization header may not be a reserved or transport-owned header",
});

/**
 * The prefixed form of the authorization value. An empty string is a legitimate value and means the
 * stored secret is sent verbatim (for example `X-API-Key: <key>`), which is why clearing the
 * override is a separate, explicit action rather than an empty one.
 */
export const MCPAuthSchemeSchema = z
  .string()
  .max(64)
  .refine((value) => !/[\r\n]/.test(value), { message: "The authorization scheme may not contain CR or LF" });

const ExtraHeaderKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toLowerCase())
  .refine((value) => HTTP_FIELD_NAME_PATTERN.test(value), {
    message: "An extra header name must be a valid lowercase HTTP field name",
  })
  .refine((value) => !isReservedHeaderName(value), {
    message: "An extra header may not be a reserved or transport-owned header",
  });

/**
 * Whether a string contains a control character.
 *
 * Checked in code rather than with a regex: an escape-form character class is what the linter forbids,
 * and writing the literal bytes is worse. Every control character is refused, not only CR and LF — a
 * NUL reaches undici as an invalid header value and surfaced to the user as an unreachable endpoint,
 * an error about the Server for a header this deployment would not send.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

const ExtraHeaderValueSchema = z
  .string()
  .max(MCP_MAX_EXTRA_HEADER_VALUE_BYTES)
  .refine((value) => !hasControlCharacter(value), {
    message: "An extra header value may not contain control characters",
  });

/**
 * Additional static headers sent alongside the authorization header for every kind. They are not
 * credentials, so they apply to `none` as well. Names are compared case-insensitively and stored
 * lowercased; a name that collides with the effective authorization header is rejected.
 */
export const MCPExtraHeadersSchema = z
  .record(ExtraHeaderKeySchema, ExtraHeaderValueSchema)
  .superRefine((headers, context) => {
    const entries = Object.entries(headers);
    if (entries.length > MCP_MAX_EXTRA_HEADERS) {
      context.addIssue({
        code: "custom",
        message: `At most ${MCP_MAX_EXTRA_HEADERS} extra headers are allowed`,
      });
      return;
    }
    if (entries.length === 0) return;
    const normalized: Record<string, string> = {};
    for (const [name, value] of entries) normalized[name.toLowerCase()] = value;
    const bytes = BufferByteLength(JSON.stringify(normalized));
    if (bytes > MCP_MAX_EXTRA_HEADERS_BYTES) {
      context.addIssue({
        code: "custom",
        message: `The extra headers must serialize to at most ${MCP_MAX_EXTRA_HEADERS_BYTES} bytes`,
      });
    }
  });
export type MCPExtraHeaders = z.infer<typeof MCPExtraHeadersSchema>;

/** UTF-8 byte length without depending on the Node `Buffer` global, so the browser build works. */
function BufferByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * An outbound MCP endpoint. Scheme, host shape, and reachability rules are enforced by the server's
 * single outbound URL policy (`MCP_URL_BLOCKED`); this schema only bounds the parsed shape so the
 * client and server agree on what a URL field may contain.
 */
export const MCPServerUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.hostname.length > 0
      );
    } catch {
      return false;
    }
  }, "Must be an HTTP(S) URL without credentials or fragment");

/** One `tools/list` entry snapshot. Bounded exactly as the probe bounds it. */
export const MCPToolSnapshotSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(1024).nullable(),
    inputSchema: z.unknown().nullable(),
  })
  .strict();
export type MCPToolSnapshot = z.infer<typeof MCPToolSnapshotSchema>;

export const MCP_PROBE_MAX_TOOLS = 200;
export const MCP_PROBE_MAX_TOOLS_BYTES = 256 * 1024;
export const MCP_ACCOUNT_TOOL_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * `defaultAuthKind` is a prefill for a newly created authorization and the trigger for creating a
 * `none` row when binding such a Server. It is never a statement of what the Server requires, and
 * it never constrains the kind an Agent actually writes.
 */
export const MCPServerSchema = z
  .object({
    id: UuidSchema,
    name: MCPServerNameSchema,
    description: MCPServerDescriptionSchema.nullable(),
    url: z.string().min(1),
    defaultAuthKind: MCPAuthKindSchema,
    authHeader: z.string().min(1),
    authScheme: z.string(),
    extraHeaders: z.record(z.string(), z.string()),
    revision: z.number().int().min(1),
    boundAgentCount: z.number().int().min(0),
    authorizedAgentCount: z.number().int().min(0),
    lastProbedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type MCPServer = z.infer<typeof MCPServerSchema>;

export const ListMCPServersResponseSchema = z.object({ servers: z.array(MCPServerSchema) }).strict();
export type ListMCPServersResponse = z.infer<typeof ListMCPServersResponseSchema>;

/** The Agent-level overrides. Each is independent; `null` means inherit the shared definition. */
export const MCPBindingOverridesSchema = z
  .object({
    urlOverride: z.string().min(1).nullable(),
    authHeaderOverride: z.string().min(1).nullable(),
    authSchemeOverride: z.string().nullable(),
    extraHeadersOverride: z.record(z.string(), z.string()).nullable(),
  })
  .strict();
export type MCPBindingOverrides = z.infer<typeof MCPBindingOverridesSchema>;

/** The effective configuration one Agent actually uses: definition values with its overrides applied. */
export const MCPEffectiveConfigSchema = z
  .object({
    url: z.string().min(1),
    authHeader: z.string().min(1),
    authScheme: z.string(),
    extraHeaders: z.record(z.string(), z.string()),
  })
  .strict();
export type MCPEffectiveConfig = z.infer<typeof MCPEffectiveConfigSchema>;

/** Which effective fields came from an Agent override rather than the shared definition. */
export const MCPOverrideSourcesSchema = z
  .object({
    url: z.boolean(),
    authHeader: z.boolean(),
    authScheme: z.boolean(),
    extraHeaders: z.boolean(),
  })
  .strict();
export type MCPOverrideSources = z.infer<typeof MCPOverrideSourcesSchema>;

/**
 * The authorization as a caller may read it. There is no credential field of any kind — not even a
 * mask — only `hasCredential`, so a leaked response can never carry key material.
 */
export const MCPAuthorizationSummarySchema = z
  .object({
    kind: MCPAuthKindSchema,
    status: MCPAuthorizationStatusSchema,
    hasCredential: z.boolean(),
    scopes: z.array(z.string()).nullable(),
    accessTokenExpiresAt: z.string().datetime().nullable(),
    authorizationServer: z.string().nullable(),
    probeState: MCPProbeStateSchema,
    probedAt: z.string().datetime().nullable(),
    probeError: z.string().nullable(),
    toolsCount: z.number().int().min(0).nullable(),
    toolsTruncated: z.boolean(),
    failureCode: z.string().nullable(),
    revision: z.number().int().min(1),
  })
  .strict();
export type MCPAuthorizationSummary = z.infer<typeof MCPAuthorizationSummarySchema>;

/**
 * The Server's own description of itself, out of the `serverInfo` a probe recorded.
 *
 * Derived on read rather than stored as its own column: `serverInfo` is already persisted verbatim,
 * so extracting this is a pure function of data that is already there, and a second column could
 * only drift from it. Returns null for any shape that is not the specification's `Implementation`,
 * because `serverInfo` is untrusted JSON from a peer.
 */
export function probedServerDescription(serverInfo: unknown): string | null {
  if (typeof serverInfo !== "object" || serverInfo === null || Array.isArray(serverInfo)) return null;
  const description = (serverInfo as Record<string, unknown>).description;
  if (typeof description !== "string") return null;
  const trimmed = description.trim();
  // Bounded here as well as at the probe, because `server_info` is jsonb read back by a later build.
  return trimmed.length === 0 ? null : trimmed.slice(0, 1024);
}

/** The snapshot one Agent's own credential produced, plus the era that produced it. */
export const MCPProbeSnapshotSchema = z
  .object({
    protocolEra: MCPProtocolEraSchema.nullable(),
    protocolVersion: z.string().nullable(),
    serverInfo: z.unknown().nullable(),
    capabilities: z.unknown().nullable(),
    instructions: z.string().max(4096).nullable(),
    tools: z.array(MCPToolSnapshotSchema).nullable(),
  })
  .strict();
export type MCPProbeSnapshot = z.infer<typeof MCPProbeSnapshotSchema>;

/**
 * One Agent's view of one Server: where it mounted, whether it is enabled, the effective
 * configuration, and that Agent's own authorization. `enabled` and the authorization status are
 * independent — a disabled binding keeps its credential and needs no reauthorization.
 */
export const MCPAgentServerSchema = z
  .object({
    mcpServerId: UuidSchema,
    name: MCPServerNameSchema,
    description: MCPServerDescriptionSchema.nullable(),
    /**
     * What this Agent's own probe heard the Server say about itself, shown when `description` is
     * null. Per Agent rather than per definition because the probe runs with this Agent's
     * credential, and two credentials can reach two different origins.
     */
    discoveredDescription: z.string().max(1024).nullable(),
    enabled: z.boolean(),
    effective: MCPEffectiveConfigSchema,
    overridden: MCPOverrideSourcesSchema,
    authorization: MCPAuthorizationSummarySchema.nullable(),
    snapshot: MCPProbeSnapshotSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type MCPAgentServer = z.infer<typeof MCPAgentServerSchema>;

export const ListAgentMCPServersResponseSchema = z.object({ servers: z.array(MCPAgentServerSchema) }).strict();
export type ListAgentMCPServersResponse = z.infer<typeof ListAgentMCPServersResponseSchema>;

/** One row of the Server detail's Agent matrix. */
export const MCPServerAgentSchema = z
  .object({
    agentId: UuidSchema,
    agentName: MCPServerNameSchema,
    agentDisplayName: AgentDisplayNameSchema,
    enabled: z.boolean(),
    effective: MCPEffectiveConfigSchema,
    overridden: MCPOverrideSourcesSchema,
    /*
     * The authorization summary already carries kind, status, probeState, toolsCount, probeError, and
     * accessTokenExpiresAt; the era is the one fact that belongs here rather than in it, because it
     * describes the origin this Agent's effective URL resolved to and not the credential.
     */
    protocolEra: MCPProtocolEraSchema.nullable(),
    protocolVersion: z.string().nullable(),
    authorization: MCPAuthorizationSummarySchema.nullable(),
  })
  .strict();
export type MCPServerAgent = z.infer<typeof MCPServerAgentSchema>;

export const MCPServerDetailSchema = z
  .object({
    server: MCPServerSchema,
    agents: z.array(MCPServerAgentSchema),
  })
  .strict();
export type MCPServerDetail = z.infer<typeof MCPServerDetailSchema>;

/** An Account Server that this Agent has not mounted, for the "add existing Server" chooser. */
export const MCPAvailableServerSchema = z
  .object({
    id: UuidSchema,
    name: MCPServerNameSchema,
    description: MCPServerDescriptionSchema.nullable(),
    boundAgentCount: z.number().int().min(0),
  })
  .strict();
export type MCPAvailableServer = z.infer<typeof MCPAvailableServerSchema>;

export const ListAvailableMCPServersResponseSchema = z.object({ servers: z.array(MCPAvailableServerSchema) }).strict();
export type ListAvailableMCPServersResponse = z.infer<typeof ListAvailableMCPServersResponseSchema>;

/**
 * Definition create/update input. `authHeader`, `authScheme`, and `extraHeaders` only matter for a
 * bearer authorization; they are still stored on the definition so two Agents can override them
 * independently.
 *
 * `description` is absent on create on purpose: a definition's description is what a probe
 * discovered, and there is nothing to probe until the definition exists. Creation writes NULL and
 * the first successful probe fills it in; `update` is where an operator replaces it.
 */
export const CreateMCPServerRequestSchema = z
  .object({
    name: MCPServerNameSchema,
    url: MCPServerUrlSchema,
    defaultAuthKind: MCPAuthKindSchema.default("oauth"),
    authHeader: MCPCustomAuthHeaderSchema.optional(),
    authScheme: MCPAuthSchemeSchema.optional(),
    extraHeaders: MCPExtraHeadersSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.extraHeaders && value.authHeader && value.authHeader in value.extraHeaders) {
      context.addIssue({
        code: "custom",
        path: ["extraHeaders"],
        message: "An extra header may not repeat the authorization header name",
      });
    }
  });
export type CreateMCPServerRequest = z.infer<typeof CreateMCPServerRequestSchema>;

export const UpdateMCPServerRequestSchema = z
  .object({
    description: MCPServerDescriptionSchema.nullable().optional(),
    url: MCPServerUrlSchema.optional(),
    defaultAuthKind: MCPAuthKindSchema.optional(),
    authHeader: MCPCustomAuthHeaderSchema.optional(),
    authScheme: MCPAuthSchemeSchema.optional(),
    extraHeaders: MCPExtraHeadersSchema.optional(),
    clearExtraHeaders: z.boolean().optional(),
    expectedRevision: z.number().int().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.extraHeaders !== undefined && value.clearExtraHeaders === true) {
      context.addIssue({
        code: "custom",
        path: ["extraHeaders"],
        message: "Setting extra headers and clearing them are mutually exclusive",
      });
    }
  });
export type UpdateMCPServerRequest = z.infer<typeof UpdateMCPServerRequestSchema>;

export const AttachMCPServerRequestSchema = z
  .object({
    mcpServerId: UuidSchema,
    enabled: z.boolean().default(true),
  })
  .strict();
export type AttachMCPServerRequest = z.infer<typeof AttachMCPServerRequestSchema>;

/**
 * The binding update: the single enable/disable layer (target 4) plus this Agent's overrides.
 *
 * Every field follows the same three-state contract: omitted leaves the stored value alone,
 * a value writes an override, and the matching `clearX` flag removes the override so the shared
 * definition applies again. A cleared field is never spelled as an empty value, because an empty
 * `authScheme` is a legitimate override meaning "send the stored secret verbatim".
 *
 * `extraHeaders` has one extra action the other three do not: `emptyExtraHeaders` writes `{}`,
 * meaning this Agent sends no extra headers at all, which is distinct from inheriting the
 * definition's set.
 */
export const UpdateMCPBindingRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    url: MCPServerUrlSchema.optional(),
    clearUrl: z.boolean().optional(),
    authHeader: MCPCustomAuthHeaderSchema.optional(),
    clearAuthHeader: z.boolean().optional(),
    authScheme: MCPAuthSchemeSchema.optional(),
    clearAuthScheme: z.boolean().optional(),
    extraHeaders: MCPExtraHeadersSchema.optional(),
    clearExtraHeaders: z.boolean().optional(),
    emptyExtraHeaders: z.boolean().optional(),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const pairs: [keyof UpdateMCPBindingRequest, keyof UpdateMCPBindingRequest][] = [
      ["url", "clearUrl"],
      ["authHeader", "clearAuthHeader"],
      ["authScheme", "clearAuthScheme"],
    ];
    for (const [set, clear] of pairs) {
      if (value[set] !== undefined && value[clear] === true) {
        context.addIssue({ code: "custom", path: [clear], message: "Set and clear are mutually exclusive" });
      }
    }
    const extraActions = [
      value.extraHeaders !== undefined,
      value.clearExtraHeaders === true,
      value.emptyExtraHeaders === true,
    ].filter(Boolean).length;
    if (extraActions > 1) {
      context.addIssue({
        code: "custom",
        path: ["extraHeaders"],
        message: "Setting, clearing, and emptying extra headers are mutually exclusive",
      });
    }
  });
export type UpdateMCPBindingRequest = z.infer<typeof UpdateMCPBindingRequestSchema>;

/**
 * Writes a bearer credential (or declares `none`) for exactly this Agent, upserting the one row for
 * this (Server, Agent) pair. Changing kind replaces the credential in the same row.
 */
export const SetMCPAuthorizationRequestSchema = z
  .object({
    kind: z.enum(["none", "bearer"]),
    bearerKey: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "bearer" && value.bearerKey === undefined) {
      context.addIssue({ code: "custom", path: ["bearerKey"], message: "A bearer authorization requires its key" });
    }
    if (value.kind === "none" && value.bearerKey !== undefined) {
      context.addIssue({ code: "custom", path: ["bearerKey"], message: "An anonymous authorization carries no key" });
    }
  });
export type SetMCPAuthorizationRequest = z.infer<typeof SetMCPAuthorizationRequestSchema>;

export const StartMCPOAuthRequestSchema = z
  .object({
    scopes: z.array(z.string().min(1).max(255)).max(64).optional(),
  })
  .strict();
export type StartMCPOAuthRequest = z.infer<typeof StartMCPOAuthRequestSchema>;

export const StartMCPOAuthResponseSchema = z
  .object({
    authorizationUrl: z.string().url().max(8192),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type StartMCPOAuthResponse = z.infer<typeof StartMCPOAuthResponseSchema>;

export const MCPProbeResponseSchema = z
  .object({
    probeState: MCPProbeStateSchema,
    probeError: z.string().nullable(),
    toolsCount: z.number().int().min(0).nullable(),
    toolsTruncated: z.boolean(),
    protocolEra: MCPProtocolEraSchema.nullable(),
    protocolVersion: z.string().nullable(),
  })
  .strict();
export type MCPProbeResponse = z.infer<typeof MCPProbeResponseSchema>;

/** Pre-registering a client with an authorization server, ahead of any discovery. */
export const RegisterMCPClientRequestSchema = z
  .object({
    authorizationServer: z.string().min(1).max(2048),
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type RegisterMCPClientRequest = z.infer<typeof RegisterMCPClientRequestSchema>;

export const MCPClientRegistrationSchema = z
  .object({
    id: UuidSchema,
    authorizationServer: z.string().min(1),
    source: MCPClientRegistrationSourceSchema,
    clientId: z.string().min(1),
    hasClientSecret: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type MCPClientRegistration = z.infer<typeof MCPClientRegistrationSchema>;

export const ListMCPClientRegistrationsResponseSchema = z
  .object({ registrations: z.array(MCPClientRegistrationSchema) })
  .strict();
export type ListMCPClientRegistrationsResponse = z.infer<typeof ListMCPClientRegistrationsResponseSchema>;

/** The OAuth callback's fixed return surface, mirroring the GitHub/Slack outcome parameters. */
export const MCP_OAUTH_OUTCOME_PARAM = "mcp_oauth";
export const MCP_OAUTH_ERROR_PARAM = "mcp_oauth_error";
export const MCP_OAUTH_SERVER_PARAM = "server";
export const MCP_OAUTH_OUTCOME_SUCCESS = "success";
export const MCP_OAUTH_OUTCOME_ERROR = "error";

export const MCPOAuthOutcomeSearchSchema = z
  .object({
    [MCP_OAUTH_OUTCOME_PARAM]: z.enum([MCP_OAUTH_OUTCOME_SUCCESS, MCP_OAUTH_OUTCOME_ERROR]),
    [MCP_OAUTH_ERROR_PARAM]: z.string().min(1).max(120).optional(),
    [MCP_OAUTH_SERVER_PARAM]: UuidSchema.optional(),
  })
  .strict();
export type MCPOAuthOutcomeSearch = z.infer<typeof MCPOAuthOutcomeSearchSchema>;

/**
 * Bounded public error codes. `MCP_AUTHORIZATION_REQUIRED`, `MCP_AUTHORIZATION_SCOPE_REQUIRED`, and
 * `MCP_REFRESH_OUTCOME_UNKNOWN` are internal verdicts: they appear on a row's `failure_code` and in
 * UI copy, never as the primary code of a management-plane HTTP response.
 */
export const MCP_ERROR_CODES = {
  SERVER_NOT_FOUND: "MCP_SERVER_NOT_FOUND",
  SERVER_NAME_CONFLICT: "MCP_SERVER_NAME_CONFLICT",
  SERVER_FORBIDDEN: "MCP_SERVER_FORBIDDEN",
  SERVER_REVISION_CONFLICT: "MCP_SERVER_REVISION_CONFLICT",
  SERVER_IN_USE: "MCP_SERVER_IN_USE",
  SERVER_URL_INVALID: "MCP_SERVER_URL_INVALID",
  URL_BLOCKED: "MCP_URL_BLOCKED",
  BINDING_NOT_FOUND: "MCP_BINDING_NOT_FOUND",
  BINDING_CONFLICT: "MCP_BINDING_CONFLICT",
  AUTHORIZATION_NOT_FOUND: "MCP_AUTHORIZATION_NOT_FOUND",
  AUTHORIZATION_REQUIRED: "MCP_AUTHORIZATION_REQUIRED",
  AUTHORIZATION_SCOPE_REQUIRED: "MCP_AUTHORIZATION_SCOPE_REQUIRED",
  AUTHORIZATION_KIND_INVALID: "MCP_AUTHORIZATION_KIND_INVALID",
  CREDENTIAL_INPUT_INVALID: "MCP_CREDENTIAL_INPUT_INVALID",
  AUTH_HEADER_INVALID: "MCP_AUTH_HEADER_INVALID",
  OAUTH_FLOW_INVALID: "MCP_OAUTH_FLOW_INVALID",
  OAUTH_FLOW_EXPIRED: "MCP_OAUTH_FLOW_EXPIRED",
  OAUTH_DENIED: "MCP_OAUTH_DENIED",
  OAUTH_FAILED: "MCP_OAUTH_FAILED",
  REGISTRATION_UNSUPPORTED: "MCP_REGISTRATION_UNSUPPORTED",
  REGISTRATION_FAILED: "MCP_REGISTRATION_FAILED",
  TRANSPORT_UNSUPPORTED: "MCP_TRANSPORT_UNSUPPORTED",
  PROTOCOL_UNSUPPORTED: "MCP_PROTOCOL_UNSUPPORTED",
  UPSTREAM_UNAVAILABLE: "MCP_UPSTREAM_UNAVAILABLE",
  UPSTREAM_ERROR: "MCP_UPSTREAM_ERROR",
  PROBE_FAILED: "MCP_PROBE_FAILED",
  REFRESH_OUTCOME_UNKNOWN: "MCP_REFRESH_OUTCOME_UNKNOWN",
} as const;
export type MCPErrorCode = (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES];
export type MCPErrorCategory = "credential" | "deterministic" | "validation" | "transient";

/** The `category` / `statusCode` mapping every MCP failure uses; see the design document. */
export const MCP_ERROR_CODE_METADATA: Readonly<
  Record<MCPErrorCode, { category: MCPErrorCategory; statusCode: number }>
> = {
  [MCP_ERROR_CODES.SERVER_NOT_FOUND]: { category: "deterministic", statusCode: 404 },
  [MCP_ERROR_CODES.BINDING_NOT_FOUND]: { category: "deterministic", statusCode: 404 },
  [MCP_ERROR_CODES.AUTHORIZATION_NOT_FOUND]: { category: "deterministic", statusCode: 404 },
  [MCP_ERROR_CODES.SERVER_FORBIDDEN]: { category: "credential", statusCode: 403 },
  [MCP_ERROR_CODES.SERVER_NAME_CONFLICT]: { category: "deterministic", statusCode: 409 },
  [MCP_ERROR_CODES.BINDING_CONFLICT]: { category: "deterministic", statusCode: 409 },
  [MCP_ERROR_CODES.SERVER_REVISION_CONFLICT]: { category: "deterministic", statusCode: 409 },
  [MCP_ERROR_CODES.SERVER_IN_USE]: { category: "deterministic", statusCode: 409 },
  [MCP_ERROR_CODES.SERVER_URL_INVALID]: { category: "validation", statusCode: 400 },
  [MCP_ERROR_CODES.URL_BLOCKED]: { category: "validation", statusCode: 400 },
  [MCP_ERROR_CODES.AUTH_HEADER_INVALID]: { category: "validation", statusCode: 400 },
  [MCP_ERROR_CODES.CREDENTIAL_INPUT_INVALID]: { category: "validation", statusCode: 400 },
  [MCP_ERROR_CODES.AUTHORIZATION_KIND_INVALID]: { category: "validation", statusCode: 400 },
  [MCP_ERROR_CODES.AUTHORIZATION_REQUIRED]: { category: "credential", statusCode: 401 },
  [MCP_ERROR_CODES.AUTHORIZATION_SCOPE_REQUIRED]: { category: "credential", statusCode: 403 },
  [MCP_ERROR_CODES.OAUTH_FLOW_INVALID]: { category: "credential", statusCode: 400 },
  [MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED]: { category: "credential", statusCode: 410 },
  [MCP_ERROR_CODES.OAUTH_DENIED]: { category: "credential", statusCode: 502 },
  [MCP_ERROR_CODES.OAUTH_FAILED]: { category: "credential", statusCode: 502 },
  [MCP_ERROR_CODES.REGISTRATION_UNSUPPORTED]: { category: "deterministic", statusCode: 422 },
  [MCP_ERROR_CODES.REGISTRATION_FAILED]: { category: "deterministic", statusCode: 502 },
  [MCP_ERROR_CODES.TRANSPORT_UNSUPPORTED]: { category: "deterministic", statusCode: 422 },
  [MCP_ERROR_CODES.PROTOCOL_UNSUPPORTED]: { category: "validation", statusCode: 400 },
  [MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE]: { category: "transient", statusCode: 503 },
  [MCP_ERROR_CODES.UPSTREAM_ERROR]: { category: "transient", statusCode: 502 },
  [MCP_ERROR_CODES.PROBE_FAILED]: { category: "transient", statusCode: 502 },
  [MCP_ERROR_CODES.REFRESH_OUTCOME_UNKNOWN]: { category: "transient", statusCode: 502 },
};

/** The protocol versions this client speaks, newest first. */
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MCP_LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [MCP_MODERN_PROTOCOL_VERSION, ...MCP_LEGACY_PROTOCOL_VERSIONS] as const;
