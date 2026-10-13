/** Provider cooldown metadata only; no upstream bodies or credentials. */
export class FailureReactionError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("IM_FAILURE_REACTION_RATE_LIMITED");
  }
}
