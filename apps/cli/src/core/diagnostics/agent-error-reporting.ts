import type { AgentTurnErrorReporter, AgentTurnFailure } from "@opentag/client";
import type { TurnFailureReason } from "@opentag/shared";
import type { CliErrorReportOptions } from "./error-reporting.js";
import { reportCliError } from "./error-reporting.js";

/**
 * Turn failures that describe OpenTag rather than the machine, the provider, or the caller.
 *
 * The same judgement `shouldReportCommandError` makes for commands, applied to the other way a
 * failure reaches a reader. Everything left out is an answer the runtime gave on purpose: a provider
 * that is not installed or refused the prompt, a credential the Account has not supplied, a sandbox
 * this machine cannot open, a budget that ran out, a shutdown. Those are worth a log line and a
 * message to the person, not a tracker entry that no release can ever fix.
 *
 * `turn_state_unknown` is in, and is the important one: it is the catch-all for a throw nothing
 * classified, which is exactly the shape of a defect nobody has seen yet.
 */
const REPORTED_TURN_FAILURES: ReadonlySet<TurnFailureReason> = new Set([
  "provider_protocol_error",
  "provider_teardown_failed",
  "session_resume_failed",
  "turn_state_unknown",
]);

export function shouldReportTurnFailure(failure: Pick<AgentTurnFailure, "errorReason">): boolean {
  return failure.errorReason !== undefined && REPORTED_TURN_FAILURES.has(failure.errorReason);
}

export interface AgentErrorReporterOptions extends Pick<CliErrorReportOptions, "environment" | "home" | "fetchImpl"> {
  /** Which provider ran the Session, when the runtime can still say; it often cannot after a failure. */
  resolveProvider?: (sessionId: string) => string | undefined;
  /** Injected so a test can await the relay the runner deliberately does not wait for. */
  onReported?: (result: Promise<{ ok: boolean }>) => void;
}

/**
 * Relay Agent turn failures from the daemon.
 *
 * Returns synchronously and swallows everything: the runner calls this on the path that is already
 * failing a turn, and a tracker that is slow, unreachable, or broken must not add to that.
 */
export function createAgentErrorReporter(options: AgentErrorReporterOptions = {}): AgentTurnErrorReporter {
  const { resolveProvider, onReported, ...reportOptions } = options;
  return (failure) => {
    if (!shouldReportTurnFailure(failure)) return;
    const relay = reportCliError(failure.error, {
      ...reportOptions,
      command: "daemon service-run",
      agent: {
        agentId: failure.agentId,
        sessionId: failure.sessionId,
        turnId: failure.turnId,
        provider: resolveProvider?.(failure.sessionId),
      },
    }).catch(() => ({ ok: false }));
    onReported?.(relay);
  };
}
