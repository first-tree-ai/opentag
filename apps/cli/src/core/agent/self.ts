import type { OpenTagApi } from "@opentag/client";
import {
  type AgentAdminConfig,
  type MCPAgentServer,
  type MCPAvailableServer,
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
 */

export interface AgentSelfApiClient
  extends Pick<
    OpenTagApi,
    | "getRuntimeAgentConfig"
    | "updateRuntimeAgentConfig"
    | "listRuntimeAgentMcpServers"
    | "listRuntimeAgentAvailableMcpServers"
    | "attachRuntimeAgentMcpServer"
    | "updateRuntimeAgentMcpBinding"
    | "detachRuntimeAgentMcpServer"
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
      "agent self commands run only inside an OpenTag-managed Agent Session; use `agent update` or `agent mcp` with an Account login instead",
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

export async function runAgentSelfMcpList(dependencies: AgentSelfDependencies = {}): Promise<MCPAgentServer[]> {
  const { api, proof } = await resolveAgentSelfContext(dependencies);
  return (await api.listRuntimeAgentMcpServers(proof)).servers;
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
