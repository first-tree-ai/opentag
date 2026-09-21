import {
  PROVIDER_PROXY_CHUNK_MAX_BYTES,
  PROVIDER_PROXY_HEADER_MAX_BYTES,
  PROVIDER_PROXY_INITIAL_CREDIT_BYTES,
  PROVIDER_PROXY_MAX_FRAME_BYTES,
  PROVIDER_PROXY_MAX_STREAMS_PER_EXECUTION,
  RUNTIME_CAPABILITY,
  RUNTIME_CREDENTIAL_PROVIDERS,
  type RuntimeCredentialProvider,
  type RuntimeCredentialRevokedFrame,
  type RuntimeCredentialServerFrame,
  RuntimeCredentialServerFrameSchema,
  type RuntimeProviderCliMetadata,
  RuntimeProviderProxyReadyFrameSchema,
  RuntimeProviderProxyServerFrameSchema,
} from "@opentag/shared";

/**
 * Client consumption layer for the Shared runtime credential wire contract.
 *
 * The wire authority is `@opentag/shared` `runtime-credentials.ts` (Server workstream).
 * This module re-exports the public Shared definitions the Client relies on and adds
 * only local conveniences (parsing helpers and short aliases). Do not redefine wire
 * shapes here; extend the Shared module through the Server workstream instead.
 */

export type {
  RuntimeCredentialProvider,
  RuntimeCredentialRejectCode,
  RuntimeCredentialResult,
  RuntimeCredentialRevokedCode,
  RuntimeCredentialRevokedFrame,
  RuntimeCredentialServerFrame,
  RuntimeExecutionOpenRejectCode,
  RuntimeExecutionOpenRequest,
  RuntimeExecutionOpenResult,
  RuntimeExecutionProvider,
  RuntimeExecutionSandbox,
  RuntimeExecutionService,
  RuntimeExecutionServiceRequest,
  RuntimeExecutionSource,
  RuntimeMcpGatewayRejectCode,
  RuntimeMcpGatewayRequest,
  RuntimeMcpGatewayResult,
  RuntimeProviderProxyAuthFrame,
  RuntimeProviderProxyCancelFrame,
  RuntimeProviderProxyClientFrame,
  RuntimeProviderProxyCreditFrame,
  RuntimeProviderProxyEndFrame,
  RuntimeProviderProxyErrorFrame,
  RuntimeProviderProxyOpenFrame,
  RuntimeProviderProxyReadyFrame,
  RuntimeProviderProxyResponseFrame,
  RuntimeProviderProxyServerFrame,
  RuntimeProxyTicketRejectCode,
  RuntimeProxyTicketRequest,
  RuntimeProxyTicketResult,
} from "@opentag/shared";
export {
  decodeProviderProxyDataFrame,
  encodeProviderProxyDataFrame,
  FEISHU_TENANT_TOKEN_LOCAL_SENTINEL,
  MCP_GATEWAY_PATH,
  PROVIDER_PROXY_AUTH_TIMEOUT_MS,
  PROVIDER_PROXY_CHUNK_MAX_BYTES,
  PROVIDER_PROXY_HEADER_MAX_BYTES,
  PROVIDER_PROXY_INITIAL_CREDIT_BYTES,
  PROVIDER_PROXY_MAX_FRAME_BYTES,
  PROVIDER_PROXY_MAX_STREAM_OPENS_PER_CONNECTION,
  PROVIDER_PROXY_MAX_STREAMS_PER_EXECUTION,
  PROVIDER_PROXY_STREAM_REVALIDATE_INTERVAL_MS,
  RUNTIME_CREDENTIAL_CAPABILITY_REFRESH_AFTER_MS,
  RUNTIME_CREDENTIAL_CAPABILITY_TTL_MS,
  RUNTIME_CREDENTIAL_PROVIDERS,
  RUNTIME_EXECUTION_MAX_LIFETIME_MS,
  RUNTIME_PROVIDER_ORIGIN_HEADER,
  RUNTIME_PROVIDER_PROXY_PATH,
  RUNTIME_PROXY_TICKET_TTL_MS,
  RUNTIME_VALIDATION_RUN_TTL_MS,
  RuntimeCredentialProviderSchema,
  RuntimeCredentialRevokedFrameSchema,
  RuntimeCredentialServerFrameSchema,
  RuntimeExecutionOpenRequestSchema,
  RuntimeExecutionOpenResultSchema,
  RuntimeExecutionProviderSchema,
  RuntimeExecutionSandboxSchema,
  RuntimeExecutionSourceSchema,
  RuntimeProviderProxyAuthFrameSchema,
  RuntimeProviderProxyCancelFrameSchema,
  RuntimeProviderProxyCreditFrameSchema,
  RuntimeProviderProxyEndFrameSchema,
  RuntimeProviderProxyErrorFrameSchema,
  RuntimeProviderProxyOpenFrameSchema,
  RuntimeProviderProxyReadyFrameSchema,
  RuntimeProviderProxyResponseFrameSchema,
  RuntimeProviderProxyServerFrameSchema,
} from "@opentag/shared";

/** Capability negotiation names offered/negotiated at version 1. */
export const RUNTIME_CREDENTIAL_CAPABILITY = RUNTIME_CAPABILITY.runtimeCredential;
export const RUNTIME_PROVIDER_PROXY_CAPABILITY = RUNTIME_CAPABILITY.providerProxy;
/** The `web_tools_v1` negotiation: both ends speak the fixed web tools protocol at version 1. */
export const RUNTIME_WEB_TOOLS_CAPABILITY = RUNTIME_CAPABILITY.webTools;
/** Both ends speak the inbound MCP gateway contract at version 1. */
export const RUNTIME_MCP_GATEWAY_CAPABILITY = RUNTIME_CAPABILITY.mcpGateway;

/** Short aliases used across the Client runtime modules. */
export const RUNTIME_PROXY_DATA_HEADER_MAX_BYTES = PROVIDER_PROXY_HEADER_MAX_BYTES;
export const RUNTIME_PROXY_DATA_CHUNK_BYTES = PROVIDER_PROXY_CHUNK_MAX_BYTES;
export const RUNTIME_PROXY_DATA_BINARY_FRAME_MAX_BYTES = PROVIDER_PROXY_MAX_FRAME_BYTES;
export const RUNTIME_PROXY_DATA_INITIAL_CREDIT_BYTES = PROVIDER_PROXY_INITIAL_CREDIT_BYTES;
export const RUNTIME_PROXY_DATA_MAX_STREAMS = PROVIDER_PROXY_MAX_STREAMS_PER_EXECUTION;
export type RuntimeProxyProvider = RuntimeCredentialProvider;
export type RuntimeProxyCliMetadata = RuntimeProviderCliMetadata;
export type RuntimeCredentialGrant = Extract<
  import("@opentag/shared").RuntimeCredentialResult,
  { status: "succeeded" }
>;
export type RuntimeCredentialRevoked = RuntimeCredentialRevokedFrame;

/** Local aliases kept for the data-client and public barrel naming. */
export const RuntimeProxyDataReadyFrameSchema = RuntimeProviderProxyReadyFrameSchema;
export const RuntimeProxyDataServerFrameSchema = RuntimeProviderProxyServerFrameSchema;
export const RUNTIME_PROXY_PROVIDERS = RUNTIME_CREDENTIAL_PROVIDERS;

/** Parse one Server business frame; returns undefined for non-credential frames. */
export function parseRuntimeCredentialServerFrame(value: unknown): RuntimeCredentialServerFrame | undefined {
  const parsed = RuntimeCredentialServerFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Stable, secret-free reason for proxy/relay logs and error messages. Exception messages can
 * embed a capability, ticket, or local handle (upstream errors, WebSocket failures, fetch
 * bodies), so only the constructor name plus an optional short string `code` are retained.
 * Unknown thrown values are never stringified.
 */
export function runtimeProxyErrorReason(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UnknownError";
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  const label = typeof name === "string" && name.length > 0 && name.length <= 64 ? name : "Error";
  // Only canonical uppercase system/driver codes survive: capabilities, tickets, and local
  // handles are lowercase opaque strings and must never be echoed into logs.
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? `${label}:${code}` : label;
}
