/*
 * MCP (Model Context Protocol) management plane.
 *
 * Delivered here: Server definitions, per-Agent mounts with per-Agent overrides, per-Agent
 * authorization (anonymous / Bearer / OAuth), capability probing, and refresh maintenance.
 *
 * Also delivered here: the runtime gateway. An Agent reaches its bound Servers through one inbound
 * MCP endpoint on this Server, which resolves that Agent's own credentials and calls upstream, so no
 * upstream credential is ever delivered to a Provider. See docs/design/mcp-server-integration.md.
 */

export {
  boundedMcpErrorCode,
  boundedMcpSummary,
  isMcpUniqueViolation,
  MCP_ERROR_CODES,
  type MCPErrorCode,
  McpServiceError,
  mcpAuthorizationNotFound,
  mcpBindingNotFound,
  mcpErrorWithDetail,
  mcpServerNotFound,
} from "./errors.js";
export {
  buildMcpAuthHeaders,
  MCP_OAUTH_AUTHORIZATION_HEADER,
  type McpAuthHeaderInput,
  parseExtraHeaders,
  validateAuthHeaderName,
} from "./mcp-auth-headers.js";
export {
  McpAuthorizationService,
  type McpAuthorizationServiceOptions,
  type McpProbeOutcome,
  type ResolvedMcpCredential,
} from "./mcp-authorization-service.js";
export {
  authorizationAadContext,
  type McpAuthorizationBinding,
  type McpAuthorizationCredential,
  McpCredentialCipher,
  type McpEncryptedMaterial,
  type McpRegistrationBinding,
  registrationAadContext,
} from "./mcp-credential-cipher.js";
export {
  dispatchGatewayRequest,
  jsonRpcError,
  MCP_GATEWAY_INSTRUCTIONS_MAX_BYTES,
  type McpGatewayHandlers,
  type McpGatewayReply,
  type McpGatewayRpcRequest,
  parseGatewayRequest,
  toolErrorResult,
} from "./mcp-gateway-protocol.js";
export {
  type McpGatewayCatalog,
  McpGatewayService,
  type McpGatewayServiceOptions,
  type McpGatewayTool,
  type McpGatewayToolCallResult,
} from "./mcp-gateway-service.js";
export {
  McpUpstreamCaller,
  type McpUpstreamCallerOptions,
  type McpUpstreamCallInput,
  type McpUpstreamCallResult,
} from "./mcp-gateway-upstream.js";
export {
  authorizationServerMetadataUrls,
  MCP_OAUTH_STATE_TTL_MS,
  type McpAuthorizationServerMetadata,
  type McpClientCredentials,
  type McpOAuthCallbackQuery,
  McpOAuthClient,
  type McpOAuthOptions,
  type McpProtectedResourceMetadata,
  type McpTokenSet,
  mcpCallbackRedirect,
  newRefreshClaimId,
  parseBearerChallenge,
  protectedResourceMetadataUrls,
  tokenRequestFailure,
} from "./mcp-oauth.js";
export {
  McpOAuthFlowService,
  type McpOAuthFlowServiceOptions,
  normalizeResource,
  orderIssuers,
  type StartedMcpOAuth,
} from "./mcp-oauth-flow-service.js";
export {
  McpProbe,
  type McpProbeInput,
  type McpProbeOptions,
  type McpProbeResult,
  type McpProbeTool,
} from "./mcp-probe.js";
export {
  MCP_REFRESH_BATCH_SIZE,
  MCP_REFRESH_INTERVAL_MS,
  McpRefreshWorker,
  type McpRefreshWorkerOptions,
  refreshAtFrom,
  refreshLeadMs,
} from "./mcp-refresh-worker.js";
export {
  countLiveBindings,
  liveBindingAgents,
  type McpJoinedBinding,
  McpServerService,
  type McpServerServiceOptions,
  toAuthorizationSummary,
  toProbeSnapshot,
} from "./mcp-server-service.js";
export {
  decodeHeaderValue,
  detectEraFromFailure,
  detectEraFromRpcError,
  encodeHeaderValue,
  invalidatesProtocolEra,
  MCP_ACCEPT_HEADER,
  MCP_RPC_HEADER_MISMATCH,
  MCP_RPC_INVALID_PARAMS,
  MCP_RPC_METHOD_NOT_FOUND,
  MCP_RPC_MISSING_REQUIRED_CLIENT_CAPABILITY,
  MCP_RPC_UNSUPPORTED_PROTOCOL_VERSION,
  type McpCallOptions,
  type McpEraDetection,
  type McpJsonRpcError,
  type McpJsonRpcResult,
  McpTransport,
  McpTransportError,
  type McpTransportOptions,
  negotiateProtocolVersion,
  parseSseResponse,
} from "./mcp-transport.js";
export {
  assertOutboundUrl,
  MCP_DEFAULT_MAX_CONCURRENT_PER_ACCOUNT,
  MCP_DEFAULT_MAX_RESPONSE_BYTES,
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_RUNTIME_MAX_CONCURRENT_PER_ACCOUNT,
  MCP_RUNTIME_TIMEOUT_MS,
  type McpFetchInit,
  type McpFetchResponse,
  McpOutboundFetcher,
  type McpOutboundFetchOptions,
  type McpOutboundPolicy,
} from "./mcp-url-policy.js";
