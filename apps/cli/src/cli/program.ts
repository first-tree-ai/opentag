import { Command } from "commander";
import { registerDoctorCommand } from "../commands/doctor.js";

export function createProgram(): Command {
  const program = new Command();
  program.name("opentag").description("OpenTag command-line interface").version("0.0.0").showHelpAfterError();
  registerDoctorCommand(program);
  return program;
}
