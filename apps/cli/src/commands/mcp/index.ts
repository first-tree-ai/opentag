import type { MCPAgentServer } from "@opentag/shared";
import type { Command } from "commander";
import { executeCommand } from "../../core/command/policy.js";
import {
  promptForBearerKey,
  readBearerKeyFromStdin,
  runAgentMcpAttach,
  runAgentMcpConfig,
  runAgentMcpDetach,
  runAgentMcpEnable,
  runAgentMcpList,
  runMcpAuthorize,
  runMcpCreate,
  runMcpList,
  runMcpProbe,
  runMcpRemove,
  runMcpRevoke,
  runMcpShow,
  runMcpUpdate,
  runMcpUse,
} from "../../core/mcp/operations.js";
import {
  formatAgentMcpServers,
  formatAgentServerRow,
  formatAuthorization,
  formatMcpServer,
  formatMcpServerList,
  formatMcpShow,
  formatProbe,
} from "../../core/mcp/shared.js";
import {
  authKindOf,
  collectOption as collect,
  optionalList,
  optionalNumber,
  optionalString,
  resolveBearerKeySource,
  splitList,
  whenDefined,
  whenTrue,
} from "./options.js";

/**
 * `mcp` — the Account-level Server pool and per-Agent authorization.
 *
 * The Server definition carries no credential and no switch, so there is no `--enable`/`--disable`
 * here: enabling happens per Agent, under `agent mcp`. Every authorization command names its Agent,
 * because authorization is strictly per Agent and there is no Account-level fallback to write to.
 */
export function registerMcpCommand(program: Command): void {
  const mcp = program.command("mcp").description("Manage MCP (Model Context Protocol) Servers");

  mcp
    .command("add")
    .description("Register a shared MCP Server definition")
    .requiredOption("--name <name>", "unique handle within the Account: lowercase letters, numbers, and hyphens")
    .requiredOption("--url <url>", "the MCP endpoint")
    .option("--default-auth <kind>", "prefill for a new authorization: oauth | bearer | none", "oauth")
    /*
     * No `--description` on create: a definition's description is what a probe discovered, and
     * nothing can be probed before the definition exists. The first successful probe fills it in;
     * `mcp update --description` is how an operator replaces it.
     */
    .option("--auth-header <name>", "authorization header name used by a bearer authorization")
    .option("--auth-scheme <scheme>", "scheme prefixed to the bearer value; empty sends it verbatim")
    .option("--extra-header <name=value>", "additional static header sent on every request (repeatable)", collect, [])
    .option("--json", "print JSON")
    .action(async (options: Record<string, unknown>) => {
      process.exitCode = await executeCommand(
        () =>
          runMcpCreate({
            name: String(options.name),
            url: String(options.url),
            defaultAuthKind: authKindOf(options.defaultAuth),
            ...whenDefined("authHeader", optionalString(options.authHeader)),
            ...whenDefined("authScheme", optionalString(options.authScheme)),
            ...whenDefined("extraHeader", optionalList(options.extraHeader)),
          }),
        { json: options.json === true, formatValue: formatMcpServer, phase: "request" },
      );
    });

  mcp
    .command("list")
    .description("List the Account's MCP Server definitions")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      process.exitCode = await executeCommand(() => runMcpList(), {
        json: options.json === true,
        formatValue: formatMcpServerList,
        phase: "request",
      });
    });

  mcp
    .command("show <server>")
    .description("Show one Server definition, and one Agent's effective view with --agent")
    .option("--agent <agent-id>", "also show this Agent's effective configuration and overrides")
    .option("--json", "print JSON")
    .action(async (server: string, options: { agent?: string; json?: boolean }) => {
      process.exitCode = await executeCommand(
        () => runMcpShow(server, options.agent === undefined ? {} : { agentId: options.agent }),
        {
          json: options.json === true,
          formatValue: (value) => formatMcpShow(value),
          phase: "request",
        },
      );
    });

  mcp
    .command("update <server>")
    .description("Edit the shared definition, which affects every Agent that mounts it")
    .option("--description <text>", "override the probed description, at most 1024 bytes")
    .option("--url <url>", "the MCP endpoint")
    .option("--default-auth <kind>", "prefill for a new authorization: oauth | bearer | none")
    .option("--auth-header <name>", "authorization header name used by a bearer authorization")
    .option("--auth-scheme <scheme>", "scheme prefixed to the bearer value; empty sends it verbatim")
    .option("--extra-header <name=value>", "additional static header (repeatable)", collect, [])
    .option("--clear-extra-headers", "remove the definition's extra headers")
    .option("--empty-extra-headers", "same as --clear-extra-headers at the definition level")
    .option("--expected-revision <n>", "require this revision, for optimistic concurrency")
    .option("--json", "print JSON")
    .action(async (server: string, options: Record<string, unknown>) => {
      process.exitCode = await executeCommand(
        () =>
          runMcpUpdate(server, {
            ...whenDefined("description", optionalString(options.description)),
            ...whenDefined("url", optionalString(options.url)),
            ...whenDefined(
              "defaultAuthKind",
              options.defaultAuth === undefined ? undefined : authKindOf(options.defaultAuth),
            ),
            ...whenDefined("authHeader", optionalString(options.authHeader)),
            ...whenDefined("authScheme", optionalString(options.authScheme)),
            ...whenDefined("extraHeader", optionalList(options.extraHeader)),
            ...whenTrue("clearExtraHeaders", options.clearExtraHeaders),
            ...whenTrue("emptyExtraHeaders", options.emptyExtraHeaders),
            ...whenDefined("expectedRevision", optionalNumber(options.expectedRevision)),
          }),
        { json: options.json === true, formatValue: formatMcpServer, phase: "request" },
      );
    });

  mcp
    .command("remove <server>")
    .description("Delete a Server definition; refused while any Agent still mounts it")
    .option("--json", "print JSON")
    .action(async (server: string, options: { json?: boolean }) => {
      process.exitCode = await executeCommand(
        async () => {
          const removed = await runMcpRemove(server);
          return `Removed MCP Server ${removed.name}`;
        },
        { json: options.json === true, phase: "request" },
      );
    });

  mcp
    .command("use <server>")
    .description("Authorize one Agent with a Bearer key, or declare it anonymous")
    .requiredOption("--agent <agent-id>", "the Agent this authorization belongs to")
    .option("--kind <kind>", "bearer | none", "bearer")
    .option("--bearer-key-stdin", "read the key from standard input (preferred)")
    .option("--bearer-key <value>", "UNSAFE: the key as an argument, visible in shell history and ps")
    .option("--json", "print JSON")
    .action(async (server: string, options: Record<string, unknown>) => {
      process.exitCode = await executeCommand(() => runMcpUseWithOptions(String(options.agent), server, options), {
        json: options.json === true,
        formatValue: formatAgentServerRow,
        phase: "request",
      });
    });

  mcp
    .command("authorize <server>")
    .description("Authorize one Agent by OAuth, or declare it anonymous")
    .requiredOption("--agent <agent-id>", "the Agent this authorization belongs to")
    .option("--kind <kind>", "oauth | none; `none` declares an anonymous authorization instead", "oauth")
    .option("--scopes <list>", "comma-separated scopes to request")
    .option("--no-wait", "return as soon as the URL is issued, without waiting for the probe")
    .option("--json", "print JSON")
    .action(async (server: string, options: Record<string, unknown>) => {
      /*
       * `oauth` and `none` are the two kinds this command owns. `none` is an ordinary pick here
       * because it needs nothing from the user, whereas a Bearer authorization needs a key and so
       * has its own command. Both are real rows, so neither is reachable only by implication.
       */
      if (options.kind !== undefined && options.kind !== "oauth" && options.kind !== "none") {
        process.exitCode = await executeCommand(
          async () => {
            throw new Error("--kind must be oauth or none; use `mcp use` to write a Bearer key");
          },
          { json: options.json === true, phase: "validation" },
        );
        return;
      }
      if (options.kind === "none") {
        process.exitCode = await executeCommand(() => runMcpUse(String(options.agent), server, { kind: "none" }), {
          json: options.json === true,
          formatValue: formatAgentServerRow,
          phase: "request",
        });
        return;
      }
      process.exitCode = await executeCommand(
        () =>
          runMcpAuthorize(
            String(options.agent),
            server,
            {
              ...whenDefined("scopes", options.scopes === undefined ? undefined : splitList(String(options.scopes))),
              ...(options.wait === false ? { noWait: true } : {}),
            },
            {
              /*
               * Printed to stderr as soon as it exists, because the wait that follows can run the
               * flow's full ten minutes and this URL is what the user must open to end it. stderr
               * rather than stdout so `--json` still emits exactly one JSON document on stdout.
               */
              onStarted: (started) => {
                process.stderr.write(`Open this URL to authorize:\n${started.authorizationUrl}\n`);
              },
            },
          ),
        { json: options.json === true, formatValue: formatAuthorization, phase: "request" },
      );
    });

  mcp
    .command("revoke <server>")
    .description("Drop one Agent's credential for a Server, keeping the mount")
    .requiredOption("--agent <agent-id>", "the Agent whose authorization is dropped")
    .option("--json", "print JSON")
    .action(async (server: string, options: Record<string, unknown>) => {
      process.exitCode = await executeCommand(() => runMcpRevoke(String(options.agent), server), {
        json: options.json === true,
        formatValue: formatAgentServerRow,
        phase: "request",
      });
    });

  mcp
    .command("probe <server>")
    .description("Re-probe one Agent's credential for a Server, refreshing its tool snapshot")
    .requiredOption("--agent <agent-id>", "the Agent whose credential is used")
    .option("--json", "print JSON")
    .action(async (server: string, options: Record<string, unknown>) => {
      process.exitCode = await executeCommand(() => runMcpProbe(String(options.agent), server), {
        json: options.json === true,
        formatValue: formatProbe,
        phase: "request",
      });
    });
}

/** `agent mcp` — the per-Agent mount, its enable switch, and its overrides. */
export function registerAgentMcpCommands(agentCommand: Command): void {
  const mcp = agentCommand.command("mcp").description("Manage this Agent's MCP Servers");

  mcp
    .command("list <agent-id>")
    .description("List the MCP Servers this Agent mounts, with its four independent states")
    .option("--json", "print JSON")
    .action(async (agentId: string, options: { json?: boolean }) => {
      process.exitCode = await executeCommand(() => runAgentMcpList(agentId), {
        json: options.json === true,
        formatValue: formatAgentMcpServers,
        phase: "request",
      });
    });

  mcp
    .command("attach <agent-id> <server>")
    .description("Mount a Server for this Agent; it may be authorized afterwards")
    .option("--disabled", "mount it without enabling it")
    .option("--json", "print JSON")
    .action(async (agentId: string, server: string, options: { disabled?: boolean; json?: boolean }) => {
      process.exitCode = await executeCommand(() => runAgentMcpAttach(agentId, server, options.disabled !== true), {
        json: options.json === true,
        formatValue: formatAgentServerRow,
        phase: "request",
      });
    });

  mcp
    .command("detach <agent-id> <server>")
    .description("Unmount a Server from this Agent, dropping its credential for this Agent")
    .option("--json", "print JSON")
    .action(async (agentId: string, server: string, options: { json?: boolean }) => {
      process.exitCode = await executeCommand(
        async () => {
          await runAgentMcpDetach(agentId, server);
          return `Detached ${server} from Agent ${agentId}`;
        },
        { json: options.json === true, phase: "request" },
      );
    });

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    mcp
      .command(`${name} <agent-id> <server>`)
      .description(
        enabled
          ? "Enable a mounted Server; the credential is untouched and stays usable"
          : "Disable a mounted Server; the mount and credential are kept",
      )
      .option("--json", "print JSON")
      .action(async (agentId: string, server: string, options: { json?: boolean }) => {
        process.exitCode = await executeCommand(() => runAgentMcpEnable(agentId, server, enabled), {
          json: options.json === true,
          formatValue: formatAgentServerRow,
          phase: "request",
        });
      });
  }

  mcp
    .command("config <agent-id> <server>")
    .description("Write this Agent's overrides of the shared definition")
    .option("--url <url>", "override the endpoint for this Agent")
    .option("--auth-header <name>", "override the bearer authorization header name")
    .option("--auth-scheme <scheme>", "override the bearer scheme; an empty value sends the key verbatim")
    .option("--extra-header <name=value>", "override the extra headers (repeatable)", collect, [])
    .option("--clear-url", "restore the shared endpoint")
    .option("--clear-auth-header", "restore the shared authorization header name")
    .option("--clear-auth-scheme", "restore the shared authorization scheme")
    .option("--clear-extra-headers", "inherit the shared extra headers again")
    .option("--empty-extra-headers", "send no extra headers for this Agent, without touching the shared set")
    .option("--json", "print JSON")
    .action(async (agentId: string, server: string, options: Record<string, unknown>) => {
      process.exitCode = await executeCommand(
        () =>
          runAgentMcpConfig(agentId, server, {
            ...whenDefined("url", optionalString(options.url)),
            ...whenDefined("authHeader", optionalString(options.authHeader)),
            ...whenDefined("authScheme", optionalString(options.authScheme)),
            ...whenDefined("extraHeader", optionalList(options.extraHeader)),
            ...whenTrue("clearUrl", options.clearUrl),
            ...whenTrue("clearAuthHeader", options.clearAuthHeader),
            ...whenTrue("clearAuthScheme", options.clearAuthScheme),
            ...whenTrue("clearExtraHeaders", options.clearExtraHeaders),
            ...whenTrue("emptyExtraHeaders", options.emptyExtraHeaders),
          }),
        { json: options.json === true, formatValue: formatAgentServerRow, phase: "request" },
      );
    });
}

/**
 * `mcp use`: resolve the key source, read the key with the chosen method, then hand one typed call to
 * the core operation, so the command action stays a single expression.
 */
async function runMcpUseWithOptions(
  agentId: string,
  server: string,
  options: Record<string, unknown>,
): Promise<MCPAgentServer> {
  const source = resolveBearerKeySource(options);
  if (source.kind === "none") return await runMcpUse(agentId, server, { kind: "none" });
  if (source.source === "stdin") {
    return await runMcpUse(agentId, server, { kind: "bearer", bearerKey: await readBearerKeyFromStdin() });
  }
  if (source.source === "prompt") {
    return await runMcpUse(agentId, server, { kind: "bearer", bearerKey: await promptForBearerKey() });
  }
  return await runMcpUse(agentId, server, { kind: "bearer", bearerKey: source.value as string });
}
