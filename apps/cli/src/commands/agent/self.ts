import type { MCPAvailableServer, SelfMCPOAuthStatus } from "@opentag/shared";
import { type Command, Option } from "commander";
import { formatAgent } from "../../core/agent/formatting.js";
import {
  AGENT_SELF_MCP_OAUTH_DEFAULT_WAIT_SECONDS,
  type AgentSelfMcpPreset,
  runAgentSelfMcpAdd,
  runAgentSelfMcpAttach,
  runAgentSelfMcpAvailable,
  runAgentSelfMcpCheckOAuthStatus,
  runAgentSelfMcpDelete,
  runAgentSelfMcpDetach,
  runAgentSelfMcpEnable,
  runAgentSelfMcpGenerateOAuthUrl,
  runAgentSelfMcpList,
  runAgentSelfMcpSearch,
  runAgentSelfMcpUse,
  runAgentSelfShow,
  runAgentSelfUpdate,
} from "../../core/agent/self.js";
import { executeCommand } from "../../core/command/policy.js";
import { readBearerKeyFromStdin } from "../../core/mcp/operations.js";
import { formatAgentMcpServers, formatAgentServerRow } from "../../core/mcp/shared.js";
import { authKindOf, optionalNumber, splitList, whenDefined } from "../mcp/options.js";
import { registerAgentSelfScheduleCommands } from "./self-schedule.js";

interface JsonOption {
  json?: boolean;
}

/**
 * `agent self` — the running Agent inspects and changes its own configuration.
 *
 * Available only inside an OpenTag-managed Agent Session: the Session proof names the Agent, so no
 * command takes an Agent id. The surface is narrower than `agent update` / `agent mcp` on purpose;
 * display name, receive mode, Turn duration, and endpoint overrides stay with the Account. The MCP
 * subcommands do let an Agent register a Server definition and write its own credential, because
 * that is what makes "connect HubSpot for me" work with no human at an Account login; the limits
 * that keep it bounded are in `docs/system/runtime/agent-self-configuration.md`.
 *
 * The same group is registered at the top level as `self`: inside a managed Session there is no
 * other Agent to disambiguate from, and the shorter form is what the managed prompt shows.
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
  registerAgentSelfScheduleCommands(self);
}

function registerAgentSelfMcpCommands(self: Command): void {
  const mcp = self.command("mcp").description("Manage the MCP Servers this Agent mounts");

  mcp
    .command("search <query>")
    .description("Search the connector catalog for a Server this Agent could add")
    .option("--limit <n>", "maximum number of matches")
    .option("--json", "print JSON")
    .action(async (query: string, options: JsonOption & { limit?: string }) => {
      process.exitCode = await executeCommand(async () => runAgentSelfMcpSearch(query, optionalNumber(options.limit)), {
        json: options.json === true,
        formatValue: formatPresets,
        phase: "validation",
      });
    });

  mcp
    .command("add <name> <url> [auth_kind]")
    .description("Register an MCP Server and mount it on this Agent; oauth needs a human, bearer needs a key")
    .addOption(new Option("--api-key-stdin", "read the Bearer key from standard input (preferred)").conflicts("apiKey"))
    .addOption(
      new Option("--api-key <key>", "UNSAFE: the Bearer key as an argument, visible in shell history and ps").conflicts(
        "apiKeyStdin",
      ),
    )
    .option("--json", "print JSON")
    .action(async (name: string, url: string, authKind: string | undefined, options: RawApiKeyOptions) => {
      process.exitCode = await executeCommand(
        async () =>
          runAgentSelfMcpAdd({
            name,
            url,
            ...whenDefined("authKind", authKind),
            ...whenDefined("apiKey", await readApiKey(options)),
          }),
        { json: options.json === true, formatValue: formatAgentServerRow, phase: "request" },
      );
    });

  mcp
    .command("use <server>")
    .description("Write this Agent's Bearer key for a Server it already mounts; this does not create a definition")
    .addOption(new Option("--api-key-stdin", "read the Bearer key from standard input (preferred)").conflicts("apiKey"))
    .addOption(
      new Option("--api-key <key>", "UNSAFE: the Bearer key as an argument, visible in shell history and ps").conflicts(
        "apiKeyStdin",
      ),
    )
    .option("--json", "print JSON")
    .action(async (server: string, options: RawApiKeyOptions) => {
      process.exitCode = await executeCommand(
        async () => {
          const apiKey = await readApiKey(options);
          if (apiKey === undefined) {
            throw new Error("A credential is required; pass it with --api-key-stdin");
          }
          return runAgentSelfMcpUse(server, apiKey);
        },
        { json: options.json === true, formatValue: formatAgentServerRow, phase: "request" },
      );
    });

  mcp
    .command("delete <server>")
    .description("Unmount an MCP Server, removing this Agent's credential while retaining the Account definition")
    .option("--json", "print JSON")
    .action(async (server: string, options: JsonOption) => {
      process.exitCode = await executeCommand(
        async () => {
          const deleted = await runAgentSelfMcpDelete(server);
          return `Unmounted ${deleted.name} (${deleted.mcpServerId})`;
        },
        { json: options.json === true, phase: "request" },
      );
    });

  mcp
    .command("generate_oauth_url <server>")
    .description("Start the OAuth flow and print the URL a human must open")
    .option("--scopes <list>", "comma-separated scopes to request instead of the catalog's")
    .option("--json", "print JSON")
    .action(async (server: string, options: JsonOption & { scopes?: string }) => {
      process.exitCode = await executeCommand(
        async () => {
          const started = await runAgentSelfMcpGenerateOAuthUrl(server, {
            ...(options.scopes === undefined ? {} : { scopes: splitList(options.scopes) }),
          });
          return {
            server: started.server.name,
            // Not `authorizationUrl`: the CLI's presentation redactor keys on the `authorization`
            // substring and would blank the one value this command exists to print.
            url: started.authorizationUrl,
            expiresAt: started.expiresAt,
          };
        },
        { json: options.json === true, formatValue: formatOAuthUrl, phase: "request" },
      );
    });

  mcp
    .command("check_oauth_status <server>")
    .description("Report whether the OAuth flow finished and which tools the Server now offers")
    .option(
      "--wait [seconds]",
      `poll until the flow settles, for at most this many seconds (${AGENT_SELF_MCP_OAUTH_DEFAULT_WAIT_SECONDS} when omitted)`,
    )
    .option("--json", "print JSON")
    .action(async (server: string, options: JsonOption & { wait?: string | boolean }) => {
      process.exitCode = await executeCommand(
        () => runAgentSelfMcpCheckOAuthStatus(server, { waitSeconds: waitSecondsOf(options.wait) }),
        { json: options.json === true, formatValue: formatOAuthStatus, phase: "request" },
      );
    });

  mcp
    .command("list")
    .description("List the MCP Servers this Agent mounts")
    .option("--page <n>", "1-based page of this Agent's mounts")
    .option("--limit <n>", "mounts per page")
    .option("--json", "print JSON")
    .action(async (options: JsonOption & { limit?: string; page?: string }) => {
      process.exitCode = await executeCommand(
        () =>
          runAgentSelfMcpList({
            ...whenDefined("page", optionalNumber(options.page)),
            ...whenDefined("limit", optionalNumber(options.limit)),
          }),
        {
          json: options.json === true,
          formatValue: formatAgentMcpServers,
          phase: "request",
        },
      );
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

interface RawApiKeyOptions extends JsonOption {
  apiKey?: string;
  apiKeyStdin?: boolean;
}

/**
 * The Bearer key for `mcp add`, from stdin, a hidden prompt, or the visible argument.
 *
 * Absent everywhere means the caller is adding an OAuth Server, whose credential arrives through the
 * flow instead, so this returns `undefined` rather than prompting for a key nobody asked for.
 */
async function readApiKey(options: RawApiKeyOptions): Promise<string | undefined> {
  if (options.apiKeyStdin === true) return await readBearerKeyFromStdin();
  if (options.apiKey !== undefined) return options.apiKey;
  return undefined;
}

/**
 * `--wait` without a value means the default budget; Commander hands that back as `true`.
 *
 * Absent means do not wait at all: a plain `check_oauth_status` is a status read, and a caller that
 * wants to block says so. `--wait 0` is a real request to look once and return.
 */
function waitSecondsOf(value: string | boolean | undefined): number {
  if (value === undefined) return 0;
  if (value === true) return AGENT_SELF_MCP_OAUTH_DEFAULT_WAIT_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--wait must be zero or more seconds");
  return seconds;
}

function formatPresets(presets: readonly AgentSelfMcpPreset[]): string {
  if (presets.length === 0) return "No connector matches that query";
  return [
    ["NAME", "AUTH", "URL", "ID"].join("\t"),
    ...presets.map((preset) =>
      [preset.name, authKindOf(preset.defaultAuthKind), preset.url ?? "-", preset.id].join("\t"),
    ),
  ].join("\n");
}

function formatOAuthUrl(value: { expiresAt: string; server: string; url: string }): string {
  return [`Open this URL to authorize ${value.server}:`, value.url, `It expires at ${value.expiresAt}.`].join("\n");
}

function formatOAuthStatus(status: SelfMCPOAuthStatus): string {
  const head = [
    status.name,
    status.authStatus ?? "none",
    status.probeState ?? "none",
    `${status.toolsCount ?? 0} tools`,
  ].join("\t");
  if (status.failureCode !== null) return `${head}\n${status.failureCode}`;
  if (status.probeError !== null) return `${head}\n${status.probeError}`;
  if (status.tools === null || status.tools.length === 0) return head;
  return [head, ...status.tools.map((tool) => `  ${tool.name}`)].join("\n");
}
