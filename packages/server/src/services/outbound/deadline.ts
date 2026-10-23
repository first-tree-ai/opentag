/**
 * One deadline for a whole outbound operation: the address check *and* the request it authorizes.
 *
 * The two halves of an outbound call are in different places — resolving a name is not abortable and
 * does not belong to the transport, and the request is a separate library — so bounding them
 * separately means the operation as a whole can take the sum of the two, and a resolver that never
 * answers is bounded by nothing at all. Here the budget starts when the operation does and covers
 * whatever step is running.
 *
 * Invariant: the returned promise settles within `timeoutMs` of entry, or when the caller's signal
 * aborts, whichever comes first — regardless of which step is running. The work it started is not
 * stopped, because a DNS promise cannot be stopped, so it stays observed instead: its rejection is
 * handled by the race, and its continuation must call `throwIfEnded` before dialing. Without that
 * check a call would settle as failed and then still send its request.
 *
 * Boundary: the caller owns everything else — a stream it opened, a concurrency slot it took — since
 * only the caller knows what to release. This module owns one timer, and one listener on the
 * caller's signal, and removes both however the operation ends.
 */

export type OutboundDeadlineReason = "deadline" | "aborted";

export interface OutboundDeadlineOptions {
  /** Total budget for the operation, from entry to the response. */
  timeoutMs: number;
  /** The caller's cancellation, honoured even when it is already aborted before entry. */
  signal?: AbortSignal;
  /** The failure this operation reports for an expired budget or a cancellation. */
  failure: (reason: OutboundDeadlineReason) => Error;
}

export interface OutboundDeadline {
  /**
   * Aborted when the budget expires or the caller cancels. Pass it to the request so the socket is
   * closed at the same moment the caller learns the operation failed.
   */
  readonly signal: AbortSignal;
  /** Milliseconds left before the budget expires. Zero once it has. */
  remainingMs(): number;
  /**
   * Throws the mapped failure when the budget already expired or the caller cancelled. Call it
   * after every un-interruptible step, before starting the next one.
   */
  throwIfEnded(): void;
}

export async function withOutboundDeadline<T>(
  options: OutboundDeadlineOptions,
  run: (deadline: OutboundDeadline) => Promise<T>,
): Promise<T> {
  const { timeoutMs, signal } = options;
  if (signal?.aborted === true) throw options.failure("aborted");

  const controller = new AbortController();
  const startedAt = Date.now();
  let ended: Error | undefined;
  let expire!: (error: Error) => void;
  const expiry = new Promise<never>((_resolve, reject) => {
    expire = reject;
  });

  const end = (reason: OutboundDeadlineReason) => {
    if (ended !== undefined) return;
    ended = options.failure(reason);
    // Before the rejection: the socket must not outlive the answer the caller got.
    controller.abort();
    expire(ended);
  };
  const timer = setTimeout(() => end("deadline"), timeoutMs);
  const onAbort = () => end("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await Promise.race([
      run({
        signal: controller.signal,
        remainingMs: () => Math.max(0, timeoutMs - (Date.now() - startedAt)),
        throwIfEnded: () => {
          if (ended !== undefined) throw ended;
        },
      }),
      expiry,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
