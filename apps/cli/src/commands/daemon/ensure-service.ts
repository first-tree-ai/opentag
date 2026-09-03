import type { Command } from "commander";
import * as commandPolicy from "../../core/command/policy.js";
import { type DaemonServiceReconcileResult, reconcileDaemonService } from "../../core/daemon/reconcile-service.js";

export const ENSURE_SERVICE_DEFERRED_EXIT_CODE = 3;
type EnsureErrorOption = { writeError?: (message: string) => void };
type EnsureOutputOption = { writeOutput?: (message: string) => void };
type EnsureJsonOption = { json?: boolean };
type EnsureServiceCallbacks = EnsureErrorOption & EnsureOutputOption & EnsureJsonOption;
type EnsureServiceOptions = { reconcileService?: () => Promise<DaemonServiceReconcileResult> } & EnsureServiceCallbacks;
type EnsureServiceResult = Promise<commandPolicy.CommandExitCode>;

export async function executeDaemonEnsureService(options: EnsureServiceOptions = {}): EnsureServiceResult {
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(`${message}\n`));
  const writeError = options.writeError ?? ((message: string) => process.stderr.write(message));
  try {
    const result = await (options.reconcileService ?? reconcileDaemonService)();
    if (result.status === "deferred") {
      writeOutput(renderEnsureResult(result, options.json === true));
      return ENSURE_SERVICE_DEFERRED_EXIT_CODE;
    }
    writeOutput(renderEnsureResult(result, options.json === true));
    return 0;
  } catch (error) {
    const commandError = commandPolicy.toCommandError(error, "request");
    return commandPolicy.presentCommand(
      { ok: false, error: commandError, exitCode: commandPolicy.commandExitCode(commandError) },
      { json: options.json === true, stderr: writeError },
    );
  }
}

function renderEnsureResult(result: DaemonServiceReconcileResult, json: boolean): string {
  const message =
    result.status === "deferred"
      ? result.reason === "credentials-missing"
        ? "No credentials found; daemon service setup is deferred until login."
        : `Daemon service control is not supported on ${process.platform}; setup is deferred.`
      : result.action === "restarted"
        ? `Daemon service ${result.service.serviceId} was restarted and is active.`
        : `Daemon service ${result.service.serviceId} was installed or repaired and is active.`;
  return json ? JSON.stringify({ ok: true, result: { ...result, message } }) : message;
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
