import type { z } from "zod";
import {
  COMPUTER_ACCESS_CAPABILITY_HEADER,
  type ListAccountComputersResponse,
  ListAccountComputersResponseSchema,
} from "./account.js";
import {
  AGENT_ACTIVITY_QUEUED_COUNT_HEADER,
  AGENT_ACTIVITY_QUEUED_COUNT_VERSION,
  AGENT_ACTIVITY_TASK_COUNT_HEADER,
  AGENT_ACTIVITY_TASK_COUNT_VERSION,
  type AgentAdminConfig,
  AgentAdminConfigSchema,
  type AgentDetail,
  AgentDetailSchema,
  type AgentRuntimeTestRequest,
  type AgentRuntimeTestResponse,
  AgentRuntimeTestResponseSchema,
  type AgentUsageDetail,
  AgentUsageDetailSchema,
  type AgentUsageWindowDays,
  type CreateAgentRequest,
  type ListAgentsResponse,
  ListAgentsResponseSchema,
  type RebindAgentComputerRequest,
  type UpdateAgentRequest,
} from "./agent.js";
import { AGENT_STATUS_HEADER, AGENT_STATUS_VERSION } from "./agent-status.js";
import { type MeResponse, MeResponseSchema } from "./auth.js";
import {
  type AccountComputerConnectCodeIssueRequest,
  CLOUD_IDENTITY_CAPABILITY_HEADER,
  type ComputerConnectCodeIssueResponse,
  ComputerConnectCodeIssueResponseSchema,
  type ComputerConnectCodeStatus,
  ComputerConnectCodeStatusSchema,
  PROVIDER_CLI_REASON_V2_HEADER,
  PROVIDER_READINESS_V1_HEADER,
  PROVIDER_READINESS_V2_HEADER,
} from "./computer.js";
import {
  accountComputerConnectCodePath,
  agentByIdPath,
  agentComputerRebindPath,
  agentConfigPath,
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingPath,
  agentMcpAuthorizationOAuthPath,
  agentMcpAuthorizationPath,
  agentMcpProbePath,
  agentMcpServerPath,
  agentMcpServersPath,
  agentReactivatePath,
  agentRuntimeTestPath,
  agentSkillPath,
  agentSkillPresetInstallPath,
  agentSkillPresetsPath,
  agentSkillsPath,
  agentSlackOAuthStartPath,
  agentSuspendPath,
  agentUsagePath,
  feishuSetupAttemptCancelPath,
  feishuSetupAttemptPath,
  HTTP_PATHS,
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  mcpServerPath,
  mcpServersPath,
} from "./http-paths.js";
import {
  type FeishuSetupAttempt,
  FeishuSetupAttemptSchema,
  type ImBindingAdminDetail,
  ImBindingAdminDetailSchema,
  type ImBindingDiagnostics,
  ImBindingDiagnosticsSchema,
  type ImBindingMessagingExpectation,
  type ImBindingSummary,
  ImBindingSummarySchema,
  type StartSlackOAuthRequest,
  type StartSlackOAuthResponse,
  StartSlackOAuthResponseSchema,
} from "./im-binding.js";
import {
  type AttachMCPServerRequest,
  type CreateMCPServerRequest,
  type ListAgentMCPServersResponse,
  ListAgentMCPServersResponseSchema,
  type ListAvailableMCPServersResponse,
  ListAvailableMCPServersResponseSchema,
  type ListMCPServersResponse,
  ListMCPServersResponseSchema,
  type MCPAgentServer,
  MCPAgentServerSchema,
  type MCPProbeResponse,
  MCPProbeResponseSchema,
  type MCPServer,
  type MCPServerDetail,
  MCPServerDetailSchema,
  MCPServerSchema,
  type SetMCPAuthorizationRequest,
  type StartMCPOAuthRequest,
  type StartMCPOAuthResponse,
  StartMCPOAuthResponseSchema,
  type UpdateMCPBindingRequest,
  type UpdateMCPServerRequest,
} from "./mcp.js";
import {
  type ListAgentSkillsResponse,
  ListAgentSkillsResponseSchema,
  type SkillDetail,
  SkillDetailSchema,
  type UpdateSkillRequest,
} from "./skill.js";
import {
  type InstallSkillPresetResponse,
  InstallSkillPresetResponseSchema,
  type ListSkillPresetsResponse,
  ListSkillPresetsResponseSchema,
} from "./skill-preset.js";

export type AccountApiHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AccountApiNoContentEndpoint {
  readonly method: AccountApiHttpMethod;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly jsonBody?: unknown;
}

export interface AccountApiEndpoint<T> extends AccountApiNoContentEndpoint {
  readonly schema: z.ZodType<T>;
}

export interface AccountApiRequestInit {
  readonly method?: Exclude<AccountApiHttpMethod, "GET">;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export function toAccountApiRequestInit(
  endpoint: AccountApiNoContentEndpoint,
  extraHeaders?: Record<string, string>,
): AccountApiRequestInit {
  const hasJsonBody = endpoint.jsonBody !== undefined;
  const headers: Record<string, string> = {
    ...(hasJsonBody ? { "content-type": "application/json" } : {}),
    ...endpoint.headers,
    ...extraHeaders,
  };
  return {
    ...(endpoint.method !== "GET" ? { method: endpoint.method } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(hasJsonBody ? { body: JSON.stringify(endpoint.jsonBody) } : {}),
  };
}

export const accountApiEndpoints = {
  me(): AccountApiEndpoint<MeResponse> {
    return {
      method: "GET",
      path: HTTP_PATHS.me,
      schema: MeResponseSchema,
    };
  },

  issueComputerConnectCode(
    input?: AccountComputerConnectCodeIssueRequest,
  ): AccountApiEndpoint<ComputerConnectCodeIssueResponse> {
    return {
      method: "POST",
      path: HTTP_PATHS.accountComputerConnectCodes,
      ...(input ? { jsonBody: input } : {}),
      schema: ComputerConnectCodeIssueResponseSchema,
    };
  },

  computerConnectCodeStatus(connectCodeId: string): AccountApiEndpoint<ComputerConnectCodeStatus> {
    return {
      method: "GET",
      path: accountComputerConnectCodePath(connectCodeId),
      schema: ComputerConnectCodeStatusSchema,
    };
  },

  listAccountComputers(options?: {
    includeBrowserCapabilities?: boolean;
  }): AccountApiEndpoint<ListAccountComputersResponse> {
    return {
      method: "GET",
      path: HTTP_PATHS.accountComputers,
      headers: {
        [PROVIDER_READINESS_V1_HEADER]: "1",
        [PROVIDER_READINESS_V2_HEADER]: "2",
        [PROVIDER_CLI_REASON_V2_HEADER]: "2",
        ...(options?.includeBrowserCapabilities
          ? {
              [CLOUD_IDENTITY_CAPABILITY_HEADER]: "1",
              [COMPUTER_ACCESS_CAPABILITY_HEADER]: "1",
            }
          : {}),
      },
      schema: ListAccountComputersResponseSchema,
    };
  },

  createAgent(input: CreateAgentRequest): AccountApiEndpoint<AgentAdminConfig> {
    return {
      method: "POST",
      path: HTTP_PATHS.accountAgents,
      jsonBody: input,
      schema: AgentAdminConfigSchema,
    };
  },

  listAgents(options?: { includeActivityAndStatus?: boolean }): AccountApiEndpoint<ListAgentsResponse> {
    return {
      method: "GET",
      path: HTTP_PATHS.accountAgents,
      ...(options?.includeActivityAndStatus
        ? {
            headers: {
              [AGENT_ACTIVITY_TASK_COUNT_HEADER]: AGENT_ACTIVITY_TASK_COUNT_VERSION,
              [AGENT_ACTIVITY_QUEUED_COUNT_HEADER]: AGENT_ACTIVITY_QUEUED_COUNT_VERSION,
              [AGENT_STATUS_HEADER]: AGENT_STATUS_VERSION,
            },
          }
        : {}),
      schema: ListAgentsResponseSchema,
    };
  },

  getAgent(agentId: string, options?: { includeActivity?: boolean }): AccountApiEndpoint<AgentDetail> {
    return {
      method: "GET",
      path: agentByIdPath(agentId),
      ...(options?.includeActivity
        ? {
            headers: {
              [AGENT_ACTIVITY_TASK_COUNT_HEADER]: AGENT_ACTIVITY_TASK_COUNT_VERSION,
              [AGENT_ACTIVITY_QUEUED_COUNT_HEADER]: AGENT_ACTIVITY_QUEUED_COUNT_VERSION,
            },
          }
        : {}),
      schema: AgentDetailSchema,
    };
  },

  getAgentUsage(
    agentId: string,
    windowDays: AgentUsageWindowDays,
    timezone?: string,
  ): AccountApiEndpoint<AgentUsageDetail> {
    return {
      method: "GET",
      path: agentUsagePath(agentId, windowDays, timezone),
      schema: AgentUsageDetailSchema,
    };
  },

  getAgentConfig(agentId: string): AccountApiEndpoint<AgentAdminConfig> {
    return {
      method: "GET",
      path: agentConfigPath(agentId),
      schema: AgentAdminConfigSchema,
    };
  },

  testAgentRuntime(agentId: string, input: AgentRuntimeTestRequest): AccountApiEndpoint<AgentRuntimeTestResponse> {
    return {
      method: "POST",
      path: agentRuntimeTestPath(agentId),
      jsonBody: input,
      schema: AgentRuntimeTestResponseSchema,
    };
  },

  rebindAgentComputer(agentId: string, computerId: string): AccountApiEndpoint<AgentAdminConfig> {
    return {
      method: "POST",
      path: agentComputerRebindPath(agentId),
      jsonBody: { computerId } satisfies RebindAgentComputerRequest,
      schema: AgentAdminConfigSchema,
    };
  },

  updateAgent(agentId: string, input: UpdateAgentRequest): AccountApiEndpoint<AgentAdminConfig> {
    return {
      method: "PATCH",
      path: agentByIdPath(agentId),
      jsonBody: input,
      schema: AgentAdminConfigSchema,
    };
  },

  suspendAgent(agentId: string): AccountApiEndpoint<AgentAdminConfig> {
    return {
      method: "POST",
      path: agentSuspendPath(agentId),
      schema: AgentAdminConfigSchema,
    };
  },

  reactivateAgent(agentId: string): AccountApiEndpoint<AgentAdminConfig> {
    return {
      method: "POST",
      path: agentReactivatePath(agentId),
      schema: AgentAdminConfigSchema,
    };
  },

  deleteAgent(agentId: string): AccountApiNoContentEndpoint {
    return {
      method: "DELETE",
      path: agentByIdPath(agentId),
    };
  },

  getAgentImBinding(agentId: string): AccountApiEndpoint<ImBindingSummary> {
    return {
      method: "GET",
      path: agentImBindingPath(agentId),
      schema: ImBindingSummarySchema,
    };
  },

  getAgentImBindingConfig(agentId: string): AccountApiEndpoint<ImBindingAdminDetail> {
    return {
      method: "GET",
      path: agentImBindingConfigPath(agentId),
      schema: ImBindingAdminDetailSchema,
    };
  },

  createFeishuSetupAttempt(
    agentId: string,
    intent: "create" | "reauthorize" | "replace" = "create",
    expectedMessaging?: ImBindingMessagingExpectation,
  ): AccountApiEndpoint<FeishuSetupAttempt> {
    return {
      method: "POST",
      path: agentFeishuSetupAttemptsPath(agentId),
      jsonBody: {
        intent,
        ...(expectedMessaging ? { expectedMessaging } : {}),
      },
      schema: FeishuSetupAttemptSchema,
    };
  },

  getFeishuSetupAttempt(attemptId: string): AccountApiEndpoint<FeishuSetupAttempt> {
    return {
      method: "GET",
      path: feishuSetupAttemptPath(attemptId),
      schema: FeishuSetupAttemptSchema,
    };
  },

  cancelFeishuSetupAttempt(attemptId: string): AccountApiEndpoint<FeishuSetupAttempt> {
    return {
      method: "POST",
      path: feishuSetupAttemptCancelPath(attemptId),
      schema: FeishuSetupAttemptSchema,
    };
  },

  startSlackOAuth(agentId: string, input: StartSlackOAuthRequest): AccountApiEndpoint<StartSlackOAuthResponse> {
    return {
      method: "POST",
      path: agentSlackOAuthStartPath(agentId),
      jsonBody: input,
      schema: StartSlackOAuthResponseSchema,
    };
  },

  getImBindingDiagnostics(imBindingId: string): AccountApiEndpoint<ImBindingDiagnostics> {
    return {
      method: "GET",
      path: imBindingDiagnosticsPath(imBindingId),
      headers: {
        [PROVIDER_CLI_REASON_V2_HEADER]: "2",
      },
      schema: ImBindingDiagnosticsSchema,
    };
  },

  disableImBinding(imBindingId: string): AccountApiNoContentEndpoint {
    return {
      method: "POST",
      path: imBindingDisablePath(imBindingId),
    };
  },

  listMcpServers(): AccountApiEndpoint<ListMCPServersResponse> {
    return {
      method: "GET",
      path: mcpServersPath(),
      schema: ListMCPServersResponseSchema,
    };
  },

  createMcpServer(input: CreateMCPServerRequest): AccountApiEndpoint<MCPServer> {
    return {
      method: "POST",
      path: mcpServersPath(),
      jsonBody: input,
      schema: MCPServerSchema,
    };
  },

  getMcpServer(mcpServerId: string): AccountApiEndpoint<MCPServerDetail> {
    return {
      method: "GET",
      path: mcpServerPath(mcpServerId),
      schema: MCPServerDetailSchema,
    };
  },

  updateMcpServer(mcpServerId: string, input: UpdateMCPServerRequest): AccountApiEndpoint<MCPServer> {
    return {
      method: "PATCH",
      path: mcpServerPath(mcpServerId),
      jsonBody: input,
      schema: MCPServerSchema,
    };
  },

  removeMcpServer(mcpServerId: string): AccountApiNoContentEndpoint {
    return {
      method: "DELETE",
      path: mcpServerPath(mcpServerId),
    };
  },

  listAgentMcpServers(agentId: string): AccountApiEndpoint<ListAgentMCPServersResponse> {
    return {
      method: "GET",
      path: agentMcpServersPath(agentId),
      schema: ListAgentMCPServersResponseSchema,
    };
  },

  listAvailableMcpServers(agentId: string): AccountApiEndpoint<ListAvailableMCPServersResponse> {
    return {
      method: "GET",
      path: `${agentMcpServersPath(agentId)}/available`,
      schema: ListAvailableMCPServersResponseSchema,
    };
  },

  attachMcpServer(agentId: string, input: AttachMCPServerRequest): AccountApiEndpoint<MCPAgentServer> {
    return {
      method: "POST",
      path: agentMcpServersPath(agentId),
      jsonBody: input,
      schema: MCPAgentServerSchema,
    };
  },

  updateAgentMcpServer(
    agentId: string,
    mcpServerId: string,
    input: UpdateMCPBindingRequest,
  ): AccountApiEndpoint<MCPAgentServer> {
    return {
      method: "PATCH",
      path: agentMcpServerPath(agentId, mcpServerId),
      jsonBody: input,
      schema: MCPAgentServerSchema,
    };
  },

  detachMcpServer(agentId: string, mcpServerId: string): AccountApiNoContentEndpoint {
    return {
      method: "DELETE",
      path: agentMcpServerPath(agentId, mcpServerId),
    };
  },

  setMcpAuthorization(
    agentId: string,
    mcpServerId: string,
    input: SetMCPAuthorizationRequest,
  ): AccountApiEndpoint<MCPAgentServer> {
    return {
      method: "PUT",
      path: agentMcpAuthorizationPath(agentId, mcpServerId),
      jsonBody: input,
      schema: MCPAgentServerSchema,
    };
  },

  revokeMcpAuthorization(
    agentId: string,
    mcpServerId: string,
    expectedOAuthState?: string,
  ): AccountApiEndpoint<MCPAgentServer> {
    return {
      method: "DELETE",
      path: agentMcpAuthorizationPath(agentId, mcpServerId),
      ...(expectedOAuthState !== undefined ? { jsonBody: { expectedOAuthState } } : {}),
      schema: MCPAgentServerSchema,
    };
  },

  startMcpOAuth(
    agentId: string,
    mcpServerId: string,
    input: StartMCPOAuthRequest = {},
  ): AccountApiEndpoint<StartMCPOAuthResponse> {
    return {
      method: "POST",
      path: agentMcpAuthorizationOAuthPath(agentId, mcpServerId),
      jsonBody: input,
      schema: StartMCPOAuthResponseSchema,
    };
  },

  probeMcpServer(agentId: string, mcpServerId: string): AccountApiEndpoint<MCPProbeResponse> {
    return {
      method: "POST",
      path: agentMcpProbePath(agentId, mcpServerId),
      schema: MCPProbeResponseSchema,
    };
  },

  listAgentSkills(agentId: string): AccountApiEndpoint<ListAgentSkillsResponse> {
    return {
      method: "GET",
      path: agentSkillsPath(agentId),
      schema: ListAgentSkillsResponseSchema,
    };
  },

  getAgentSkill(agentId: string, skillId: string): AccountApiEndpoint<SkillDetail> {
    return {
      method: "GET",
      path: agentSkillPath(agentId, skillId),
      schema: SkillDetailSchema,
    };
  },

  updateAgentSkill(agentId: string, skillId: string, input: UpdateSkillRequest): AccountApiEndpoint<SkillDetail> {
    return {
      method: "PATCH",
      path: agentSkillPath(agentId, skillId),
      jsonBody: input,
      schema: SkillDetailSchema,
    };
  },

  removeAgentSkill(agentId: string, skillId: string): AccountApiNoContentEndpoint {
    return {
      method: "DELETE",
      path: agentSkillPath(agentId, skillId),
    };
  },

  listSkillPresets(agentId: string): AccountApiEndpoint<ListSkillPresetsResponse> {
    return {
      method: "GET",
      path: agentSkillPresetsPath(agentId),
      schema: ListSkillPresetsResponseSchema,
    };
  },

  installSkillPreset(agentId: string, presetName: string): AccountApiEndpoint<InstallSkillPresetResponse> {
    return {
      method: "POST",
      path: agentSkillPresetInstallPath(agentId, presetName),
      jsonBody: {},
      schema: InstallSkillPresetResponseSchema,
    };
  },
} as const;
