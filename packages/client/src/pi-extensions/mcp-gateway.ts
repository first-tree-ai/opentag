/** Execution-scoped MCP credentials stay in memory, separate from native MCP configuration. */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";

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

const definition = {
  url: gateway.toString(),
  auth: "bearer",
  bearerToken: token,
  protocolVersion: "legacy",
  directTools: false,
  exposeResources: false,
  tasks: false,
};
type StartHandler = (event: SessionStartEvent, context: ExtensionContext) => Promise<unknown> | unknown;
type Registration = { dispose(): Promise<void> };
const adapter = (await import(pathToFileURL(adapterEntry).href)) as {
  createMcpAdapter(options: {
    config: { mcpServers: Record<string, typeof definition>; settings: Record<string, unknown> };
  }): (pi: ExtensionAPI) => void;
  registerMcpServer(options: { pi: ExtensionAPI; name: string; definition: typeof definition }): Registration;
};

function installGateway(pi: ExtensionAPI, name: string): void {
  adapter.createMcpAdapter({
    config: {
      mcpServers: { [name]: definition },
      settings: { namespaceProxyTools: false, scriptMode: false },
    },
  })(pi);
}

export default function gatewayExtension(pi: ExtensionAPI): void {
  if (process.env.OPENTAG_PI_NATIVE_RESOURCES !== "1") {
    installGateway(pi, "opentag-mcp");
    return;
  }
  const name = `g${randomBytes(8).toString("hex")}`;
  let registration: Registration | undefined;
  let fallbackHandlers: StartHandler[] | undefined;
  pi.on("session_shutdown", async () => {
    await registration?.dispose();
    registration = undefined;
  });
  pi.on("session_start", async (event, context) => {
    if (fallbackHandlers) {
      for (const handler of fallbackHandlers) await handler(event, context);
      return;
    }
    if (registration) return;
    // CLI extensions load before native extensions. Wait until all factories have registered.
    try {
      registration = adapter.registerMcpServer({ pi, name, definition });
      return;
    } catch {
      if (
        pi.getAllTools().some((tool) => tool.name === "mcp") ||
        pi.getCommands().some((command) => ["mcp", "pi-mcp", "mcp-auth"].includes(command.name))
      ) {
        context.ui.notify(
          "OpenTag MCP is unavailable: the native MCP extension does not support runtime registration.",
          "warning",
        );
        return;
      }
    }
    // Bootstrap only our new adapter's session_start handlers; never rerun native handlers.
    fallbackHandlers = [];
    const startHandlers = fallbackHandlers;
    const scopedApi = new Proxy(pi, {
      get(target, key) {
        if (key !== "on") return Reflect.get(target, key);
        return (type: string, handler: StartHandler) => {
          if (type === "session_start") startHandlers.push(handler);
          else Reflect.apply(target.on, target, [type, handler]);
        };
      },
    });
    installGateway(scopedApi, name);
    for (const handler of startHandlers) await handler(event, context);
  });
}
