import { randomUUID } from "node:crypto";
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

const reportedFailures = new WeakSet<object>();

/**
 * Relay one command failure at most once. The same thrown value can be handled by `executeCommand`
 * and still surface at the entry point, so the original error object is the identity that is tracked.
 */
export async function reportCommandFailure(
  error: unknown,
  commandError: CommandError,
  options: CliErrorReportOptions = {},
): Promise<{ ok: boolean }> {
  if (!shouldReportCommandError(commandError)) return { ok: false };
  const identity = typeof error === "object" && error !== null ? error : commandError;
  if (reportedFailures.has(identity)) return { ok: false };
  reportedFailures.add(identity);
  return reportCliError(error, options);
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
    if (!Array.isArray(current.commands)) break;
    const next = current.commands.find(
      (candidate) => candidate.name() === token || candidate.aliases().includes(token),
    );
    if (!next) break;
    path.push(next.name());
    current = next;
  }
  return path.length > 0 ? path.join(" ") : undefined;
}

/** Where a report goes and who it is from, as far as this OpenTag home knows either. */
export interface ErrorReportTarget {
  /** `undefined` when this home has never signed in or connected; there is then nowhere to report. */
  serverUrl?: string | undefined;
  userId?: string | undefined;
  /** The Account Computer this home is connected as; the identifier the Server and the Web App know. */
  computerId?: string | undefined;
  /** This installation's own locally generated identity, which several Computers over time can share. */
  installationId?: string | undefined;
}

/**
 * Read one optional identity file, treating a missing or malformed file alike as "nothing known".
 *
 * Each file is read on its own rather than under one shared `catch`: the readers throw on a
 * malformed file, and a corrupt `computer.json` must not silence a report that valid Account
 * credentials alone could still address. What is unreadable simply goes unreported.
 */
async function readOptionalIdentity<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * Read the identity this OpenTag home reports under, from whichever credential files exist.
 *
 * All three are read rather than stopping at the first server URL: an installation that has both an
 * Account and a Computer can say so, and the two answer different questions — who hit this, and
 * which machine it was. A home that has neither reports nothing at all, which is the point of
 * returning the whole thing rather than throwing.
 *
 * The two machine identifiers come from different records on purpose. `computer.json` holds the
 * installation's locally generated uuid, which the daemon logs as `installationId`; the Account's
 * Computer uuid — the one a reader can look up — exists only in the machine credential, which is
 * what a connected Computer received from the Server.
 *
 * The Account comes from its own file rather than from the credentials, because the credentials
 * file is read strictly by every CLI version and an older one must keep reading it after a
 * rollback. It counts only while it names the server the credentials are for: an identity left by
 * a sign-in to another server, or by a sign-in whose credentials are gone, is treated as absent.
 */
export async function resolveErrorReportTarget(home: string): Promise<ErrorReportTarget> {
  const [credentials, account, identity, machine] = await Promise.all([
    readOptionalIdentity(() => client.readCredentials(home)),
    readOptionalIdentity(() => client.readAccountIdentity(home)),
    readOptionalIdentity(() => client.readComputerIdentity(home)),
    readOptionalIdentity(() => client.readMachineCredentials(home)),
  ]);
  const accountMatchesCredentials = account !== undefined && account.serverUrl === credentials?.serverUrl;
  return {
    serverUrl: credentials?.serverUrl ?? identity?.serverUrl ?? machine?.computer.serverUrl,
    userId: accountMatchesCredentials ? account.userId : undefined,
    computerId: machine?.computer.computerId,
    installationId: identity?.computerId ?? machine?.computer.installationId,
  };
}

/** The Agent a failure belongs to, when it happened inside a turn rather than inside a command. */
export interface CliErrorReportAgent {
  agentId?: string | undefined;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  provider?: string | undefined;
}

export interface CliErrorReportOptions {
  command?: string | undefined;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  fetchImpl?: typeof fetch;
  agent?: CliErrorReportAgent | undefined;
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
    const { serverUrl, ...identity } = await resolveErrorReportTarget(home);
    if (!serverUrl) return { ok: false };
    return await client.reportClientError({
      serverUrl,
      error,
      version: CLI_VERSION,
      channel: CHANNEL,
      command: options.command,
      platform: client.describePlatform(),
      reportId: randomUUID(),
      ...identity,
      ...options.agent,
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
