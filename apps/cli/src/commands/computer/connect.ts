import { resolve } from "node:path";
import { resolveOpenTagHome } from "@opentag/client";
import type { LocalComputerPreparationResult } from "@opentag/shared";
import type { Command } from "commander";
import { channelConfig } from "../../core/channel/config.js";
import { resolveChannelEnvironment } from "../../core/channel/environment.js";
import * as commandPolicy from "../../core/command/policy.js";
import { type ComputerConnectResult, runComputerConnect } from "../../core/computer/connect.js";
import { describeConnectFailure, formatConnectFailure } from "../../core/computer/connect-messages.js";
import { formatPreparationResultLines, preparationNextStep } from "../../core/computer/formatting.js";
import {
  daemonServiceCommand,
  failedLocalComputerPreparation,
  LOCAL_COMPUTER_PREPARATION_INCOMPLETE,
  NO_CODE_REUSE_GUIDANCE,
  preparationGuidance,
  runLocalComputerPreparation,
} from "../../core/computer/preparation.js";
import { quotePosix } from "../../core/daemon/service/shared.js";
import { renderProviderCliHumanValue } from "../../core/provider-cli/shared.js";

type ComputerConnectCommandOptions = {
  home?: string;
  server?: string;
  start?: boolean;
  prepareProviderClis?: boolean;
  json?: boolean;
  verbose?: boolean;
  computer?: string;
};

export function registerComputerConnectCommand(computer: Command): void {
  computer
    .command("connect")
    .description("Connect this Computer, check the selected Runtime, and prepare Lark and Slack CLIs")
    .argument("<code>", "one-time Computer connect code")
    .option("--server <url>", "openTag server URL")
    .option("--home <path>", "openTag home directory")
    .option("--computer <id>", "the Computer a repair command restores; stops on any other computer")
    .option("--no-start", "skip only daemon service installation/start")
    .option("--no-prepare-provider-clis", "skip Lark and Slack CLI preparation")
    .option("--json", "print JSON")
    .option("--verbose", "also print each readiness check and preparation step")
    .action(executeComputerConnectCommand);
}

async function executeComputerConnectCommand(code: string, options: ComputerConnectCommandOptions): Promise<void> {
  const environment = resolveChannelEnvironment(process.env);
  const home = resolve(options.home ?? resolveOpenTagHome(environment));
  const connection = await connectOrPresentFailure(code, home, environment, options);
  if (!connection) return;
  if (connection.persistenceError) {
    presentPersistenceFailure(connection, home, options.json === true);
    return;
  }
  if (!connection.agentId) {
    presentOrdinaryConnection(connection, home, options.json === true);
    return;
  }
  const preparationOptions = {
    runtimeProvider: connection.runtimeProvider,
    service: connection.service,
    serviceError: connection.serviceError,
    home,
    env: environment,
    noStart: options.start === false,
    prepareProviderClis: options.prepareProviderClis !== false,
  };
  let preparation: LocalComputerPreparationResult;
  try {
    preparation = await runLocalComputerPreparation({
      ...preparationOptions,
      // Step-by-step preparation lines are diagnostics: shown only when asked for.
      onPhase:
        !options.verbose || options.json
          ? undefined
          : (event) => {
              const provider = event.provider === "feishu" ? "lark" : "slack";
              const detail = event.detail ? ` — ${event.detail}` : "";
              process.stdout.write(`${safeLine(`[im-cli:${provider}] ${event.phase}: ${event.status}${detail}`)}\n`);
            },
    });
  } catch (error) {
    // Preserve the already-saved connection even after a projection failure. Neither exchange
    // nor ensure is repeated here: the one-time code cannot be reused.
    preparation = failedLocalComputerPreparation(preparationOptions, error);
  }
  presentPreparation(connection, preparation, { json: options.json === true, verbose: options.verbose === true });
}

async function connectOrPresentFailure(
  code: string,
  home: string,
  environment: NodeJS.ProcessEnv,
  options: ComputerConnectCommandOptions,
): Promise<ComputerConnectResult | undefined> {
  const serverUrl = options.server ?? environment.OPENTAG_SERVER_URL ?? channelConfig.defaultServerUrl;
  try {
    if (!serverUrl) throw new Error(`The ${channelConfig.channel} channel requires --server for Computer connect`);
    return await runComputerConnect({
      code,
      home,
      noStart: options.start === false,
      serverUrl,
      ...(options.computer ? { expectedComputerId: options.computer } : {}),
    });
  } catch (error) {
    const commandError = commandPolicy.toCommandError(error, "request");
    const exitCode = commandPolicy.commandExitCode(commandError);
    if (options.json) {
      process.exitCode = commandPolicy.presentCommand({ ok: false, error: commandError, exitCode }, { json: true });
    } else {
      const message = describeConnectFailure(commandError, { serverUrl, home });
      const lines = formatConnectFailure(commandError, message).trimEnd().split("\n");
      process.stderr.write(`${lines.map(safeLine).join("\n")}\n`);
      process.exitCode = exitCode;
    }
    return undefined;
  }
}

function preparationError(
  code: string,
  message: string,
  phase: commandPolicy.CommandPhase = "provider",
): commandPolicy.CommandError {
  return new commandPolicy.CommandError(
    // Retryability applies to connect, not to the separate, idempotent repair commands.
    { code, category: "dependency", retryability: "never", phase },
    message,
  );
}

function safeLine(line: string): string {
  return renderProviderCliHumanValue(commandPolicy.redactSecrets(line), 16384);
}

function presentPersistenceFailure(connection: ComputerConnectResult, home: string, json: boolean): void {
  const failure = connection.persistenceError;
  if (!failure) return;
  const guidance = [
    "Server exchange committed; the one-time connect code was consumed. Do not reuse it.",
    "Local credentials/identity may be incomplete; previous credentials may no longer work. No daemon was started or restarted.",
    "Fix local storage permissions/free space, then get a NEW connect command in openTag Web and run it; this computer keeps its existing Computer.",
    `Alternative when credentials were saved: "$HOME/.local/bin/${channelConfig.binName}" computer repair-local --installation-id ${failure.installationId} --home ${quotePosix(home)}`,
  ];
  const error = preparationError(
    "COMPUTER_LOCAL_PERSISTENCE_FAILED",
    guidance[0] ?? "Do not reuse the connect code.",
    "startup",
  );
  // `connected` records the committed Server exchange, not locally usable credentials or readiness.
  const value = { connected: true, codeConsumed: true, localPersistenceReady: false, connection, guidance };
  const exitCode = commandPolicy.commandExitCode(error);
  process.exitCode = exitCode;
  if (json) {
    commandPolicy.presentCommand({ ok: false, value, error, exitCode }, { json: true });
  } else {
    const lines = [
      `${connection.message.replace(/; local persistence is incomplete\.$/, ".")} (${failure.stage}: ${failure.message})`,
      `Next: Fix ${home}'s permissions or free disk space, then get a new connect command from openTag and run it.`,
    ];
    process.stderr.write(`${lines.map(safeLine).join("\n")}\n`);
  }
}

function presentPreparation(
  connection: ComputerConnectResult,
  preparation: LocalComputerPreparationResult,
  { json, verbose }: { json: boolean; verbose: boolean },
): void {
  const guidance = preparationGuidance(preparation);
  const value = { connected: true, connection, preparation, guidance };
  const error = preparationError(LOCAL_COMPUTER_PREPARATION_INCOMPLETE, NO_CODE_REUSE_GUIDANCE);
  process.exitCode = preparation.localReady ? 0 : commandPolicy.commandExitCode(error);
  if (json) {
    commandPolicy.presentCommand(
      preparation.localReady
        ? { ok: true, value, exitCode: 0 }
        : { ok: false, value, error, exitCode: commandPolicy.commandExitCode(error) },
      { json: true },
    );
    return;
  }
  // By default the reader gets the outcome and, when something is left to do, one next step. The
  // per-check report is for diagnosis (`--verbose`) and stays complete in `--json`.
  const lines = verbose
    ? [connection.message, ...formatPreparationResultLines(preparation), ...guidance]
    : [connection.message, ...(preparation.localReady ? [] : [`Next: ${preparationNextStep(preparation)}`])];
  const output = `${lines.map(safeLine).join("\n")}\n`;
  if (preparation.localReady) process.stdout.write(output);
  else process.stderr.write(output);
}

function presentOrdinaryConnection(connection: ComputerConnectResult, home: string, json: boolean): void {
  const guidance = connection.serviceError
    ? [
        NO_CODE_REUSE_GUIDANCE,
        `Repair: ${daemonServiceCommand("install", home)}`,
        `Verify: ${daemonServiceCommand("status", home)}`,
      ]
    : [];
  const value = { connected: true, connection, guidance };
  const error = preparationError(
    "DAEMON_SERVICE_FAILED",
    `Daemon service failed; machine credentials were preserved. ${NO_CODE_REUSE_GUIDANCE}`,
    "startup",
  );
  if (json) {
    process.exitCode = commandPolicy.presentCommand(
      connection.serviceError
        ? { ok: false, value, error, exitCode: commandPolicy.commandExitCode(error) }
        : { ok: true, value, exitCode: 0 },
      { json: true },
    );
    return;
  }
  process.stdout.write(`${safeLine(connection.message)}\n`);
  // A running service is implied by the line above; only an unexpected state is worth a line.
  if (connection.service && connection.service.state !== "active" && !connection.serviceError) {
    process.stdout.write(
      `${safeLine(`The openTag background service (${connection.service.serviceId}) is ${connection.service.state}.`)}\n`,
    );
  }
  for (const line of guidance) process.stderr.write(`${safeLine(line)}\n`);
  process.exitCode = connection.serviceError ? commandPolicy.commandExitCode(error) : 0;
}
