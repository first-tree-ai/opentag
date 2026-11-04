import type { CommandError } from "../command/policy.js";

/**
 * Plain-language presentation for `computer connect`. Every success is one line; every failure is one
 * line saying why plus one line saying what to do next. Internal detail (error codes, request IDs,
 * whether anything changed) stays out of the human output.
 */
export interface ConnectFailureMessage {
  reason: string;
  next: string;
}

const NEW_COMMAND = "Get a new connect command from openTag (Computers → Connect a computer) and run it.";

export function describeConnectFailure(
  error: CommandError,
  context: { serverUrl?: string; home: string },
): ConnectFailureMessage {
  const server = context.serverUrl ?? "the openTag server";
  switch (error.code) {
    case "AUTH_CODE_EXPIRED":
      return { reason: "This connect code has expired.", next: NEW_COMMAND };
    case "AUTH_CODE_CONSUMED":
      return {
        reason: "This connect code has already been used.",
        next: NEW_COMMAND,
      };
    case "AUTH_INVALID_CODE":
      return {
        reason: "This connect code is not valid.",
        next: NEW_COMMAND,
      };
    case "COMPUTER_ACCOUNT_CONFLICT":
      return {
        reason: "This computer is linked to another openTag account.",
        next: "Ask that account's owner to remove it in openTag, then run this command again.",
      };
    case "COMPUTER_IDENTITY_CONFLICT":
      return {
        reason: "openTag already has another computer registered with this installation.",
        next: NEW_COMMAND,
      };
    case "COMPUTER_TARGET_MISMATCH":
      return {
        reason: "This command restores a different computer than this one.",
        next: "Run it on the computer it names in openTag, or connect this one as a new computer.",
      };
    case "AUTH_USER_SUSPENDED":
      return {
        reason: "The openTag account that issued this code is suspended.",
        next: "Contact your openTag administrator.",
      };
    default:
      break;
  }
  if (error.phase === "transport" || error.code === "SERVICE_UNAVAILABLE" || error.code === "TIMEOUT") {
    return {
      reason: `Could not reach the openTag server at ${server}.`,
      next: "Check this computer's network connection, then run the same command again.",
    };
  }
  if (isPermissionProblem(error.message)) {
    return {
      reason: `openTag cannot write to ${context.home}: permission denied.`,
      next: "Fix that folder's permissions for this user, then run the same command again.",
    };
  }
  if (isDiskFull(error.message)) {
    return {
      reason: `openTag cannot write to ${context.home}: the disk is full.`,
      next: "Free some disk space, then run the same command again.",
    };
  }
  return {
    reason: `Connecting this computer failed: ${firstSentence(error.message)}`,
    next: "Run the same command again; if it keeps failing, get a new connect command from openTag.",
  };
}

/** Error codes and request IDs stay in `--json`; the human output is only the reason and the next step. */
export function formatConnectFailure(_error: CommandError, message: ConnectFailureMessage): string {
  return `${message.reason}\nNext: ${message.next}\n`;
}

function isPermissionProblem(message: string): boolean {
  return /\bEACCES\b|\bEPERM\b|\bEROFS\b|permission denied|read-only file system/i.test(message);
}

function isDiskFull(message: string): boolean {
  return /\bENOSPC\b|no space left/i.test(message);
}

function firstSentence(message: string): string {
  const line = message.split("\n")[0]?.trim() ?? "";
  const clipped = line.length > 160 ? `${line.slice(0, 157)}...` : line;
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}
