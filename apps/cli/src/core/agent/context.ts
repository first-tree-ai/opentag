import type { OpenTagApi } from "@opentag/client";
import { resolveCommandContext } from "../command/context.js";

export interface AgentApiClient
  extends Pick<
    OpenTagApi,
    | "createAgent"
    | "listAgents"
    | "getAgent"
    | "getAgentConfig"
    | "updateAgent"
    | "suspendAgent"
    | "reactivateAgent"
    | "deleteAgent"
    | "listAccountComputers"
    | "me"
    | "getAgentImBinding"
    | "getAgentImBindingConfig"
    | "createFeishuSetupAttempt"
    | "getFeishuSetupAttempt"
    | "cancelFeishuSetupAttempt"
    | "getImBindingDiagnostics"
    | "disableImBinding"
  > {}

export interface AgentCommandDependencies {
  accessToken?: string;
  api?: AgentApiClient;
  home?: string;
}

export async function resolveAgentCommandContext(
  options: AgentCommandDependencies,
): Promise<{ accessToken: string; api: AgentApiClient }> {
  if ((options.api && !options.accessToken) || (options.accessToken && !options.api)) {
    throw new Error("Agent command test dependencies must provide both api and accessToken");
  }
  const context = await resolveCommandContext({
    accessToken: options.accessToken,
    api: options.api as OpenTagApi | undefined,
    home: options.home,
    requireAuth: true,
  });
  if (!context.api || !context.accessToken) throw new Error("Command context did not resolve an authenticated API");
  return { api: context.api, accessToken: context.accessToken };
}
