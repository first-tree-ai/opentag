import {
  AGENT_RUNTIME_PROVIDERS,
  type AgentRuntimeProvider,
  IM_CLI_PROVIDERS,
  type ImCliProvider,
} from "@opentag/shared";
import { type Command, InvalidArgumentError } from "commander";
import { renderDoctorJson, runDoctor } from "../core/diagnostics/doctor.js";

interface DoctorCommandOptions {
  home?: string;
  im?: ImCliProvider[];
  json?: boolean;
  runtime?: AgentRuntimeProvider[];
  serverUrl?: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check this computer: OpenTag server, Agent Runtime CLI, and messaging CLI")
    .option("--server-url <url>", "OpenTag server base URL")
    .option("--home <path>", "OpenTag home directory")
    .option(
      "--runtime <provider>",
      `require a ready Agent Runtime (${AGENT_RUNTIME_PROVIDERS.join(", ")}); repeatable`,
      collectChoice(AGENT_RUNTIME_PROVIDERS, "runtime"),
    )
    .option(
      "--im <provider>",
      `require a ready messaging CLI (${IM_CLI_PROVIDERS.join(", ")}); repeatable`,
      collectChoice(IM_CLI_PROVIDERS, "IM"),
    )
    .option("--json", "print the checks as JSON")
    .action(async (options: DoctorCommandOptions) => {
      const result = await runDoctor({
        ...(options.home ? { home: options.home } : {}),
        ...(options.im?.length ? { imProviders: options.im } : {}),
        ...(options.runtime?.length ? { runtimes: options.runtime } : {}),
        ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
      });
      // JSON output stays on stdout even when checks fail: the exit code carries the verdict, and a
      // caller parsing the report should not have to merge two streams.
      if (options.json) console.log(renderDoctorJson(result));
      else (result.exitCode === 0 ? console.log : console.error)(result.message);
      process.exitCode = result.exitCode;
    });
}

function collectChoice<Choice extends string>(
  choices: readonly Choice[],
  label: string,
): (value: string, previous: Choice[] | undefined) => Choice[] {
  return (value, previous) => {
    const choice = choices.find((candidate) => candidate === value);
    if (!choice) {
      throw new InvalidArgumentError(`Unknown ${label} provider: ${value}. Choose one of ${choices.join(", ")}.`);
    }
    const selected = previous ?? [];
    // Repeating a value must not probe the same provider twice or duplicate an id in --json.
    return selected.includes(choice) ? selected : [...selected, choice];
  };
}
