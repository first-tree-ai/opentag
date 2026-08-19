import type { Command } from "commander";
import { type DaemonServiceReconcileResult, reconcileDaemonService } from "../../core/daemon/reconcile-service.js";

export const ENSURE_SERVICE_DEFERRED_EXIT_CODE = 3;

export async function executeDaemonEnsureService(
  options: {
    reconcileService?: () => Promise<DaemonServiceReconcileResult>;
    writeError?: (message: string) => void;
    writeOutput?: (message: string) => void;
  } = {},
): Promise<0 | 1 | typeof ENSURE_SERVICE_DEFERRED_EXIT_CODE> {
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(`${message}\n`));
  const writeError = options.writeError ?? ((message: string) => process.stderr.write(`${message}\n`));
  try {
    const result = await (options.reconcileService ?? reconcileDaemonService)();
    if (result.status === "deferred") {
      writeOutput(
        result.reason === "credentials-missing"
          ? "No credentials found; daemon service setup is deferred until login."
          : `Daemon service control is not supported on ${process.platform}; setup is deferred.`,
      );
      return ENSURE_SERVICE_DEFERRED_EXIT_CODE;
    }
    writeOutput(
      result.action === "restarted"
        ? `Daemon service ${result.service.serviceId} was restarted and is active.`
        : `Daemon service ${result.service.serviceId} was installed or repaired and is active.`,
    );
    return 0;
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function registerDaemonEnsureServiceCommand(daemon: Command): void {
  daemon
    .command("ensure-service", { hidden: true })
    .description("Ensure the daemon service is installed and active when credentials already exist")
    .action(async () => {
      process.exitCode = await executeDaemonEnsureService();
    });
}
