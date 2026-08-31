import type { Command } from "commander";
import { runDoctor } from "../core/diagnostics/doctor.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run read-only baseline diagnostics for the selected OpenTag Home")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      const result = await runDoctor().catch((error: unknown) => {
        process.exitCode = 1;
        throw error;
      });
      process.exitCode = result.exitCode;
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: result.exitCode === 0, result })}\n`);
      } else {
        process.stdout.write(`${result.message}\n`);
      }
    });
}
