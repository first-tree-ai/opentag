import type { Command } from "commander";
import * as commandPolicy from "../core/command/policy.js";
import { type DoctorResult, runDoctor } from "../core/diagnostics/doctor.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run read-only baseline diagnostics for the selected OpenTag Home")
    .option("--json", "print JSON with machine-readable checks and next actions")
    .action(async (options: { json?: boolean }) => {
      try {
        const result = await runDoctor();
        if (!options.json) {
          process.exitCode = result.exitCode;
          process.stdout.write(`${result.message}\n`);
          return;
        }
        process.exitCode =
          result.exitCode === 0
            ? commandPolicy.presentCommand({ ok: true, value: result, exitCode: 0 }, { json: true })
            : commandPolicy.presentCommand(doctorFailure(result), { json: true });
      } catch (error) {
        const commandError = commandPolicy.toCommandError(error, "request");
        process.exitCode = commandPolicy.presentCommand(
          { ok: false, error: commandError, exitCode: commandPolicy.commandExitCode(commandError) },
          { json: options.json === true },
        );
      }
    });
}

/**
 * An unhealthy report is a failure document with the report attached: the reader gets the same
 * envelope shape as every other command and still receives the checks and next actions. The
 * verdict is about this machine's setup being missing or inconsistent — a configuration failure,
 * so the shared policy maps it to the operational-failure exit rather than service-unavailable.
 */
function doctorFailure(result: DoctorResult): commandPolicy.CommandResult<DoctorResult> {
  const blocking = result.checks.filter(
    (check) => check.blocking && (check.status === "fail" || check.status === "unknown"),
  ).length;
  const error = new commandPolicy.CommandError(
    {
      code: "DOCTOR_UNHEALTHY",
      category: "configuration",
      retryability: "never",
      phase: "unknown",
    },
    `${blocking} blocking baseline check(s) failed for this OpenTag Home.`,
  );
  return { ok: false, error, exitCode: commandPolicy.commandExitCode(error), value: result };
}
