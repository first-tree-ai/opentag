/**
 * Barrier helpers for concurrency tests that pause a service inside a transaction.
 *
 * A paused read or write holds an open transaction on its own pooled connection. If the test body fails before it
 * releases the barrier, the operation never finishes and `afterEach` blocks closing that pool — the test file hangs
 * instead of failing. These helpers make the release and the settling of every spawned promise unconditional, so a
 * failing assertion surfaces as that assertion rather than as a timeout in cleanup.
 */

/** A settled outcome, so a paused operation is inspected instead of throwing from a `finally`. */
export type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

/** Turns a promise into a value that never rejects, so awaiting it in cleanup cannot mask the primary error. */
export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason) => ({ status: "rejected", reason }) as const,
  );
}

/** What happened to the gated work, so the caller can re-throw it after inspecting the settled operations. */
export type GateOutcome = { failed: true; error: unknown } | { failed: false };

/**
 * Runs `gate` — the work that must happen while the operation is paused — and always releases the barrier.
 *
 * The release and the wait for every spawned promise are in `finally`, and the spawned promises are passed through
 * `settle` so waiting for them cannot throw. The gate's own failure is returned rather than thrown here, so the
 * caller can still assert the paused operation's outcome and then re-throw the primary error.
 */
export async function whilePaused<T>(input: {
  release: { resolve: () => void };
  settled: readonly Promise<Settled<unknown>>[];
  gate: () => Promise<T>;
}): Promise<GateOutcome> {
  let gateFailure: unknown;
  let failed = false;
  try {
    await input.gate();
  } catch (error) {
    gateFailure = error;
    failed = true;
  } finally {
    input.release.resolve();
    await Promise.all(input.settled);
  }
  return failed ? { failed: true, error: gateFailure } : { failed: false };
}

/** Re-throws a gated failure, so the primary assertion error stays the one the test reports. */
export function rethrowGateFailure(outcome: GateOutcome): void {
  if (outcome.failed) throw outcome.error;
}
