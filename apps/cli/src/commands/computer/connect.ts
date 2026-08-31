import { resolve } from "node:path";
import { resolveOpenTagHome } from "@opentag/client";
import type { Command } from "commander";
import { channelConfig } from "../../core/channel/config.js";
import { resolveChannelEnvironment } from "../../core/channel/environment.js";
import { type CommandResult, commandExitCode, presentCommand, toCommandError } from "../../core/command/policy.js";
import { ComputerConnectServiceInstallError, runComputerConnect } from "../../core/computer/connect.js";

interface ComputerConnectCommandOptions {
  home?: string;
  server?: string;
  start?: boolean;
  json?: boolean;
}

export function registerComputerConnectCommand(computer: Command): void {
  computer
    .command("connect")
    .description("Enroll this Computer with a one-time code")
    .argument("<code>", "one-time Computer connect code")
    .option("--server <url>", "OpenTag server URL")
    .option("--home <path>", "OpenTag home directory")
    .option("--no-start", "store the machine credential without installing the daemon service")
    .option("--json", "print JSON")
    .action(async (code: string, options: ComputerConnectCommandOptions) => {
      const environment = resolveChannelEnvironment(process.env);
      const serverUrl = options.server ?? environment.OPENTAG_SERVER_URL ?? channelConfig.defaultServerUrl;
      if (!serverUrl) throw new Error(`The ${channelConfig.channel} channel requires --server for Computer connect`);
      try {
        const result = await runComputerConnect({
          code,
          home: resolve(options.home ?? resolveOpenTagHome(environment)),
          noStart: options.start === false,
          serverUrl,
        });
        if (options.json) {
          process.exitCode = presentCommand({ ok: true, value: result, exitCode: 0 }, { json: true });
        } else {
          process.stdout.write(`${result.message}\n`);
          if (result.service)
            process.stdout.write(`Daemon service ${result.service.serviceId} is ${result.service.state}\n`);
          process.exitCode = 0;
        }
      } catch (error) {
        if (error instanceof ComputerConnectServiceInstallError) {
          process.stdout.write(`${error.connectResult.message}\n`);
          process.stderr.write(
            `Daemon service reload failed; machine credentials were preserved. Run ${channelConfig.binName} daemon restart to retry.\n`,
          );
          process.exitCode = 1;
          return;
        }
        const commandError = toCommandError(error, "request");
        process.exitCode = presentCommand(
          { ok: false, error: commandError, exitCode: commandExitCode(commandError) } as CommandResult<never>,
          { json: options.json === true },
        );
      }
    });
}
