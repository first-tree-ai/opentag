import { readFile } from "node:fs/promises";
import type { AgentAdminConfig, Computer, ListComputersResponse } from "@opentag/shared";
import {
  CreateAgentRequestSchema,
  CreateAgentRuntimeConfigSchema,
  type UpdateAgentRequest,
  UpdateAgentRequestSchema,
  UpdateAgentRuntimeConfigSchema,
} from "@opentag/shared";
import { selectTeam } from "../selection/team.js";
import { type AgentCommandDependencies, resolveAgentCommandContext } from "./context.js";

export interface AgentCreateOptions extends AgentCommandDependencies {
  allowedTools?: string[];
  computerId?: string;
  displayName: string;
  instructions?: string;
  instructionsFile?: string;
  maxDurationMs?: number | string;
  model?: string;
  name: string;
  reasoningEffort?: string;
  runtimeProvider: string;
  teamName?: string;
}

export interface AgentCreateResult {
  agent: AgentAdminConfig;
  warning?: string;
}

export interface AgentUpdateOptions extends AgentCommandDependencies {
  allowedTools?: string[];
  clearAllowedTools?: boolean;
  clearMaxDuration?: boolean;
  clearModel?: boolean;
  clearReasoningEffort?: boolean;
  displayName?: string;
  instructions?: string;
  instructionsFile?: string;
  maxDurationMs?: number | string;
  model?: string;
  reasoningEffort?: string;
}

export function selectComputer(response: ListComputersResponse, requestedComputerId?: string): Computer {
  if (requestedComputerId) {
    const selected = response.computers.find((computer) => computer.id === requestedComputerId);
    if (!selected) throw new Error(`Computer "${requestedComputerId}" is not owned by the current user`);
    return selected;
  }
  if (response.computers.length === 1) {
    const selected = response.computers[0];
    if (!selected) throw new Error("No Computer is registered; start the daemon first");
    return selected;
  }
  if (response.computers.length === 0) throw new Error("No Computer is registered; start the daemon first");
  throw new Error("Multiple Computers are available; use --computer <uuid>");
}

export async function runAgentCreate(options: AgentCreateOptions): Promise<AgentCreateResult> {
  const runtimeConfig = await createRuntimeConfig(options);
  const { api, accessToken } = await resolveAgentCommandContext(options);
  const [me, computers] = await Promise.all([api.me(accessToken), api.listComputers(accessToken)]);
  const team = selectTeam(me, options.teamName);
  const computer = selectComputer(computers, options.computerId);
  const input = CreateAgentRequestSchema.parse({
    name: options.name,
    displayName: options.displayName,
    runtimeProvider: options.runtimeProvider,
    computerId: computer.id,
    ...(runtimeConfig ? { runtimeConfig } : {}),
  });
  const agent = await api.createAgent(accessToken, team.teamId, input);
  return {
    agent,
    ...(computer.connectionStatus === "offline"
      ? { warning: `Computer ${computer.id} is offline; the Agent configuration was created` }
      : {}),
  };
}

export async function runAgentUpdate(agentId: string, options: AgentUpdateOptions): Promise<AgentAdminConfig> {
  const mutation = await updateMutation(options);
  const { api, accessToken } = await resolveAgentCommandContext(options);
  const current = await api.getAgentConfig(accessToken, agentId);
  const input = UpdateAgentRequestSchema.parse({
    ...mutation,
    expectedRevision: current.revision,
  });
  return api.updateAgent(accessToken, agentId, input);
}

export async function runAgentDelete(agentId: string, options: AgentCommandDependencies = {}): Promise<string> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  await api.deleteAgent(accessToken, agentId);
  return `Deleted Agent ${agentId}`;
}

export async function runAgentSuspend(
  agentId: string,
  options: AgentCommandDependencies = {},
): Promise<AgentAdminConfig> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.suspendAgent(accessToken, agentId);
}

export async function runAgentReactivate(
  agentId: string,
  options: AgentCommandDependencies = {},
): Promise<AgentAdminConfig> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.reactivateAgent(accessToken, agentId);
}

async function createRuntimeConfig(options: AgentCreateOptions) {
  assertInstructionsSource(options);
  const runtimeConfig = {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.instructions !== undefined || options.instructionsFile !== undefined
      ? { instructions: await readInstructions(options) }
      : {}),
    ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
    ...(options.maxDurationMs !== undefined ? { maxDurationMs: parseMaxDuration(options.maxDurationMs) } : {}),
  };
  return Object.keys(runtimeConfig).length > 0 ? CreateAgentRuntimeConfigSchema.parse(runtimeConfig) : undefined;
}

async function updateMutation(options: AgentUpdateOptions): Promise<Omit<UpdateAgentRequest, "expectedRevision">> {
  assertInstructionsSource(options);
  assertExclusive(options.model, options.clearModel, "--model", "--clear-model");
  assertExclusive(
    options.reasoningEffort,
    options.clearReasoningEffort,
    "--reasoning-effort",
    "--clear-reasoning-effort",
  );
  assertExclusive(options.allowedTools, options.clearAllowedTools, "--allowed-tool", "--clear-allowed-tools");
  assertExclusive(options.maxDurationMs, options.clearMaxDuration, "--max-duration-ms", "--clear-max-duration");

  const runtimeConfigInput = {
    ...(options.model !== undefined || options.clearModel ? { model: options.clearModel ? null : options.model } : {}),
    ...(options.reasoningEffort !== undefined || options.clearReasoningEffort
      ? { reasoningEffort: options.clearReasoningEffort ? null : options.reasoningEffort }
      : {}),
    ...(options.instructions !== undefined || options.instructionsFile !== undefined
      ? { instructions: await readInstructions(options) }
      : {}),
    ...(options.allowedTools !== undefined || options.clearAllowedTools
      ? { allowedTools: options.clearAllowedTools ? [] : options.allowedTools }
      : {}),
    ...(options.maxDurationMs !== undefined || options.clearMaxDuration
      ? { maxDurationMs: options.clearMaxDuration ? null : parseMaxDuration(options.maxDurationMs) }
      : {}),
  };
  const runtimeConfig =
    Object.keys(runtimeConfigInput).length > 0 ? UpdateAgentRuntimeConfigSchema.parse(runtimeConfigInput) : undefined;
  if (options.displayName === undefined && runtimeConfig === undefined) {
    throw new Error("No Agent changes were provided; specify a profile or runtime setting option");
  }
  const preflight = UpdateAgentRequestSchema.parse({
    expectedRevision: 1,
    ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
    ...(runtimeConfig ? { runtimeConfig } : {}),
  });
  const { expectedRevision: _expectedRevision, ...mutation } = preflight;
  return mutation;
}

function assertInstructionsSource(options: { instructions?: string; instructionsFile?: string }): void {
  if (options.instructions !== undefined && options.instructionsFile !== undefined) {
    throw new Error("--instructions and --instructions-file cannot be used together");
  }
}

function assertExclusive(value: unknown, clear: boolean | undefined, valueFlag: string, clearFlag: string): void {
  if (value !== undefined && clear) throw new Error(`${valueFlag} and ${clearFlag} cannot be used together`);
}

async function readInstructions(options: { instructions?: string; instructionsFile?: string }): Promise<string> {
  if (options.instructionsFile !== undefined) return readFile(options.instructionsFile, "utf8");
  return options.instructions ?? "";
}

function parseMaxDuration(value: number | string | undefined): number {
  if (value === undefined) throw new Error("--max-duration-ms requires a value");
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return value;
  } else if (/^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("--max-duration-ms must be a positive base-10 safe integer");
}
