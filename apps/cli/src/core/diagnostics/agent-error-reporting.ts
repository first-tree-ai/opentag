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
 * Only what the runner can actually emit is listed. `provider_protocol_error` is a provider that
 * answered in a shape the runtime could not read, whether it threw or returned it.
 * `turn_state_unknown` is the important one: it is the catch-all for a throw nothing classified,
 * which is exactly the shape of a defect nobody has seen yet. `provider_teardown_failed` and
 * `session_resume_failed` exist in the shared taxonomy but nothing in the Client produces them
 * yet; they join this set when a producer does, not before.
 */
const REPORTED_TURN_FAILURES: ReadonlySet<TurnFailureReason> = new Set([
  "provider_protocol_error",
  "turn_state_unknown",
]);

export function shouldReportTurnFailure(failure: Pick<AgentTurnFailure, "errorReason">): boolean {
  return failure.errorReason !== undefined && REPORTED_TURN_FAILURES.has(failure.errorReason);
}

/** How long one Session's repeat of the same failure stays unreported after a relay. */
export const AGENT_ERROR_REPORT_COOLDOWN_MS = 30_000;
/** Distinct failures remembered for the cooldown; beyond this the oldest is forgotten first. */
const MAX_TRACKED_FAILURES = 200;

export interface AgentErrorReporterOptions extends Pick<CliErrorReportOptions, "environment" | "home" | "fetchImpl"> {
  /** Which provider ran the Session, when the runtime can still say; it often cannot after a failure. */
  resolveProvider?: (sessionId: string) => string | undefined;
  /** Injected so a test can await the relay the runner deliberately does not wait for. */
  onReported?: (result: Promise<{ ok: boolean }>) => void;
  /** Overrides the cooldown; `0` relays every reportable failure. */
  cooldownMs?: number;
  now?: () => number;
}

/**
 * Relay Agent turn failures from the daemon.
 *
 * Returns synchronously and swallows everything: the runner calls this on the path that is already
 * failing a turn, and a tracker that is slow, unreachable, or broken must not add to that.
 *
 * One failure per Session and reason per cooldown, the same shape the Web App sink applies: the
 * daemon is long-lived, and a Session whose every turn fails the same way would otherwise post one
 * report per turn for as long as it is written to, saying nothing the first one did not.
 */
export function createAgentErrorReporter(options: AgentErrorReporterOptions = {}): AgentTurnErrorReporter {
  const { resolveProvider, onReported, cooldownMs, now, ...reportOptions } = options;
  const cooldown = new FailureCooldown(Math.max(0, cooldownMs ?? AGENT_ERROR_REPORT_COOLDOWN_MS), now ?? Date.now);
  return (failure) => {
    if (!shouldReportTurnFailure(failure)) return;
    if (!cooldown.admit(`${failure.errorReason}\u0000${failure.sessionId}`)) return;
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

/**
 * Remembers when each failure key was last relayed. Bounded: expired entries go first, then the
 * oldest, because Map insertion order is age order and every key is re-inserted when it is relayed.
 */
class FailureCooldown {
  readonly #lastSentAt = new Map<string, number>();

  constructor(
    readonly cooldownMs: number,
    readonly now: () => number,
  ) {}

  /** Records the key as relayed now and says whether it is due, or refuses it inside its cooldown. */
  admit(key: string): boolean {
    const at = this.now();
    const previous = this.#lastSentAt.get(key);
    if (previous !== undefined && at >= previous && at - previous < this.cooldownMs) return false;
    for (const [trackedKey, sentAt] of this.#lastSentAt) {
      if (at - sentAt >= this.cooldownMs) this.#lastSentAt.delete(trackedKey);
    }
    this.#lastSentAt.delete(key);
    this.#lastSentAt.set(key, at);
    while (this.#lastSentAt.size > MAX_TRACKED_FAILURES) {
      const oldest = this.#lastSentAt.keys().next();
      if (oldest.done) break;
      this.#lastSentAt.delete(oldest.value);
    }
    return true;
  }
}
