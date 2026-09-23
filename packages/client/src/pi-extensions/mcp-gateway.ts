/** One OpenTag-owned MCP server for one Pi process. No ambient Pi MCP config is read. */
import { pathToFileURL } from "node:url";

const url = process.env.OPENTAG_MCP_GATEWAY_URL;
const token = process.env.OPENTAG_MCP_GATEWAY_TOKEN;
const adapterEntry = process.env.OPENTAG_PI_MCP_ADAPTER_ENTRY;
if (!url || !token?.startsWith("otmg_") || !adapterEntry) {
  throw new Error("The OpenTag MCP gateway configuration is incomplete");
}
const gateway = new URL(url);
if (!(["https:", "http:"].includes(gateway.protocol) && gateway.pathname === "/api/v1/mcp")) {
  throw new Error("The OpenTag MCP gateway URL is invalid");
}

type AdapterFactory = (options: {
  config: {
    mcpServers: Record<string, Record<string, unknown>>;
    settings: Record<string, unknown>;
  };
}) => (pi: unknown) => void;
const adapter = (await import(pathToFileURL(adapterEntry).href)) as { createMcpAdapter: AdapterFactory };
export default adapter.createMcpAdapter({
  config: {
    mcpServers: {
      "opentag-mcp": {
        url: gateway.toString(),
        auth: "bearer",
        bearerToken: token,
        protocolVersion: "legacy",
        directTools: false,
        exposeResources: false,
        tasks: false,
      },
    },
    settings: { namespaceProxyTools: false, scriptMode: false },
  },
});
