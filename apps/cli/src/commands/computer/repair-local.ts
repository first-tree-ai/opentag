import { resolve } from "node:path";
import { resolveOpenTagHome } from "@opentag/client";
import { ComputerConnectCodeExchangeRequestSchema } from "@opentag/shared";
import type { Command } from "commander";
import { resolveChannelEnvironment } from "../../core/channel/environment.js";
import { commandExitCode, presentCommand, toCommandError } from "../../core/command/policy.js";
import { daemonServiceCommand, SERVER_CONFIRMATION_GUIDANCE } from "../../core/computer/preparation.js";
import { repairLocalComputerConnection } from "../../core/computer/repair-local.js";

export function registerComputerRepairLocalCommand(computer: Command): void {
  computer
    .command("repair-local")
    .description("Recover saved Computer credentials and identity without reusing a connect code")
    .requiredOption("--installation-id <id>", "installation ID reported by the failed connect")
    .option("--home <path>", "OpenTag home directory")
    .option("--json", "print JSON")
    .action(async (options: { installationId: string; home?: string; json?: boolean }) => {
      try {
        const installationId = ComputerConnectCodeExchangeRequestSchema.shape.installationId.parse(
          options.installationId,
        );
        const home = resolve(options.home ?? resolveOpenTagHome(resolveChannelEnvironment(process.env)));
        const connection = await repairLocalComputerConnection({ home, installationId });
        const guidance = [
          "Local Computer files repaired. No daemon was started and no Runtime or Provider readiness was asserted.",
          `Resume: ${daemonServiceCommand("install", home)}`,
          `Verify: ${daemonServiceCommand("status", home)}`,
          SERVER_CONFIRMATION_GUIDANCE,
        ];
        process.exitCode = presentCommand(
          { ok: true, value: { ...connection, guidance }, exitCode: 0 },
          { json: options.json, formatValue: () => guidance.join("\n") },
        );
      } catch (error) {
        const commandError = toCommandError(error, "startup");
        process.exitCode = presentCommand(
          { ok: false, error: commandError, exitCode: commandExitCode(commandError) },
          { json: options.json },
        );
      }
    });
}
