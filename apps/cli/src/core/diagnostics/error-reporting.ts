import * as client from "@opentag/client";
import type { Command } from "commander";
import { CHANNEL, CLI_VERSION } from "../../build-info.js";
import { resolveChannelEnvironment } from "../channel/environment.js";
import type { CommandError } from "../command/policy.js";

/**
 * Categories that describe the program rather than the caller's input, credentials, or environment.
 * Everything else is an answer the CLI gave on purpose and is not a defect worth a tracker entry.
 */
const REPORTED_CATEGORIES: ReadonlySet<CommandError["category"]> = new Set(["internal", "dependency", "protocol"]);

export function shouldReportCommandError(error: CommandError): boolean {
  return REPORTED_CATEGORIES.has(error.category);
}

/**
 * The subcommand path Commander would dispatch to, such as `agent create`, from the raw arguments.
 * Options are skipped and the walk stops at the first token that is not a registered subcommand,
 * so a user-supplied value never becomes part of the result.
 */
export function resolveCommandPath(program: Command, argv: readonly string[]): string | undefined {
  const path: string[] = [];
  let current = program;
  for (const token of argv) {
    if (token.startsWith("-")) continue;
    const next = current.commands.find(
      (candidate) => candidate.name() === token || candidate.aliases().includes(token),
    );
    if (!next) break;
    path.push(next.name());
    current = next;
  }
  return path.length > 0 ? path.join(" ") : undefined;
}

/** The server this OpenTag home talks to, from whichever credential file exists; `undefined` when none does. */
export async function resolveErrorReportServerUrl(home: string): Promise<string | undefined> {
  try {
    const credentials = await client.readCredentials(home);
    if (credentials?.serverUrl) return credentials.serverUrl;
    const [identity, machine] = await Promise.all([
      client.readComputerIdentity(home),
      client.readMachineCredentials(home),
    ]);
    return identity?.serverUrl ?? machine?.computer.serverUrl;
  } catch {
    return undefined;
  }
}

export interface CliErrorReportOptions {
  command?: string | undefined;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Relay a CLI failure through the server this installation is connected to. Silent when no server is
 * known: a CLI that was never logged in or connected has nowhere to send a report, and nothing to
 * gain from complaining about it.
 */
export async function reportCliError(error: unknown, options: CliErrorReportOptions = {}): Promise<{ ok: boolean }> {
  try {
    const environment = resolveChannelEnvironment(options.environment ?? process.env);
    const home = options.home ?? client.resolveOpenTagHome(environment);
    const serverUrl = await resolveErrorReportServerUrl(home);
    if (!serverUrl) return { ok: false };
    return await client.reportClientError({
      serverUrl,
      error,
      version: CLI_VERSION,
      channel: CHANNEL,
      command: options.command,
      fetchImpl: options.fetchImpl,
    });
  } catch {
    return { ok: false };
  }
}

/** Report and exit on an uncaught exception or unhandled rejection anywhere in this CLI process. */
export function installCliProcessErrorReporting(options: CliErrorReportOptions = {}): () => void {
  return client.installProcessErrorReporting({
    logger: client.createLogger("cli"),
    report: (error) => reportCliError(error, options),
  });
}
