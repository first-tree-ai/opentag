import type { CommandError } from "../command/policy.js";

/**
 * Plain-language presentation for `computer connect`. Every outcome is one line saying what happened;
 * every failure is one line saying why plus one line saying what to do next. Error codes and request
 * IDs stay available on a trailing detail line for support, never as the main message.
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
      return { reason: "This connect code has expired; nothing was changed on this computer.", next: NEW_COMMAND };
    case "AUTH_CODE_CONSUMED":
      return {
        reason: "This connect code has already been used; nothing was changed on this computer.",
        next: NEW_COMMAND,
      };
    case "AUTH_INVALID_CODE":
      return {
        reason: "This connect code is not valid (it may be incomplete or revoked); nothing was changed.",
        next: NEW_COMMAND,
      };
    case "COMPUTER_ACCOUNT_CONFLICT":
      return {
        reason: "This computer is already connected to a different openTag account; nothing was changed.",
        next: "Ask the owner of that account to delete this computer in openTag (move or delete its Agents first), then run this command again.",
      };
    case "COMPUTER_IDENTITY_CONFLICT":
      return {
        reason: "openTag already has another Computer registered with this installation; nothing was changed.",
        next: NEW_COMMAND,
      };
    case "AUTH_USER_SUSPENDED":
      return {
        reason: "The openTag account that issued this code is suspended; nothing was changed.",
        next: "Contact your openTag administrator.",
      };
    default:
      break;
  }
  if (error.phase === "transport" || error.code === "SERVICE_UNAVAILABLE" || error.code === "TIMEOUT") {
    return {
      reason: `Could not reach the openTag server at ${server}; nothing was changed and the code was not used.`,
      next: "Check this computer's network connection, then run the same command again.",
    };
  }
  if (isPermissionProblem(error.message)) {
    return {
      reason: `openTag cannot write to its folder ${context.home} (permission denied); nothing was changed.`,
      next: "Fix the folder's permissions for this user (or set OPENTAG_HOME to a writable folder), then run the same command again.",
    };
  }
  if (isDiskFull(error.message)) {
    return {
      reason: `openTag cannot write to ${context.home} because the disk is full; nothing was changed.`,
      next: "Free some disk space, then run the same command again.",
    };
  }
  return {
    reason: `Connecting this computer failed: ${firstSentence(error.message)}`,
    next: "Run the same command again; if it keeps failing, get a new connect command from openTag.",
  };
}

export function formatConnectFailure(error: CommandError, message: ConnectFailureMessage): string {
  const detail = [error.code, error.requestId ? `request ${error.requestId}` : undefined].filter(Boolean).join(", ");
  return `${message.reason}\nNext: ${message.next}\n(details: ${detail})\n`;
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
