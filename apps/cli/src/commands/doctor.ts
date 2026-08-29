import type { Command } from "commander";
import { runDoctor } from "../core/diagnostics/doctor.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check the configured OpenTag servers and local Agent Runtime CLIs")
    .action(async () => {
      const result = await runDoctor();
      const write = result.exitCode === 0 ? console.log : console.error;
      write(result.message);
      process.exitCode = result.exitCode;
    });
}
