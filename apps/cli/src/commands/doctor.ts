import type { Command } from "commander";
import { runDoctor } from "../core/doctor.js";

interface DoctorCommandOptions {
  serverUrl?: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check connectivity to the OpenTag server")
    .option("--server-url <url>", "OpenTag server base URL")
    .action(async (options: DoctorCommandOptions) => {
      const result = await runDoctor({ serverUrl: options.serverUrl });
      const write = result.exitCode === 0 ? console.log : console.error;
      write(result.message);
      process.exitCode = result.exitCode;
    });
}
