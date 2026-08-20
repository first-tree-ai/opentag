import {
  AgentAdminConfigSchema,
  AgentDetailSchema,
  agentByIdPath,
  agentConfigPath,
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingPath,
  type CreateAgentRequest,
  FeishuSetupAttemptSchema,
  feishuSetupAttemptPath,
  ImBindingAdminDetailSchema,
  ImBindingDiagnosticsSchema,
  ImBindingSummarySchema,
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  ListAgentsResponseSchema,
  teamAgentsPath,
  type UpdateAgentRequest,
} from "@opentag/shared/browser";
import type { BrowserTransport } from "./transport.js";

export function createAgentsApi(transport: BrowserTransport) {
  return {
    list: (teamId: string) => transport.request(teamAgentsPath(teamId), ListAgentsResponseSchema),
    get: (agentId: string) => transport.request(agentByIdPath(agentId), AgentDetailSchema),
    config: (agentId: string) => transport.request(agentConfigPath(agentId), AgentAdminConfigSchema),
    create: (teamId: string, input: CreateAgentRequest) =>
      transport.request(teamAgentsPath(teamId), AgentAdminConfigSchema, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", ...transport.csrfHeaders() },
      }),
    update: (agentId: string, input: UpdateAgentRequest) =>
      transport.request(agentByIdPath(agentId), AgentAdminConfigSchema, {
        method: "PATCH",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", ...transport.csrfHeaders() },
      }),
    imBinding: (agentId: string) => transport.requestOptional(agentImBindingPath(agentId), ImBindingSummarySchema),
    imBindingConfig: (agentId: string) =>
      transport.requestOptional(agentImBindingConfigPath(agentId), ImBindingAdminDetailSchema),
    createFeishuSetupAttempt: (agentId: string, intent: "create" | "reauthorize" | "replace" = "create") =>
      transport.request(agentFeishuSetupAttemptsPath(agentId), FeishuSetupAttemptSchema, {
        method: "POST",
        body: JSON.stringify({ intent }),
        headers: { "content-type": "application/json", ...transport.csrfHeaders() },
      }),
    feishuSetupAttempt: (attemptId: string) =>
      transport.request(feishuSetupAttemptPath(attemptId), FeishuSetupAttemptSchema),
    imBindingDiagnostics: (imBindingId: string) =>
      transport.request(imBindingDiagnosticsPath(imBindingId), ImBindingDiagnosticsSchema),
    disableImBinding: (imBindingId: string) =>
      transport.requestNoContent(imBindingDisablePath(imBindingId), {
        method: "POST",
        headers: transport.csrfHeaders(),
      }),
  };
}
