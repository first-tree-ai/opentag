import type { MCPAvailableServer } from "@opentag/shared";
import { type Command, Option } from "commander";
import { formatAgent } from "../../core/agent/formatting.js";
import {
  runAgentSelfMcpAttach,
  runAgentSelfMcpAvailable,
  runAgentSelfMcpDetach,
  runAgentSelfMcpEnable,
  runAgentSelfMcpList,
  runAgentSelfShow,
  runAgentSelfUpdate,
} from "../../core/agent/self.js";
import { executeCommand } from "../../core/command/policy.js";
import { formatAgentMcpServers, formatAgentServerRow } from "../../core/mcp/shared.js";

interface JsonOption {
  json?: boolean;
}

/**
 * `agent self` — the running Agent inspects and changes its own configuration.
 *
 * Available only inside an OpenTag-managed Agent Session: the Session proof names the Agent, so no
 * command takes an Agent id. The surface is narrower than `agent update` / `agent mcp` on purpose;
 * display name, receive mode, Turn duration, MCP endpoint overrides, and MCP credentials stay with
 * the Account.
 */
export function registerAgentSelfCommands(agent: Command): void {
  const self = agent
    .command("self")
    .description("Inspect and change this Agent's own configuration (inside a managed Session only)");

  self
    .command("show")
    .description("Show this Agent's configuration, including instructions and model")
    .option("--json", "print JSON")
    .action(async (options: JsonOption) => {
      process.exitCode = await executeCommand(() => runAgentSelfShow(), {
        json: options.json === true,
        formatValue: formatAgent,
        phase: "request",
      });
    });

  self
    .command("update")
    .description(
      "Change this Agent's instructions, model, or reasoning effort; the next Turn starts a new provider conversation",
    )
    .addOption(new Option("--model <model>", "exact model ID for this Agent's runtime").conflicts("clearModel"))
    .addOption(new Option("--clear-model", "let the runtime manage model selection").conflicts("model"))
    .addOption(
      new Option("--reasoning-effort <effort>", "reasoning effort for this Agent's runtime").conflicts(
        "clearReasoningEffort",
      ),
    )
    .addOption(
      new Option("--clear-reasoning-effort", "let the runtime manage reasoning effort").conflicts("reasoningEffort"),
    )
    .addOption(new Option("--instructions <text>", "replace this Agent's instructions").conflicts("instructionsFile"))
    .addOption(
      new Option("--instructions-file <path>", "replace instructions from a UTF-8 file").conflicts("instructions"),
    )
    .option("--json", "print JSON")
    .action(async (options) => {
      process.exitCode = await executeCommand(
        () =>
          runAgentSelfUpdate({
            model: options.model,
            clearModel: options.clearModel,
            reasoningEffort: options.reasoningEffort,
            clearReasoningEffort: options.clearReasoningEffort,
            instructions: options.instructions,
            instructionsFile: options.instructionsFile,
          }),
        { json: options.json === true, formatValue: formatAgent, phase: "request" },
      );
    });

  registerAgentSelfMcpCommands(self);
}

function registerAgentSelfMcpCommands(self: Command): void {
  const mcp = self.command("mcp").description("Manage the MCP Servers this Agent mounts");

  mcp
    .command("list")
    .description("List the MCP Servers this Agent mounts")
    .option("--json", "print JSON")
    .action(async (options: JsonOption) => {
      process.exitCode = await executeCommand(() => runAgentSelfMcpList(), {
        json: options.json === true,
        formatValue: formatAgentMcpServers,
        phase: "request",
      });
    });

  mcp
    .command("available")
    .description("List Account MCP Servers this Agent does not mount yet")
    .option("--json", "print JSON")
    .action(async (options: JsonOption) => {
      process.exitCode = await executeCommand(() => runAgentSelfMcpAvailable(), {
        json: options.json === true,
        formatValue: formatAvailableServers,
        phase: "request",
      });
    });

  mcp
    .command("attach <server>")
    .description("Mount an Account MCP Server; one that needs a credential must be authorized by a human")
    .option("--disabled", "mount it without enabling it")
    .option("--json", "print JSON")
    .action(async (server: string, options: JsonOption & { disabled?: boolean }) => {
      process.exitCode = await executeCommand(() => runAgentSelfMcpAttach(server, options.disabled !== true), {
        json: options.json === true,
        formatValue: formatAgentServerRow,
        phase: "request",
      });
    });

  mcp
    .command("detach <server>")
    .description("Unmount an MCP Server; this drops this Agent's credential for it")
    .option("--json", "print JSON")
    .action(async (server: string, options: JsonOption) => {
      process.exitCode = await executeCommand(
        async () => {
          const detached = await runAgentSelfMcpDetach(server);
          return `Detached ${detached.name} (${detached.mcpServerId})`;
        },
        { json: options.json === true, phase: "request" },
      );
    });

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    mcp
      .command(`${name} <server>`)
      .description(
        enabled ? "Enable a mounted MCP Server" : "Disable a mounted MCP Server; mount and credential are kept",
      )
      .option("--json", "print JSON")
      .action(async (server: string, options: JsonOption) => {
        process.exitCode = await executeCommand(() => runAgentSelfMcpEnable(server, enabled), {
          json: options.json === true,
          formatValue: formatAgentServerRow,
          phase: "request",
        });
      });
  }
}

function formatAvailableServers(servers: readonly MCPAvailableServer[]): string {
  if (servers.length === 0) return "No unmounted Account MCP Servers";
  return [
    ["NAME", "ID", "DESCRIPTION"].join("\t"),
    ...servers.map((server) => [server.name, server.id, server.description ?? "-"].join("\t")),
  ].join("\n");
}
