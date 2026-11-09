import type { CreateMCPServerRequest, MCPServer } from "@opentag/shared/browser";
import { ApiError, browserApi } from "../../api.js";
import { connectionPreset } from "./mcp-connection-model.js";

/** Select a compatible OAuth installation before creating one; names alone never select a source. */
export async function createMcpInstallation(
  input: CreateMCPServerRequest,
  create: (input: CreateMCPServerRequest) => Promise<MCPServer>,
  agentId: string,
): Promise<MCPServer> {
  if (input.defaultAuthKind === "oauth") {
    const { server } = await browserApi.reusableMcpInstallation(
      agentId,
      input,
      connectionPreset(input.url)?.oauthScopes,
    );
    if (server) return server;
  }
  return createIndependentInstallation(input, create);
}

async function createIndependentInstallation(
  input: CreateMCPServerRequest,
  create: (input: CreateMCPServerRequest) => Promise<MCPServer>,
) {
  const attemptedNames = new Set<string>();
  let name = input.name;
  for (let attempt = 0; ; attempt++) {
    attemptedNames.add(name.toLowerCase());
    try {
      return await create({ ...input, name });
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.code !== "MCP_SERVER_NAME_CONFLICT" || attempt >= 2) throw cause;
      const { servers } = await browserApi.mcpServers();
      const taken = new Set([...attemptedNames, ...servers.map((server) => server.name.toLowerCase())]);
      for (let suffix = 2; ; suffix++) {
        const tail = `-${suffix}`;
        name = `${input.name.slice(0, 64 - tail.length)}${tail}`;
        if (!taken.has(name.toLowerCase())) break;
      }
    }
  }
}
