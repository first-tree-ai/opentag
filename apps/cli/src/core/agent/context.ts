import { AccessTokenProvider, OpenTagApi, readCredentials, resolveOpenTagHome } from "@opentag/client";

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
    | "rebindAgentComputer"
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
  if (options.api && options.accessToken) return { api: options.api, accessToken: options.accessToken };
  if (options.api || options.accessToken) {
    throw new Error("Agent command test dependencies must provide both api and accessToken");
  }

  const home = options.home ?? resolveOpenTagHome();
  const credentials = await readCredentials(home);
  if (!credentials) throw new Error("OpenTag is not logged in; run login first");
  const accessToken = await new AccessTokenProvider({ home }).getAccessToken();
  return { api: new OpenTagApi(credentials.serverUrl), accessToken };
}
