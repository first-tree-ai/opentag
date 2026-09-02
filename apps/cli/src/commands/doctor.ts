import type { Command } from "commander";
import * as commandPolicy from "../core/command/policy.js";
import { runDoctor } from "../core/diagnostics/doctor.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run read-only baseline diagnostics for the selected OpenTag Home")
    .option("--json", "print JSON with machine-readable checks and next actions")
    .action(async (options: { json?: boolean }) => {
      try {
        const result = await runDoctor();
        process.exitCode = result.exitCode;
        if (options.json) {
          process.stdout.write(`${JSON.stringify({ ok: result.exitCode === 0, result })}\n`);
        } else {
          process.stdout.write(`${result.message}\n`);
        }
      } catch (error) {
        const commandError = commandPolicy.toCommandError(error, "request");
        process.exitCode = commandPolicy.presentCommand(
          { ok: false, error: commandError, exitCode: commandPolicy.commandExitCode(commandError) },
          { json: options.json === true },
        );
      }
    });
}
