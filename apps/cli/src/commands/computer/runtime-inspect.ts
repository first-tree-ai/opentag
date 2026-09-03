import { AgentRuntimeProviderSchema } from "@opentag/shared";
import type { Command } from "commander";
import { CommandError, commandExitCode, presentCommand, toCommandError } from "../../core/command/policy.js";
import { formatPreparationComponentLines } from "../../core/computer/formatting.js";
import { probeRuntimeComponent } from "../../core/computer/runtime-probe.js";
import { renderProviderCliHumanValue } from "../../core/provider-cli/shared.js";

/** Idempotent inspection only: no connect code, daemon change, Runtime installation, or model turn. */
export function registerRuntimeInspectCommand(computer: Command): void {
  computer
    .command("runtime-inspect")
    .description("Check one preinstalled Runtime CLI, its required capabilities and credentials")
    .requiredOption("--provider <provider>", "codex or claude-code (no default)")
    .option("--json", "print JSON")
    .action(async (options: { provider: string; json?: boolean }) => {
      try {
        const provider = AgentRuntimeProviderSchema.parse(options.provider);
        const component = await probeRuntimeComponent({ provider });
        const error = new CommandError(
          { code: "RUNTIME_CHECK_INCOMPLETE", category: "dependency", retryability: "never", phase: "provider" },
          "The selected Runtime needs attention. Follow its repair and verify actions.",
        );
        const ready = component.status === "ready" && !component.blocking;
        process.exitCode = ready ? 0 : commandExitCode(error);
        if (options.json) {
          presentCommand(
            ready
              ? { ok: true, value: component, exitCode: 0 }
              : { ok: false, value: component, error, exitCode: commandExitCode(error) },
            { json: true },
          );
        } else {
          const output = `${formatPreparationComponentLines(component)
            .map((line) => renderProviderCliHumanValue(line, 16384))
            .join("\n")}\n`;
          if (ready) process.stdout.write(output);
          else process.stderr.write(output);
        }
      } catch (error) {
        const commandError = toCommandError(error, "validation");
        process.exitCode = presentCommand(
          { ok: false, error: commandError, exitCode: commandExitCode(commandError) },
          { json: options.json },
        );
      }
    });
}
