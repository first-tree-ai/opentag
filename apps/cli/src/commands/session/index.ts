import type { Command } from "commander";
import { commandExitCode, presentCommand, toCommandError } from "../../core/command/policy.js";
import {
  formatSessionAgentList,
  formatSessionCommandError,
  formatSessionCommandResult,
  formatSessionList,
  formatSessionStopResult,
  runSessionAgentList,
  runSessionCreate,
  runSessionList,
  runSessionSend,
  runSessionStop,
  SessionCommandRequestError,
} from "../../core/session/index.js";

interface OutputOptions {
  json?: boolean;
}

export function registerSessionCommand(program: Command): void {
  const session = program
    .command("session")
    .description("Create, message, stop, and list internal Sessions using the implicit managed source Session");

  session
    .command("create")
    .description("Create an internal child Session and atomically submit its first message")
    .option("--message <text>", "initial task text")
    .option("--message-file <path>", "read the initial task from a file, or - for stdin")
    .option("--message-id <uuid>", "idempotency key for an explicit retry")
    .option("--model <model>", "override the internal Session model")
    .option("--reasoning-effort <effort>", "override the internal Session reasoning effort")
    .option(
      "--max-duration-ms <milliseconds>",
      "maximum Run duration (default: the larger of 2 hours and the Agent budget)",
      parsePositiveInteger,
    )
    .option("--json", "print JSON")
    .action(async (options) => runCommand(() => runSessionCreate(options), options));

  session
    .command("send")
    .description("Send a message to any live Session of this Agent, in any conversation")
    .argument("<target-session-id>", "target Session ID")
    .option("--message <text>", "message text")
    .option("--message-file <path>", "read the message from a file, or - for stdin")
    .option("--message-id <uuid>", "idempotency key for an explicit retry")
    .option("--json", "print JSON")
    .action(async (targetSessionId, options) => runCommand(() => runSessionSend(targetSessionId, options), options));

  session
    .command("stop")
    .description(
      "Stop an internal Session this Session created, directly or through its children, and all Sessions below it: for good, without their cooperation",
    )
    .argument("<target-session-id>", "internal Session ID")
    .option("--json", "print JSON")
    .action(async (targetSessionId, options) => {
      try {
        const result = await runSessionStop(targetSessionId);
        process.stdout.write(`${options.json ? JSON.stringify(result) : formatSessionStopResult(result)}\n`);
        if (result.status !== "stopped") process.exitCode = 1;
      } catch (error) {
        const commandError = toCommandError(error, "request");
        process.exitCode = presentCommand(
          { ok: false, error: commandError, exitCode: commandExitCode(commandError) },
          { json: options.json === true },
        );
      }
    });

  session
    .command("list")
    .description(
      "List internal Sessions created by the implicit managed source Session, or with --agent every live Session of this Agent",
    )
    .option("--agent", "list every live Session of this Agent, in every conversation, with its conversation")
    .option("--visible", "with --agent: leave out internal Sessions")
    .option("--recursive", "include all descendant internal Sessions")
    .option("--include-stopped", "also list stopped Sessions, with when they stopped")
    .option("--limit <count>", "page size (maximum 100)", parsePositiveInteger)
    .option("--cursor <cursor>", "opaque cursor returned by the previous page")
    .option("--since <timestamp>", "include Sessions active since this ISO-8601 timestamp")
    .option("--json", "print JSON")
    .action(async (options) => {
      try {
        if (options.agent) {
          if (options.recursive || options.includeStopped || options.since) {
            throw new Error("--agent cannot be combined with --recursive, --include-stopped, or --since");
          }
          const result = await runSessionAgentList(options);
          process.stdout.write(
            `${options.json ? JSON.stringify({ ok: true, result }) : formatSessionAgentList(result)}\n`,
          );
          return;
        }
        if (options.visible) throw new Error("--visible requires --agent");
        const result = await runSessionList(options);
        if (options.json) {
          process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
        } else {
          process.stdout.write(`${formatSessionList(result)}\n`);
        }
      } catch (error) {
        const commandError = toCommandError(error, "request");
        process.exitCode = presentCommand(
          { ok: false, error: commandError, exitCode: commandExitCode(commandError) },
          { json: options.json === true },
        );
      }
    });
}

function writeCommandResult(result: Awaited<ReturnType<typeof runSessionCreate>>, options: OutputOptions): void {
  process.stdout.write(`${options.json ? JSON.stringify(result) : formatSessionCommandResult(result)}\n`);
  if (result.status !== "accepted") process.exitCode = 1;
}

async function runCommand(
  operation: () => Promise<Awaited<ReturnType<typeof runSessionCreate>>>,
  options: OutputOptions,
): Promise<void> {
  try {
    writeCommandResult(await operation(), options);
  } catch (error) {
    if (error instanceof SessionCommandRequestError) {
      process.stderr.write(`${formatSessionCommandError(error, options.json ?? false)}\n`);
      const commandError = toCommandError(error.cause, "request");
      process.exitCode = commandExitCode(commandError);
      return;
    }
    const commandError = toCommandError(error, "request");
    process.exitCode = presentCommand(
      { ok: false, error: commandError, exitCode: commandExitCode(commandError) },
      { json: options.json === true },
    );
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Expected a positive integer");
  return parsed;
}
