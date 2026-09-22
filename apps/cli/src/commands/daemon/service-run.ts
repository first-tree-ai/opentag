import type { Command } from "commander";
import { runDaemonServiceEntry } from "../../core/daemon/runtime.js";
import { reportCliError } from "../../core/diagnostics/error-reporting.js";

export function registerDaemonServiceRunCommand(daemon: Command): void {
  daemon
    .command("service-run", { hidden: true })
    .description("Internal daemon service entrypoint")
    .action(async () => {
      process.exitCode = await runDaemonServiceEntry({
        reportFailure: (error) => reportCliError(error, { command: "daemon service-run" }),
      });
    });
}
