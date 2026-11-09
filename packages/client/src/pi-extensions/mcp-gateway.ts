/** Execution-scoped MCP credentials stay in memory, separate from native MCP configuration. */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { createPiDiagnosticStderrWriter, PI_STARTUP_TIMING_PREFIX } from "../observability/pi-diagnostics.js";

const loadStarted = performance.now();
const writeStartupTiming =
  process.env.OPENTAG_PI_STARTUP_DIAGNOSTICS === "1" ? createPiDiagnosticStderrWriter(process.stderr) : undefined;
function startupTiming(name: "mcpGatewayLoadMs" | "mcpGatewaySessionStartMs", started: number): void {
  try {
    writeStartupTiming?.(`${PI_STARTUP_TIMING_PREFIX}${name}=${(performance.now() - started).toFixed(3)}\n`);
  } catch {
    // Losing the diagnostic pipe must not affect gateway initialization or hide its error.
  }
}

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
// Jiti also transforms dynamic .mjs imports; the compiled Cloud adapter must use Node's native loader.
const adapter = (
  basename(adapterEntry) === "opentag-runtime.mjs"
    ? createRequire(import.meta.url)(adapterEntry)
    : await import(pathToFileURL(adapterEntry).href)
) as {
  createMcpAdapter(options: {
    config: { mcpServers: Record<string, typeof definition>; settings: Record<string, unknown> };
  }): (pi: ExtensionAPI) => void;
  registerMcpServer(options: { pi: ExtensionAPI; name: string; definition: typeof definition }): Registration;
};

startupTiming("mcpGatewayLoadMs", loadStarted);

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
  async function startGateway(event: SessionStartEvent, context: ExtensionContext): Promise<void> {
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
  }
  pi.on("session_start", async (event, context) => {
    const started = performance.now();
    try {
      await startGateway(event, context);
    } finally {
      startupTiming("mcpGatewaySessionStartMs", started);
    }
  });
}
