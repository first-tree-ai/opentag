import { Command } from "commander";
import { CLI_VERSION } from "../build-info.js";
import { registerAgentCommand } from "../commands/agent/index.js";
import { registerComputerConnectCommand } from "../commands/computer/connect.js";
import { registerComputerCommand } from "../commands/computer/index.js";
import { registerDaemonCommand } from "../commands/daemon/index.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerLoginCommand } from "../commands/login.js";
import { registerLogsCommand } from "../commands/logs.js";
import { registerProviderCliCommand } from "../commands/provider-cli.js";
import { registerSessionCommand } from "../commands/session/index.js";
import { registerUpgradeCommand } from "../commands/upgrade.js";
import { channelConfig } from "../core/channel/config.js";

export function createProgram(options: { json?: boolean } = {}): Command {
  const program = new Command();
  program
    .name(channelConfig.binName)
    .description("OpenTag command-line interface")
    .version(CLI_VERSION)
    .showHelpAfterError()
    // Throw rather than exit inside Commander so the process entrypoint owns the failure
    // envelope and the usage exit code for every command, not just the ones that override.
    .exitOverride();
  if (options.json) {
    // A --json caller reads exactly one failure document from the entrypoint; Commander's own
    // human error and help-after-error text would corrupt that stream, so it is suppressed.
    program.configureOutput({ writeErr: () => undefined });
  }
  // The onboarding command is top-level so an Agent can run the copied setup command without
  // needing to know the CLI's resource hierarchy. Keep `computer connect` as a compatible alias.
  registerComputerConnectCommand(program);
  registerComputerCommand(program);
  registerAgentCommand(program);
  registerDaemonCommand(program);
  registerDoctorCommand(program);
  registerLoginCommand(program);
  registerLogsCommand(program);
  registerProviderCliCommand(program);
  registerSessionCommand(program);
  registerUpgradeCommand(program);
  return program;
}
