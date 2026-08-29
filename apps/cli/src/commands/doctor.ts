import type { Command } from "commander";
import { runDoctor } from "../core/diagnostics/doctor.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run read-only baseline diagnostics for the selected OpenTag Home")
    .action(async () => {
      const result = await runDoctor();
      console.log(result.message);
      process.exitCode = result.exitCode;
    });
}
