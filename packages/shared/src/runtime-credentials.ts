import { z } from "zod";
import { RuntimeExecutionServiceRequestSchema, RuntimeExecutionServiceSchema } from "./execution-services.js";
import {
  GitBranchRefSchema,
  GitHubRepositoryAccessSchema,
  GitHubRepositoryPublishModeSchema,
  GitHubRepositoryRoleSchema,
} from "./github-integration.js";
import { MCP_GATEWAY_PATH } from "./mcp-gateway.js";
import { runtimeByteString as byteString } from "./runtime-config.js";
import { RuntimeImOutboxContextSchema, RuntimeOpaqueIdSchema } from "./runtime-domain.js";
import { RuntimeRequestIdSchema } from "./runtime-protocol.js";
import { SessionCliProofGrantSchema } from "./session-cli.js";

/**
 * Runtime credential delegation contract (control + data planes).
 *
 * The control plane travels over the authenticated runtime business channel; the data plane is a
 * separate binary WebSocket authenticated by a single-use ticket. Schemas here are the only wire
 * authority: both planes use strict objects, bounded strings, and explicit enums. Nothing in this
 * module carries raw platform secrets — capabilities and tickets are opaque random values.
 */

export const RUNTIME_PROVIDER_PROXY_PATH = "/api/v1/runtime/provider-proxy" as const;

export const RUNTIME_CREDENTIAL_CAPABILITY_TTL_MS = 60_000;
export const RUNTIME_CREDENTIAL_CAPABILITY_REFRESH_AFTER_MS = 30_000;
export const RUNTIME_PROXY_TICKET_TTL_MS = 15_000;
export const RUNTIME_EXECUTION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const RUNTIME_VALIDATION_RUN_TTL_MS = 60_000;

export const PROVIDER_PROXY_HEADER_MAX_BYTES = 16 * 1024;
export const PROVIDER_PROXY_CHUNK_MAX_BYTES = 65_536;
export const PROVIDER_PROXY_INITIAL_CREDIT_BYTES = 1_048_576;
export const PROVIDER_PROXY_MAX_STREAMS_PER_EXECUTION = 8;
export const PROVIDER_PROXY_MAX_STREAM_OPENS_PER_CONNECTION = 256;
export const PROVIDER_PROXY_STREAM_REVALIDATE_INTERVAL_MS = 5_000;
export const PROVIDER_PROXY_AUTH_TIMEOUT_MS = 5_000;
export const PROVIDER_PROXY_MAX_FRAME_BYTES = PROVIDER_PROXY_CHUNK_MAX_BYTES + 4;
export const RUNTIME_CLI_METADATA_MAX_REPOSITORIES = 100;

/**
 * Reserved internal header carrying the pinned upstream host for GitHub proxy streams
 * (`github.com` for Git, `api.github.com` for REST/GraphQL). Set only by the trusted Runner
 * adapter; the Server validates it and never treats it as caller authority over the origin.
 */
export const RUNTIME_PROVIDER_ORIGIN_HEADER = "x-opentag-provider-origin" as const;

/**
 * Harmless placeholder the Server returns for the Feishu tenant-token endpoint. The real tenant
 * token never leaves the Server, and the Runner adapter replaces this sentinel with its
 * Sandbox-local handle before the native CLI sees it.
 */
export const FEISHU_TENANT_TOKEN_LOCAL_SENTINEL = "opentag-local-handle-tenant-token" as const;

export const RUNTIME_CREDENTIAL_PROVIDERS = ["github", "slack", "feishu"] as const;
export const RuntimeCredentialProviderSchema = z.enum(RUNTIME_CREDENTIAL_PROVIDERS);
export type RuntimeCredentialProvider = z.infer<typeof RuntimeCredentialProviderSchema>;

const executionId = z.string().uuid();
const grantId = z.string().uuid();
const bindingId = z.string().min(1).max(128);
const requestId = RuntimeRequestIdSchema;
const isoDateTime = z.string().datetime({ offset: true });
const opaqueToken = byteString(512, "The opaque token exceeds the 512-byte limit", 32);
const ticket = byteString(512, "The proxy ticket exceeds the 512-byte limit", 32);
const scopeDigest = z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");
const revisionString = z.string().min(1).max(256);

export const RuntimeExecutionSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("delivery"),
      deliveryId: RuntimeOpaqueIdSchema,
      turnId: RuntimeOpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("session-message"),
      messageId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("validation"),
      validationRunId: z.string().uuid(),
    })
    .strict(),
]);
export type RuntimeExecutionSource = z.infer<typeof RuntimeExecutionSourceSchema>;

export const RuntimeExecutionSandboxSchema = z
  .object({
    sandboxId: z.string().uuid(),
    resourceUid: z.string().min(1).max(128),
    environmentGeneration: z.number().int().safe().positive(),
  })
  .strict();
export type RuntimeExecutionSandbox = z.infer<typeof RuntimeExecutionSandboxSchema>;

export const RuntimeExecutionOpenRequestSchema = z
  .object({
    type: z.literal("runtime:execution:open"),
    requestId,
    sessionId: RuntimeOpaqueIdSchema,
    agentId: RuntimeOpaqueIdSchema,
    placementGeneration: z.number().int().safe().positive(),
    runId: z.string().uuid(),
    source: RuntimeExecutionSourceSchema,
    sandbox: RuntimeExecutionSandboxSchema.optional(),
    /**
     * Optional platform services the Client opts into (currently only `web`). Sent only when the
     * `runtime.webTools` capability was negotiated; older peers never see or accept this field.
     */
    services: z.array(RuntimeExecutionServiceRequestSchema).max(4).optional(),
  })
  .strict();
export type RuntimeExecutionOpenRequest = z.infer<typeof RuntimeExecutionOpenRequestSchema>;

const cliOutboxContext = RuntimeImOutboxContextSchema.optional();

export const RuntimeFeishuCliMetadataSchema = z
  .object({
    provider: z.literal("feishu"),
    appId: z.string().max(512),
    teamBrand: z.enum(["feishu", "lark"]),
    outboxContext: cliOutboxContext,
  })
  .strict();
export type RuntimeFeishuCliMetadata = z.infer<typeof RuntimeFeishuCliMetadataSchema>;

export const RuntimeSlackCliMetadataSchema = z
  .object({
    provider: z.literal("slack"),
    teamId: z.string().max(255),
    botUserId: z.string().max(255),
    outboxContext: cliOutboxContext,
  })
  .strict();
export type RuntimeSlackCliMetadata = z.infer<typeof RuntimeSlackCliMetadataSchema>;

export const RuntimeGitHubCliRepositorySchema = z
  .object({
    repositoryId: z.string().min(1).max(128),
    fullName: z.string().min(1).max(255),
    role: GitHubRepositoryRoleSchema,
    access: GitHubRepositoryAccessSchema,
    branch: GitBranchRefSchema.optional(),
    publish: GitHubRepositoryPublishModeSchema.optional(),
    workBranchPrefix: z
      .string()
      .max(160)
      .regex(/^refs\/heads\/opentag\/[0-9a-f-]{36}\/(?:code|context_tree)\/$/)
      .optional(),
  })
  .strict();
export type RuntimeGitHubCliRepository = z.infer<typeof RuntimeGitHubCliRepositorySchema>;

export const RuntimeGitHubCliMetadataSchema = z
  .object({
    provider: z.literal("github"),
    connectionId: z.string().min(1).max(128),
    repositories: z.array(RuntimeGitHubCliRepositorySchema).max(RUNTIME_CLI_METADATA_MAX_REPOSITORIES),
  })
  .strict();
export type RuntimeGitHubCliMetadata = z.infer<typeof RuntimeGitHubCliMetadataSchema>;

/**
 * Provider-discriminated, bounded non-secret CLI metadata. A provider variant carries only what
 * the native CLI needs (identity labels and repo scope); it never contains tokens, secrets,
 * signed URLs, or tenant material.
 */
export const RuntimeProviderCliMetadataSchema = z
  .discriminatedUnion("provider", [
    RuntimeFeishuCliMetadataSchema,
    RuntimeSlackCliMetadataSchema,
    RuntimeGitHubCliMetadataSchema,
  ])
  .superRefine((cli, context) => {
    if ("outboxContext" in cli && cli.outboxContext && cli.outboxContext.provider !== cli.provider) {
      context.addIssue({
        code: "custom",
        path: ["outboxContext", "provider"],
        message: "The outbox context provider must match the CLI metadata provider",
      });
    }
  });
export type RuntimeProviderCliMetadata = z.infer<typeof RuntimeProviderCliMetadataSchema>;

export const RuntimeExecutionProviderSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("feishu"), bindingId, cli: RuntimeFeishuCliMetadataSchema }).strict(),
  z.object({ provider: z.literal("slack"), bindingId, cli: RuntimeSlackCliMetadataSchema }).strict(),
  z.object({ provider: z.literal("github"), bindingId, cli: RuntimeGitHubCliMetadataSchema }).strict(),
]);
export type RuntimeExecutionProvider = z.infer<typeof RuntimeExecutionProviderSchema>;

export const RuntimeExecutionOpenRejectCodeSchema = z.enum([
  "execution_not_ready",
  "execution_source_invalid",
  "execution_authority_denied",
  "placement_stale",
  "agent_mismatch",
  "sandbox_mismatch",
  "capability_unsupported",
  "owner_unavailable",
]);
export type RuntimeExecutionOpenRejectCode = z.infer<typeof RuntimeExecutionOpenRejectCodeSchema>;

export const RuntimeExecutionOpenResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      type: z.literal("runtime:execution:result"),
      requestId,
      status: z.literal("succeeded"),
      executionId,
      expiresAt: isoDateTime,
      providers: z.array(RuntimeExecutionProviderSchema).max(16),
      /**
       * E8: the managed Session's CLI proof, minted at the actual execution open for a Cloud
       * collaboration-negotiated connection. Present only on a succeeded open of a Session work
       * source; the trusted Runner relays it to the worker ephemerally and never journals it.
       */
      sessionCliProof: SessionCliProofGrantSchema.optional(),
      /**
       * Granted platform services with their exact authorized scopes. Present only when the
       * `runtime.webTools` capability was negotiated; an empty providers list with a non-empty
       * services list is a real, authorized execution.
       */
      services: z.array(RuntimeExecutionServiceSchema).max(4).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("runtime:execution:result"),
      requestId,
      status: z.literal("rejected"),
      code: RuntimeExecutionOpenRejectCodeSchema,
    })
    .strict(),
]);
export type RuntimeExecutionOpenResult = z.infer<typeof RuntimeExecutionOpenResultSchema>;

export const RuntimeCredentialAcquireRequestSchema = z
  .object({
    type: z.literal("runtime:credential:acquire"),
    requestId,
    executionId,
    provider: RuntimeCredentialProviderSchema,
    bindingId,
  })
  .strict();
export type RuntimeCredentialAcquireRequest = z.infer<typeof RuntimeCredentialAcquireRequestSchema>;

export const RuntimeCredentialRenewRequestSchema = z
  .object({
    type: z.literal("runtime:credential:renew"),
    requestId,
    executionId,
    grantId,
  })
  .strict();
export type RuntimeCredentialRenewRequest = z.infer<typeof RuntimeCredentialRenewRequestSchema>;

export const RuntimeCredentialRejectCodeSchema = z.enum([
  "execution_unknown",
  "execution_closed",
  "execution_expired",
  "credential_scope_denied",
  "credential_stale",
  "binding_inactive",
  "provider_mismatch",
  "grant_mismatch",
  "owner_unavailable",
]);
export type RuntimeCredentialRejectCode = z.infer<typeof RuntimeCredentialRejectCodeSchema>;

export const RuntimeCredentialResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      type: z.literal("runtime:credential:result"),
      requestId,
      status: z.literal("succeeded"),
      executionId,
      grantId,
      provider: RuntimeCredentialProviderSchema,
      bindingId,
      opaqueToken,
      expiresAt: isoDateTime,
      refreshAfter: isoDateTime,
      scopeHash: scopeDigest,
      authorizationRevision: revisionString,
      credentialGeneration: revisionString,
      cli: RuntimeProviderCliMetadataSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("runtime:credential:result"),
      requestId,
      status: z.literal("rejected"),
      code: RuntimeCredentialRejectCodeSchema,
    })
    .strict(),
]);
export type RuntimeCredentialResult = z.infer<typeof RuntimeCredentialResultSchema>;

export const RuntimeExecutionCloseRequestSchema = z
  .object({
    type: z.literal("runtime:execution:close"),
    requestId,
    executionId,
  })
  .strict();
export type RuntimeExecutionCloseRequest = z.infer<typeof RuntimeExecutionCloseRequestSchema>;

export const RuntimeExecutionClosedResultSchema = z
  .object({
    type: z.literal("runtime:execution:closed"),
    requestId,
    executionId,
    status: z.enum(["succeeded", "rejected"]),
    code: z.enum(["execution_unknown", "owner_unavailable"]).optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.status === "rejected" && !frame.code) {
      context.addIssue({ code: "custom", path: ["code"], message: "A rejected close requires a code" });
    }
    if (frame.status === "succeeded" && frame.code) {
      context.addIssue({ code: "custom", path: ["code"], message: "A succeeded close forbids a code" });
    }
  });
export type RuntimeExecutionClosedResult = z.infer<typeof RuntimeExecutionClosedResultSchema>;

export const RuntimeProxyTicketRejectCodeSchema = z.enum([
  "execution_unknown",
  "execution_closed",
  "capability_unsupported",
  "owner_unavailable",
]);
export type RuntimeProxyTicketRejectCode = z.infer<typeof RuntimeProxyTicketRejectCodeSchema>;

export const RuntimeProxyTicketRequestSchema = z
  .object({
    type: z.literal("runtime:proxy:ticket"),
    requestId,
    executionId,
  })
  .strict();
export type RuntimeProxyTicketRequest = z.infer<typeof RuntimeProxyTicketRequestSchema>;

export const RuntimeProxyTicketResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      type: z.literal("runtime:proxy:ticket:result"),
      requestId,
      status: z.literal("succeeded"),
      executionId,
      ticket,
      expiresAt: isoDateTime,
      path: z.literal(RUNTIME_PROVIDER_PROXY_PATH),
    })
    .strict(),
  z
    .object({
      type: z.literal("runtime:proxy:ticket:result"),
      requestId,
      status: z.literal("rejected"),
      code: RuntimeProxyTicketRejectCodeSchema,
    })
    .strict(),
]);
export type RuntimeProxyTicketResult = z.infer<typeof RuntimeProxyTicketResultSchema>;

export const RuntimeMcpGatewayRejectCodeSchema = z.enum([
  "execution_unknown",
  "execution_closed",
  "capability_unsupported",
  "service_not_granted",
  "owner_unavailable",
]);
export type RuntimeMcpGatewayRejectCode = z.infer<typeof RuntimeMcpGatewayRejectCodeSchema>;

export const RuntimeMcpGatewayRequestSchema = z
  .object({
    type: z.literal("runtime:mcp:gateway"),
    requestId,
    executionId,
  })
  .strict();
export type RuntimeMcpGatewayRequest = z.infer<typeof RuntimeMcpGatewayRequestSchema>;

/**
 * The MCP gateway bearer for one execution.
 *
 * Its own frame rather than a field on the execution-open result, because the open result has never
 * carried a secret and both existing secrets in this protocol — capability tokens and proxy tickets
 * — are fetched this way. Only the path travels; the Client composes the URL against the server
 * origin it already pinned, so the Server never names a destination the Client will dial.
 */
export const RuntimeMcpGatewayResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      type: z.literal("runtime:mcp:gateway:result"),
      requestId,
      status: z.literal("succeeded"),
      executionId,
      token: opaqueToken,
      expiresAt: isoDateTime,
      path: z.literal(MCP_GATEWAY_PATH),
    })
    .strict(),
  z
    .object({
      type: z.literal("runtime:mcp:gateway:result"),
      requestId,
      status: z.literal("rejected"),
      code: RuntimeMcpGatewayRejectCodeSchema,
    })
    .strict(),
]);
export type RuntimeMcpGatewayResult = z.infer<typeof RuntimeMcpGatewayResultSchema>;

export const RuntimeCredentialRevokedCodeSchema = z.enum([
  "execution_closed",
  "connection_replaced",
  "authorization_revoked",
  "policy_changed",
  "owner_lost",
]);
export type RuntimeCredentialRevokedCode = z.infer<typeof RuntimeCredentialRevokedCodeSchema>;

export const RuntimeCredentialRevokedFrameSchema = z
  .object({
    type: z.literal("runtime:credential:revoked"),
    executionId,
    code: RuntimeCredentialRevokedCodeSchema,
  })
  .strict();
export type RuntimeCredentialRevokedFrame = z.infer<typeof RuntimeCredentialRevokedFrameSchema>;

export const RuntimeCredentialClientFrameSchema = z.discriminatedUnion("type", [
  RuntimeExecutionOpenRequestSchema,
  RuntimeCredentialAcquireRequestSchema,
  RuntimeCredentialRenewRequestSchema,
  RuntimeExecutionCloseRequestSchema,
  RuntimeProxyTicketRequestSchema,
  RuntimeMcpGatewayRequestSchema,
]);
export type RuntimeCredentialClientFrame = z.infer<typeof RuntimeCredentialClientFrameSchema>;

export const RuntimeCredentialServerFrameSchema = z.discriminatedUnion("type", [
  RuntimeExecutionOpenResultSchema,
  RuntimeCredentialResultSchema,
  RuntimeExecutionClosedResultSchema,
  RuntimeProxyTicketResultSchema,
  RuntimeMcpGatewayResultSchema,
  RuntimeCredentialRevokedFrameSchema,
]);
export type RuntimeCredentialServerFrame = z.infer<typeof RuntimeCredentialServerFrameSchema>;

/* ---------------------------------- data plane ---------------------------------- */

const streamIdSchema = z.number().int().min(1).max(0x7fffffff);
const streamCreditBytesSchema = z
  .number()
  .int()
  .min(1)
  .max(PROVIDER_PROXY_INITIAL_CREDIT_BYTES * 4);
const streamMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const streamPathSchema = byteString(8192, "The provider path exceeds the 8 KiB limit", 1);
const streamHeadersSchema = z.record(
  z.string().min(1).max(128),
  byteString(8192, "A header value exceeds the 8 KiB limit"),
);

export const RuntimeProviderProxyAuthFrameSchema = z
  .object({
    type: z.literal("auth"),
    ticket,
  })
  .strict();
export type RuntimeProviderProxyAuthFrame = z.infer<typeof RuntimeProviderProxyAuthFrameSchema>;

export const RuntimeProviderProxyOpenFrameSchema = z
  .object({
    type: z.literal("open"),
    streamId: streamIdSchema,
    capability: opaqueToken,
    provider: RuntimeCredentialProviderSchema,
    bindingId,
    method: streamMethodSchema,
    path: streamPathSchema,
    headers: streamHeadersSchema,
  })
  .strict();
export type RuntimeProviderProxyOpenFrame = z.infer<typeof RuntimeProviderProxyOpenFrameSchema>;

export const RuntimeProviderProxyReadyFrameSchema = z
  .object({
    type: z.literal("ready"),
    executionId,
  })
  .strict();
export type RuntimeProviderProxyReadyFrame = z.infer<typeof RuntimeProviderProxyReadyFrameSchema>;

export const RuntimeProviderProxyResponseFrameSchema = z
  .object({
    type: z.literal("response"),
    streamId: streamIdSchema,
    status: z.number().int().min(100).max(599),
    headers: streamHeadersSchema,
  })
  .strict();
export type RuntimeProviderProxyResponseFrame = z.infer<typeof RuntimeProviderProxyResponseFrameSchema>;

export const RuntimeProviderProxyEndFrameSchema = z
  .object({
    type: z.literal("end"),
    streamId: streamIdSchema,
  })
  .strict();
export type RuntimeProviderProxyEndFrame = z.infer<typeof RuntimeProviderProxyEndFrameSchema>;

export const RuntimeProviderProxyCancelFrameSchema = z
  .object({
    type: z.literal("cancel"),
    streamId: streamIdSchema,
    code: z.string().min(1).max(128).optional(),
  })
  .strict();
export type RuntimeProviderProxyCancelFrame = z.infer<typeof RuntimeProviderProxyCancelFrameSchema>;

export const RuntimeProviderProxyCreditFrameSchema = z
  .object({
    type: z.literal("credit"),
    streamId: streamIdSchema,
    bytes: streamCreditBytesSchema,
  })
  .strict();
export type RuntimeProviderProxyCreditFrame = z.infer<typeof RuntimeProviderProxyCreditFrameSchema>;

export const RuntimeProviderProxyErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    streamId: streamIdSchema,
    code: z.string().min(1).max(128),
  })
  .strict();
export type RuntimeProviderProxyErrorFrame = z.infer<typeof RuntimeProviderProxyErrorFrameSchema>;

export const RuntimeProviderProxyClientFrameSchema = z.discriminatedUnion("type", [
  RuntimeProviderProxyOpenFrameSchema,
  RuntimeProviderProxyEndFrameSchema,
  RuntimeProviderProxyCancelFrameSchema,
  RuntimeProviderProxyCreditFrameSchema,
]);
export type RuntimeProviderProxyClientFrame = z.infer<typeof RuntimeProviderProxyClientFrameSchema>;

export const RuntimeProviderProxyServerFrameSchema = z.discriminatedUnion("type", [
  RuntimeProviderProxyReadyFrameSchema,
  RuntimeProviderProxyResponseFrameSchema,
  RuntimeProviderProxyEndFrameSchema,
  RuntimeProviderProxyCancelFrameSchema,
  RuntimeProviderProxyCreditFrameSchema,
  RuntimeProviderProxyErrorFrameSchema,
]);
export type RuntimeProviderProxyServerFrame = z.infer<typeof RuntimeProviderProxyServerFrameSchema>;

/**
 * Binary data framing: a 4-byte big-endian uint32 stream identifier followed by 1..65536 payload
 * bytes. Returns `undefined` for malformed frames so callers can fail the connection closed.
 */
export function encodeProviderProxyDataFrame(streamId: number, payload: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(streamId) || streamId < 1 || streamId > 0x7fffffff) {
    throw new Error("The provider proxy stream id is out of range");
  }
  if (payload.byteLength < 1 || payload.byteLength > PROVIDER_PROXY_CHUNK_MAX_BYTES) {
    throw new Error("The provider proxy chunk size is out of range");
  }
  const frame = new Uint8Array(payload.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, streamId, false);
  frame.set(payload, 4);
  return frame;
}

export function decodeProviderProxyDataFrame(frame: Uint8Array): { streamId: number; payload: Uint8Array } | undefined {
  if (frame.byteLength < 5 || frame.byteLength > PROVIDER_PROXY_MAX_FRAME_BYTES) return undefined;
  const streamId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  if (streamId < 1 || streamId > 0x7fffffff) return undefined;
  return { streamId, payload: frame.subarray(4) };
}
