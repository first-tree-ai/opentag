import type { CreateMCPServerRequest, MCPServer } from "@opentag/shared/browser";
import { ApiError, browserApi } from "../../api.js";

/** Create this journey's own definition; name collisions never select another installation. */
export async function createMcpInstallation(
  input: CreateMCPServerRequest,
  create: (input: CreateMCPServerRequest) => Promise<MCPServer>,
): Promise<MCPServer> {
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
