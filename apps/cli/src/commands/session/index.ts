import type { Command } from "commander";
import { commandExitCode, presentCommand, toCommandError } from "../../core/command/policy.js";
import {
  formatSessionCommandError,
  formatSessionCommandResult,
  formatSessionList,
  runSessionCreate,
  runSessionList,
  runSessionSend,
  SessionCommandRequestError,
} from "../../core/session/index.js";

interface OutputOptions {
  json?: boolean;
}

export function registerSessionCommand(program: Command): void {
  const session = program
    .command("session")
    .description("Create, message, and list internal Sessions using the implicit managed source Session");

  session
    .command("create")
    .description("Create an internal child Session and atomically submit its first message")
    .option("--message <text>", "initial task text")
    .option("--message-file <path>", "read the initial task from a file, or - for stdin")
    .option("--message-id <uuid>", "idempotency key for an explicit retry")
    .option("--model <model>", "override the internal Session model")
    .option("--reasoning-effort <effort>", "override the internal Session reasoning effort")
    .option("--max-duration-ms <milliseconds>", "override the maximum Run duration", parsePositiveInteger)
    .option("--json", "print JSON")
    .action(async (options) => runCommand(() => runSessionCreate(options), options));

  session
    .command("send")
    .description("Send a message to an existing Session in the same collaboration scope")
    .argument("<target-session-id>", "target Session ID")
    .option("--message <text>", "message text")
    .option("--message-file <path>", "read the message from a file, or - for stdin")
    .option("--message-id <uuid>", "idempotency key for an explicit retry")
    .option("--json", "print JSON")
    .action(async (targetSessionId, options) => runCommand(() => runSessionSend(targetSessionId, options), options));

  session
    .command("list")
    .description("List internal Sessions created by the implicit managed source Session")
    .option("--recursive", "include all descendant internal Sessions")
    .option("--limit <count>", "page size (maximum 100)", parsePositiveInteger)
    .option("--cursor <cursor>", "opaque cursor returned by the previous page")
    .option("--since <timestamp>", "include Sessions active since this ISO-8601 timestamp")
    .option("--json", "print JSON")
    .action(async (options) => {
      try {
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
