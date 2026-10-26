import type { OpenTagApi } from "@opentag/client";
import { findMcpCatalogEntry, type McpCatalogEntry, searchMcpCatalog } from "@opentag/mcp-presets";
import {
  type AgentAdminConfig,
  type CreateSelfMCPServerRequest,
  type MCPAgentServer,
  type MCPAuthKind,
  type MCPAvailableServer,
  type SelfMCPOAuthStatus,
  type StartMCPOAuthResponse,
  type UpdateSelfAgentRuntimeConfig,
  UpdateSelfAgentRuntimeConfigSchema,
} from "@opentag/shared";
import { CommandError } from "../command/policy.js";
import { resolveSessionProofContext } from "../session/index.js";
import { assertExclusive, assertInstructionsSource, readInstructions } from "./mutations.js";

/**
 * `agent self`: the Agent reading and changing its own configuration from inside a managed Session.
 *
 * The Session proof is the only credential. No command accepts an Agent id, because the Server
 * resolves the Agent from the proof and a request can never address a different Agent. Outside a
 * managed Session every command fails before any network call; the Account surface
 * (`agent update`, `agent mcp`) is the human-facing equivalent.
 *
 * `mcp search` is the exception: it reads the catalog this repository ships, so it needs neither a
 * Session nor the network. That is what lets an Agent answer "which connector do I need?" before it
 * has registered anything.
 */

export interface AgentSelfApiClient
  extends Pick<
    OpenTagApi,
    | "createRuntimeAgentMcpServer"
    | "deleteRuntimeAgentMcpServerDefinition"
    | "detachRuntimeAgentMcpServer"
    | "getRuntimeAgentConfig"
    | "getRuntimeAgentMcpOAuthStatus"
    | "attachRuntimeAgentMcpServer"
    | "listRuntimeAgentAvailableMcpServers"
    | "listRuntimeAgentMcpServers"
    | "setRuntimeAgentMcpBearerKey"
    | "startRuntimeAgentMcpOAuth"
    | "updateRuntimeAgentConfig"
    | "updateRuntimeAgentMcpBinding"
  > {}

export interface AgentSelfDependencies {
  api?: AgentSelfApiClient;
  environment?: NodeJS.ProcessEnv;
  proof?: string;
}

export interface AgentSelfUpdateOptions extends AgentSelfDependencies {
  clearModel?: boolean;
  clearReasoningEffort?: boolean;
  instructions?: string;
  instructionsFile?: string;
  model?: string;
  reasoningEffort?: string;
}

interface AgentSelfContext {
  api: AgentSelfApiClient;
  proof: string;
}

async function resolveAgentSelfContext(dependencies: AgentSelfDependencies): Promise<AgentSelfContext> {
  if ((dependencies.api && !dependencies.proof) || (dependencies.proof && !dependencies.api)) {
    throw new Error("Agent self command test dependencies must provide both api and proof");
  }
  if (dependencies.api && dependencies.proof) return { api: dependencies.api, proof: dependencies.proof };
  const environment = dependencies.environment ?? process.env;
  if (!environment.OPENTAG_SESSION_PROOF_FILE) {
    throw new CommandError(
      { code: "AGENT_SELF_SESSION_REQUIRED", category: "validation", retryability: "never", phase: "validation" },
      "agent self commands run only inside an openTag-managed Agent Session; use `agent update` or `agent mcp` with an Account login instead",
    );
  }
  const { api, proof } = await resolveSessionProofContext(environment);
  return { api, proof };
}

export async function runAgentSelfShow(dependencies: AgentSelfDependencies = {}): Promise<AgentAdminConfig> {
  const { api, proof } = await resolveAgentSelfContext(dependencies);
  return api.getRuntimeAgentConfig(proof);
}

export async function runAgentSelfUpdate(options: AgentSelfUpdateOptions): Promise<AgentAdminConfig> {
  const runtimeConfig = await selfRuntimeConfig(options);
  const { api, proof } = await resolveAgentSelfContext(options);
  const current = await api.getRuntimeAgentConfig(proof);
  return api.updateRuntimeAgentConfig(proof, { expectedRevision: current.revision, runtimeConfig });
}

export interface AgentSelfMcpListOptions extends AgentSelfDependencies {
  /** 1-based. Paged in the CLI because the runtime endpoint returns the Agent's whole mount list. */
  page?: number;
  limit?: number;
}

export const AGENT_SELF_MCP_LIST_DEFAULT_LIMIT = 20;

export async function runAgentSelfMcpList(options: AgentSelfMcpListOptions = {}): Promise<MCPAgentServer[]> {
  const page = options.page ?? 1;
  const limit = options.limit ?? AGENT_SELF_MCP_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(page) || page < 1)
    throw new CommandError(validationError(), "--page must be a positive integer");
  if (!Number.isInteger(limit) || limit < 1)
    throw new CommandError(validationError(), "--limit must be a positive integer");
  const { api, proof } = await resolveAgentSelfContext(options);
  const { servers } = await api.listRuntimeAgentMcpServers(proof);
  return servers.slice((page - 1) * limit, page * limit);
}

export async function runAgentSelfMcpAvailable(
  dependencies: AgentSelfDependencies = {},
): Promise<MCPAvailableServer[]> {
  const { api, proof } = await resolveAgentSelfContext(dependencies);
  return (await api.listRuntimeAgentAvailableMcpServers(proof)).servers;
}

export async function runAgentSelfMcpAttach(
  reference: string,
  enabled: boolean,
  dependencies: AgentSelfDependencies = {},
): Promise<MCPAgentServer> {
  const { api, proof } = await resolveAgentSelfContext(dependencies);
  const { servers } = await api.listRuntimeAgentAvailableMcpServers(proof);
  const server = servers.find((entry) => entry.id === reference || entry.name === reference);
  if (!server) {
    throw new Error(
      `No unmounted Account MCP Server named or identified by "${reference}"; see agent self mcp available`,
    );
  }
  return api.attachRuntimeAgentMcpServer(proof, { mcpServerId: server.id, enabled });
}

export async function runAgentSelfMcpEnable(
  reference: string,
  enabled: boolean,
  dependencies: AgentSelfDependencies = {},
): Promise<MCPAgentServer> {
  const { api, proof } = await resolveAgentSelfContext(dependencies);
  const mounted = await resolveMounted(api, proof, reference);
  return api.updateRuntimeAgentMcpBinding(proof, mounted.mcpServerId, { enabled });
}

export async function runAgentSelfMcpDetach(
  reference: string,
  dependencies: AgentSelfDependencies = {},
): Promise<MCPAgentServer> {
  const { api, proof } = await resolveAgentSelfContext(dependencies);
  const mounted = await resolveMounted(api, proof, reference);
  await api.detachRuntimeAgentMcpServer(proof, mounted.mcpServerId);
  return mounted;
}

/** One catalog entry as this surface reports it: what to run `add` with, and nothing more. */
export interface AgentSelfMcpPreset {
  id: string;
  name: string;
  title: string;
  url: string | null;
  defaultAuthKind: MCPAuthKind;
  installable: boolean;
  oauthScopes: string[] | null;
}

/**
 * Search the catalog this repository ships.
 *
 * Local and synchronous on purpose: an Agent that must register a connector needs its endpoint and
 * auth method first, and refusing to answer that before a Server definition exists is circular.
 */
export function runAgentSelfMcpSearch(query: string, limit?: number): AgentSelfMcpPreset[] {
  // A caller that types a product name gets that product, not the entries that merely share tokens.
  const named = findMcpCatalogEntry(query.trim());
  const entries = named ? [named] : searchMcpCatalog({ query, ...(limit === undefined ? {} : { limit }) }).entries;
  return entries.map(toPreset);
}

function toPreset(entry: McpCatalogEntry): AgentSelfMcpPreset {
  return {
    id: entry.id,
    name: entry.name,
    title: entry.title.en,
    url: entry.installable && typeof entry.url === "string" ? entry.url : null,
    defaultAuthKind: entry.defaultAuthKind ?? entry.auth.defaultKind,
    installable: entry.installable,
    oauthScopes: entry.oauthScopes ? [...entry.oauthScopes] : null,
  };
}

export interface AgentSelfMcpAddOptions extends AgentSelfDependencies {
  apiKey?: string;
  authKind?: string;
  name: string;
  url: string;
}

/**
 * Register a definition and mount it on this Agent.
 *
 * `authKind` defaults to `bearer` when a key was supplied and to `oauth` otherwise: those are the only
 * combinations the Server accepts, so guessing between them is the one guess that cannot be wrong.
 */
export async function runAgentSelfMcpAdd(options: AgentSelfMcpAddOptions): Promise<MCPAgentServer> {
  const { api, proof } = await resolveAgentSelfContext(options);
  const defaultAuthKind = resolveAuthKind(options.authKind, options.apiKey !== undefined);
  const input: CreateSelfMCPServerRequest = {
    name: options.name,
    url: options.url,
    defaultAuthKind,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
  };
  return api.createRuntimeAgentMcpServer(proof, input);
}

function resolveAuthKind(value: string | undefined, hasApiKey: boolean): MCPAuthKind {
  const kind = value ?? (hasApiKey ? "bearer" : "oauth");
  if (kind === "none") {
    throw new CommandError(
      validationError(),
      "An Agent may not add an MCP Server that requires no credentials; use `mcp add` with an Account login instead",
    );
  }
  if (kind !== "oauth" && kind !== "bearer") {
    throw new CommandError(validationError(), "auth_kind must be oauth or bearer");
  }
  if (hasApiKey && kind !== "bearer") {
    throw new CommandError(validationError(), "--api-key can only be used with auth_kind bearer");
  }
  return kind;
}

/** Unmount, then let the Server drop the definition when no other Agent mounts it. */
export async function runAgentSelfMcpDelete(
  reference: string,
  dependencies: AgentSelfDependencies = {},
): Promise<MCPAgentServer> {
  const { api, proof } = await resolveAgentSelfContext(dependencies);
  const mounted = await resolveMounted(api, proof, reference);
  await api.deleteRuntimeAgentMcpServerDefinition(proof, mounted.mcpServerId);
  return mounted;
}

export interface AgentSelfMcpOAuthUrlOptions extends AgentSelfDependencies {
  scopes?: string[];
}

/** Begin the OAuth flow and return the URL the human must open. */
export async function runAgentSelfMcpGenerateOAuthUrl(
  reference: string,
  options: AgentSelfMcpOAuthUrlOptions = {},
): Promise<{ server: MCPAgentServer } & StartMCPOAuthResponse> {
  const { api, proof } = await resolveAgentSelfContext(options);
  const server = await resolveMounted(api, proof, reference);
  const started = await api.startRuntimeAgentMcpOAuth(proof, server.mcpServerId, {
    ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
  });
  return { server, ...started };
}

export interface AgentSelfMcpOAuthStatusOptions extends AgentSelfDependencies {
  /** Seconds to keep polling; `0` reports the current row and returns. */
  waitSeconds?: number;
  pollIntervalMs?: number;
}

/**
 * Default wait. Long enough for a password plus 2FA on a phone, short enough that a Turn does not
 * stall behind it: the caller reports the URL and lets the human finish the flow out of band.
 */
export const AGENT_SELF_MCP_OAUTH_DEFAULT_WAIT_SECONDS = 45;

/**
 * Report the authorization and probe state, optionally polling until it settles.
 *
 * Settled means `active` plus a finished probe, or any status that can no longer become usable. A
 * timeout is not a failure: it returns the last observation so the caller can tell the human the URL
 * is still valid and re-check later.
 */
export async function runAgentSelfMcpCheckOAuthStatus(
  reference: string,
  options: AgentSelfMcpOAuthStatusOptions = {},
): Promise<SelfMCPOAuthStatus> {
  const { api, proof } = await resolveAgentSelfContext(options);
  const server = await resolveMounted(api, proof, reference);
  const waitSeconds = options.waitSeconds ?? 0;
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new CommandError(validationError(), "--wait must be zero or more seconds");
  }
  const intervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + waitSeconds * 1_000;
  for (;;) {
    const status = await api.getRuntimeAgentMcpOAuthStatus(proof, server.mcpServerId);
    if (isSettled(status) || Date.now() + intervalMs > deadline) return status;
    await sleep(intervalMs);
  }
}

/** Usable, or unable to become usable without another human action. */
function isSettled(status: SelfMCPOAuthStatus): boolean {
  if (status.authStatus === "active" && status.probeState !== "pending") return true;
  return status.authStatus === "expired" || status.authStatus === "revoked" || status.authStatus === "error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validationError() {
  return { code: "VALIDATION_ERROR", category: "validation", retryability: "never", phase: "validation" } as const;
}

async function resolveMounted(api: AgentSelfApiClient, proof: string, reference: string): Promise<MCPAgentServer> {
  const { servers } = await api.listRuntimeAgentMcpServers(proof);
  const match = servers.find((entry) => entry.mcpServerId === reference || entry.name === reference);
  if (!match) throw new Error(`This Agent does not mount an MCP Server named or identified by "${reference}"`);
  return match;
}

async function selfRuntimeConfig(options: AgentSelfUpdateOptions): Promise<UpdateSelfAgentRuntimeConfig> {
  assertInstructionsSource(options);
  assertExclusive(options.model, options.clearModel, "--model", "--clear-model");
  assertExclusive(
    options.reasoningEffort,
    options.clearReasoningEffort,
    "--reasoning-effort",
    "--clear-reasoning-effort",
  );
  const input = {
    ...(options.model !== undefined || options.clearModel ? { model: options.clearModel ? null : options.model } : {}),
    ...(options.reasoningEffort !== undefined || options.clearReasoningEffort
      ? { reasoningEffort: options.clearReasoningEffort ? null : options.reasoningEffort }
      : {}),
    ...(options.instructions !== undefined || options.instructionsFile !== undefined
      ? { instructions: await readInstructions(options) }
      : {}),
  };
  if (Object.keys(input).length === 0) {
    throw new Error("No Agent changes were provided; specify --instructions, --model, or --reasoning-effort");
  }
  return UpdateSelfAgentRuntimeConfigSchema.parse(input);
}
