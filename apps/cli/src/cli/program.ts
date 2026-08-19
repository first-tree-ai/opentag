import { Command } from "commander";
import { CLI_VERSION } from "../build-info.js";
import { registerAgentCommand } from "../commands/agent.js";
import { registerComputerCommand } from "../commands/computer.js";
import { registerDaemonCommand } from "../commands/daemon.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerLoginCommand } from "../commands/login.js";
import { channelConfig } from "../core/channel.js";

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
  return program;
}
