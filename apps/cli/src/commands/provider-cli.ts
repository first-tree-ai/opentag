import { type Command, CommanderError } from "commander";
import { runProviderCliEnsure } from "../core/provider-cli/ensure.js";
import { runProviderCliInspect } from "../core/provider-cli/inspect.js";
import type { ProviderCliCommandDeps } from "../core/provider-cli/shared.js";

/**
 * Thin Commander surface for Provider CLI management. All behavior lives in
 * `core/provider-cli`; this file only wires flags and exit codes.
 *
 * Usage errors (unknown flags, bad `--provider` values) exit 2; operational results
 * exit 0 when every requested provider is ready and 1 otherwise.
 */

// Commander writes the message/help first, then calls this instead of exiting.
function usageErrorsExit2(error: CommanderError): never {
  if (error.exitCode === 0) throw error;
  throw new CommanderError(2, error.code, error.message);
}

export function registerProviderCliCommand(program: Command, deps: ProviderCliCommandDeps = {}): void {
  const providerCli = program
    .command("provider-cli")
    .description("Manage the account-global Feishu/Lark and Slack provider CLIs")
    .exitOverride(usageErrorsExit2);

  providerCli
    .command("inspect")
    .description("Read-only Provider CLI diagnostics for this account")
    .requiredOption("--provider <name>", "Provider CLI to inspect: lark, slack, or all")
    .option("--json", "Emit one JSON document to stdout")
    .action(async (options: { provider: string; json?: boolean }) => {
      const result = await runProviderCliInspect({
        ...deps,
        provider: options.provider,
        json: options.json === true,
      });
      process.exitCode = result.exitCode;
    });

  providerCli
    .command("ensure")
    .description("Select the newest compatible Provider CLI or install the reviewed managed artifact")
    .requiredOption("--provider <name>", "Provider CLI to ensure: lark, slack, or all")
    .option("--managed-only", "Only use reviewed managed artifacts; never select a detected external CLI")
    .option("--no-path-update", "Do not create or refresh the public shim in the account's ~/.local/bin")
    .option("--dry-run", "Detect, rank, and report without selecting or installing")
    .option("--json", "Emit one JSON document to stdout")
    .action(
      async (options: {
        provider: string;
        managedOnly?: boolean;
        pathUpdate?: boolean;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const result = await runProviderCliEnsure({
          ...deps,
          provider: options.provider,
          managedOnly: options.managedOnly === true,
          pathUpdate: options.pathUpdate !== false,
          dryRun: options.dryRun === true,
          json: options.json === true,
        });
        process.exitCode = result.exitCode;
      },
    );
}
