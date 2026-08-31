import { Command } from "commander";
import { CLI_VERSION } from "../build-info.js";
import { registerAgentCommand } from "../commands/agent/index.js";
import { registerComputerCommand } from "../commands/computer/index.js";
import { registerDaemonCommand } from "../commands/daemon/index.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerLoginCommand } from "../commands/login.js";
import { registerProviderCliCommand } from "../commands/provider-cli.js";
import { registerSessionCommand } from "../commands/session/index.js";
import { channelConfig } from "../core/channel/config.js";

export function createProgram(): Command {
  const program = new Command();
  program
    .name(channelConfig.binName)
    .description("OpenTag command-line interface")
    .version(CLI_VERSION)
    .showHelpAfterError();
  registerComputerCommand(program);
  registerAgentCommand(program);
  registerDaemonCommand(program);
  registerDoctorCommand(program);
  registerLoginCommand(program);
  registerProviderCliCommand(program);
  registerSessionCommand(program);
  return program;
}
