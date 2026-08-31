import type { Command } from "commander";
import { type CommandExitCode, presentCommand, toCommandError } from "../../core/command/policy.js";
import { type DaemonServiceReconcileResult, reconcileDaemonService } from "../../core/daemon/reconcile-service.js";

export const ENSURE_SERVICE_DEFERRED_EXIT_CODE = 3;

export async function executeDaemonEnsureService(
  options: {
    reconcileService?: () => Promise<DaemonServiceReconcileResult>;
    writeError?: (message: string) => void;
    writeOutput?: (message: string) => void;
    json?: boolean;
  } = {},
): Promise<CommandExitCode> {
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(`${message}\n`));
  const writeError = options.writeError ?? ((message: string) => process.stderr.write(`${message}\n`));
  try {
    const result = await (options.reconcileService ?? reconcileDaemonService)();
    if (result.status === "deferred") {
      const message =
        result.reason === "credentials-missing"
          ? "No credentials found; daemon service setup is deferred until login."
          : `Daemon service control is not supported on ${process.platform}; setup is deferred.`;
      if (options.json) {
        writeOutput(JSON.stringify({ ok: true, result: { ...result, message } }));
      } else writeOutput(message);
      return ENSURE_SERVICE_DEFERRED_EXIT_CODE;
    }
    const message =
      result.action === "restarted"
        ? `Daemon service ${result.service.serviceId} was restarted and is active.`
        : `Daemon service ${result.service.serviceId} was installed or repaired and is active.`;
    if (options.json) writeOutput(JSON.stringify({ ok: true, result: { ...result, message } }));
    else writeOutput(message);
    return 0;
  } catch (error) {
    if (options.json) {
      return presentCommand(
        { ok: false, error: toCommandError(error, "request"), exitCode: 1 },
        { json: true, stderr: writeError },
      );
    }
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function registerDaemonEnsureServiceCommand(daemon: Command): void {
  daemon
    .command("ensure-service", { hidden: true })
    .description("Ensure the daemon service is installed and active when credentials already exist")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      process.exitCode = await executeDaemonEnsureService({ json: options.json === true });
    });
}
