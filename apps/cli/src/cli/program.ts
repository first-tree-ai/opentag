import { Command } from "commander";
import { CLI_BINARY_NAME, CLI_VERSION } from "../build-info.js";
import { registerDoctorCommand } from "../commands/doctor.js";

export function createProgram(): Command {
  const program = new Command();
  program.name(CLI_BINARY_NAME).description("OpenTag command-line interface").version(CLI_VERSION).showHelpAfterError();
  registerDoctorCommand(program);
  return program;
}
