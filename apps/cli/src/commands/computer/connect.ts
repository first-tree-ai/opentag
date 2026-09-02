import { resolve } from "node:path";
import { resolveOpenTagHome } from "@opentag/client";
import type { Command } from "commander";
import { channelConfig } from "../../core/channel/config.js";
import { resolveChannelEnvironment } from "../../core/channel/environment.js";
import * as commandPolicy from "../../core/command/policy.js";
import {
  type ComputerConnectResult,
  ComputerConnectServiceInstallError,
  runComputerConnect,
} from "../../core/computer/connect.js";
import * as providerCliCore from "../../core/provider-cli/ensure.js";

type ComputerConnectCommandOptions = {
  home?: string;
  server?: string;
  start?: boolean;
  prepareProviderClis?: boolean;
  json?: boolean;
};

interface ProviderCliSetupProjection {
  readonly status: "ready" | "needs_attention" | "skipped";
  readonly results: providerCliCore.ProviderCliEnsureCommandResult["results"];
  readonly nextActions: providerCliCore.ProviderCliEnsureCommandResult["nextActions"];
  readonly reason?: string;
}

export function registerComputerConnectCommand(computer: Command): void {
  computer
    .command("connect")
    .description("Connect this Computer and, for targeted onboarding, prepare the Lark and Slack CLIs")
    .argument("<code>", "one-time Computer connect code")
    .option("--server <url>", "OpenTag server URL")
    .option("--home <path>", "OpenTag home directory")
    .option("--no-start", "store the machine credential without installing the daemon service")
    .option("--no-prepare-provider-clis", "connect without preparing the Lark and Slack CLIs")
    .option("--json", "print JSON")
    .action(executeComputerConnectCommand);
}

async function executeComputerConnectCommand(code: string, options: ComputerConnectCommandOptions): Promise<void> {
  const result = await connectOrPresentFailure(code, options);
  if (!result) return;
  if (!shouldPrepareProviderClis(result, options)) {
    presentConnectResult(result, skippedProviderClis(result, options), options.json === true);
    process.exitCode = 0;
    return;
  }
  presentProviderCliSetupStart(result, options.json === true);
  await prepareProviderClisOrPresentFailure(result, options.json === true);
}

async function connectOrPresentFailure(
  code: string,
  options: ComputerConnectCommandOptions,
): Promise<ComputerConnectResult | undefined> {
  try {
    const environment = resolveChannelEnvironment(process.env);
    const serverUrl = options.server ?? environment.OPENTAG_SERVER_URL ?? channelConfig.defaultServerUrl;
    if (!serverUrl) throw new Error(`The ${channelConfig.channel} channel requires --server for Computer connect`);
    return await runComputerConnect({
      code,
      home: resolve(options.home ?? resolveOpenTagHome(environment)),
      noStart: options.start === false,
      serverUrl,
    });
  } catch (error) {
    presentConnectFailure(error, options.json === true);
    return undefined;
  }
}

function presentConnectFailure(error: unknown, json: boolean): void {
  if (error instanceof ComputerConnectServiceInstallError) {
    presentServiceFailure(error, json);
    process.exitCode = 1;
    return;
  }
  const commandError = commandPolicy.toCommandError(error, "request");
  process.exitCode = commandPolicy.presentCommand(
    { ok: false, error: commandError, exitCode: commandPolicy.commandExitCode(commandError) },
    { json },
  );
}

function shouldPrepareProviderClis(result: ComputerConnectResult, options: ComputerConnectCommandOptions): boolean {
  return options.prepareProviderClis !== false && options.start !== false && result.agentId !== undefined;
}

function presentProviderCliSetupStart(result: ComputerConnectResult, json: boolean): void {
  if (json) return;
  process.stdout.write(`${commandPolicy.redactSecrets(result.message)}\n`);
  if (result.service) process.stdout.write(`Daemon service ${result.service.serviceId} is ${result.service.state}\n`);
  process.stdout.write("Preparing Lark and Slack CLIs…\n");
}

async function prepareProviderClisOrPresentFailure(result: ComputerConnectResult, json: boolean): Promise<void> {
  try {
    const providerCli = await providerCliCore.runProviderCliEnsure({
      provider: "all",
      json,
      ...(json ? { stdout: () => undefined, stderr: () => undefined } : {}),
    });
    const projection: ProviderCliSetupProjection = {
      status: providerCli.exitCode === 0 ? "ready" : "needs_attention",
      results: providerCli.results,
      nextActions: providerCli.nextActions,
    };
    presentConnectResult(result, projection, json);
    process.exitCode = providerCli.exitCode;
  } catch (error) {
    presentUnexpectedProviderCliFailure(result, error, json);
  }
}

function presentUnexpectedProviderCliFailure(result: ComputerConnectResult, error: unknown, json: boolean): void {
  const commandError = commandPolicy.toCommandError(error, "provider");
  const projection: ProviderCliSetupProjection = {
    status: "needs_attention",
    results: [],
    nextActions: [
      {
        provider: "all",
        command: providerCliRepairAllCommand(),
        reason: commandError.code,
      },
    ],
  };
  presentConnectResult(result, projection, json, commandError);
  process.exitCode = commandPolicy.commandExitCode(commandError);
}

function skippedProviderClis(
  result: ComputerConnectResult,
  options: ComputerConnectCommandOptions,
): ProviderCliSetupProjection {
  const reason =
    options.start === false
      ? "daemon_not_started"
      : options.prepareProviderClis === false
        ? "not_requested"
        : result.agentId === undefined
          ? "no_target_agent"
          : "not_requested";
  return { status: "skipped", results: [], nextActions: [], reason };
}

function presentConnectResult(
  result: ComputerConnectResult,
  providerClis: ProviderCliSetupProjection,
  json: boolean,
  error?: commandPolicy.CommandError,
): void {
  if (json) {
    const value = {
      connected: true,
      connection: result,
      providerClis,
    };
    if (providerClis.status !== "needs_attention" && !error) {
      commandPolicy.presentCommand({ ok: true, value, exitCode: 0 }, { json: true });
      return;
    }
    const commandError =
      error ??
      new commandPolicy.CommandError(
        {
          code: "PROVIDER_CLI_SETUP_INCOMPLETE",
          category: "dependency",
          retryability: "never",
          phase: "provider",
        },
        "Computer connection is active, but local messaging CLI setup needs attention.",
      );
    commandPolicy.presentCommand({ ok: false, error: commandError, exitCode: 1, value }, { json: true });
    return;
  }
  if (providerClis.status === "ready") {
    process.stdout.write("Local messaging CLI setup is ready. Return to OpenTag and choose Lark or Slack.\n");
    return;
  }
  if (providerClis.status === "needs_attention") {
    if (error) process.stderr.write(`${error.code}: ${error.message}\n`);
    process.stderr.write("Computer connection is active, but local messaging CLI setup needs attention.\n");
    for (const action of providerClis.nextActions) process.stderr.write(`Resume with: ${action.command}\n`);
    return;
  }
  process.stdout.write(`${commandPolicy.redactSecrets(result.message)}\n`);
  if (result.service) process.stdout.write(`Daemon service ${result.service.serviceId} is ${result.service.state}\n`);
}

function presentServiceFailure(error: ComputerConnectServiceInstallError, json: boolean): void {
  const command = `"$HOME/.local/bin/${channelConfig.binName}" daemon restart`;
  if (json) {
    const commandError = new commandPolicy.CommandError(
      {
        code: "DAEMON_SERVICE_FAILED",
        category: "dependency",
        retryability: "immediate",
        phase: "startup",
      },
      "Daemon service reload failed; machine credentials were preserved.",
    );
    commandPolicy.presentCommand(
      {
        ok: false,
        error: commandError,
        exitCode: 1,
        value: {
          connected: true,
          connection: error.connectResult,
          providerClis: {
            status: "skipped",
            results: [],
            nextActions: [{ provider: "all", command, reason: "daemon_service_failed" }],
            reason: "daemon_service_failed",
          },
        },
      },
      { json: true },
    );
    return;
  }
  process.stdout.write(`${commandPolicy.redactSecrets(error.connectResult.message)}\n`);
  process.stderr.write(
    `${commandPolicy.redactSecrets(`Daemon service reload failed; machine credentials were preserved. Run ${command} to retry.`)}\n`,
  );
}

function providerCliRepairAllCommand(): string {
  return `"$HOME/.local/bin/${channelConfig.binName}" provider-cli ensure --provider all`;
}
