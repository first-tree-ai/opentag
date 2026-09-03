import { resolve } from "node:path";
import { resolveOpenTagHome } from "@opentag/client";
import type { LocalComputerPreparationResult } from "@opentag/shared";
import type { Command } from "commander";
import { channelConfig } from "../../core/channel/config.js";
import { resolveChannelEnvironment } from "../../core/channel/environment.js";
import * as commandPolicy from "../../core/command/policy.js";
import { type ComputerConnectResult, runComputerConnect } from "../../core/computer/connect.js";
import { formatPreparationResultLines } from "../../core/computer/formatting.js";
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
};

export function registerComputerConnectCommand(computer: Command): void {
  computer
    .command("connect")
    .description("Connect this Computer, check the selected Runtime, and prepare Lark and Slack CLIs")
    .argument("<code>", "one-time Computer connect code")
    .option("--server <url>", "OpenTag server URL")
    .option("--home <path>", "OpenTag home directory")
    .option("--no-start", "skip only daemon service installation/start")
    .option("--no-prepare-provider-clis", "skip Lark and Slack CLI preparation")
    .option("--json", "print JSON")
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
      onPhase: options.json
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
  presentPreparation(connection, preparation, options.json === true);
}

async function connectOrPresentFailure(
  code: string,
  home: string,
  environment: NodeJS.ProcessEnv,
  options: ComputerConnectCommandOptions,
): Promise<ComputerConnectResult | undefined> {
  try {
    const serverUrl = options.server ?? environment.OPENTAG_SERVER_URL ?? channelConfig.defaultServerUrl;
    if (!serverUrl) throw new Error(`The ${channelConfig.channel} channel requires --server for Computer connect`);
    return await runComputerConnect({ code, home, noStart: options.start === false, serverUrl });
  } catch (error) {
    const commandError = commandPolicy.toCommandError(error, "request");
    process.exitCode = commandPolicy.presentCommand(
      { ok: false, error: commandError, exitCode: commandPolicy.commandExitCode(commandError) },
      { json: options.json },
    );
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
    "Fix local storage permissions/free space, then run the local repair below. It accepts only a saved credential for this exact installation.",
    `Repair: "$HOME/.local/bin/${channelConfig.binName}" computer repair-local --installation-id ${failure.installationId} --home ${quotePosix(home)}`,
    "If repair reports COMPUTER_CREDENTIAL_UNAVAILABLE, request a NEW connect/repair code in OpenTag Web after fixing storage. The consumed code cannot be recovered.",
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
    process.stderr.write(
      `${[connection.message, `${failure.stage}: ${failure.message}`, ...guidance].map(safeLine).join("\n")}\n`,
    );
  }
}

function presentPreparation(
  connection: ComputerConnectResult,
  preparation: LocalComputerPreparationResult,
  json: boolean,
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
  const lines = [connection.message, ...formatPreparationResultLines(preparation), ...guidance];
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
  if (connection.service)
    process.stdout.write(
      `${safeLine(`Daemon service ${connection.service.serviceId} is ${connection.service.state}`)}\n`,
    );
  for (const line of guidance) process.stderr.write(`${safeLine(line)}\n`);
  process.exitCode = connection.serviceError ? commandPolicy.commandExitCode(error) : 0;
}
