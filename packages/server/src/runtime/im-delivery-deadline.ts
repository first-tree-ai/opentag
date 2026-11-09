const OPERATION_TIMEOUT = "IM_DELIVERY_OPERATION_TIMEOUT";
export const DEFAULT_OPERATION_TIMEOUT_GRACE_MS = 1_000;

export function isOperationCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error === signal.reason;
}

/**
 * Wait for the timed-out operation: a settlement inside the grace is reported through
 * `onLateSettle`, and its work is awaited so the caller observes a durable outcome before this
 * attempt ends. Rejection with the deadline's own abort reason is cooperative cancellation. Past the grace the operation is abandoned — it may still settle later, so
 * `onLateSettle` never runs for it and the caller must not decide anything terminal about it.
 */
async function settleAfterTimeout(
  operation: Promise<void>,
  graceMs: number,
  onLateSettle: () => Promise<void>,
  onAbandoned: () => void,
  signal: AbortSignal,
): Promise<void> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = new Promise<"late" | "abandoned" | "cancelled">((resolve) => {
    const settle = (cancelled = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(cancelled ? "cancelled" : "late");
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve("abandoned");
    }, graceMs);
    timer.unref();
    void operation.then(
      () => settle(),
      (error: unknown) => settle(isOperationCancellation(error, signal)),
    );
  });
  const result = await outcome;
  if (result === "abandoned") onAbandoned();
  else if (result === "late") await onLateSettle();
}

async function handleTimeout(
  operation: Promise<void>,
  graceMs: number,
  onTimeout: () => Promise<void>,
  onLateSettle: () => Promise<void>,
  onAbandoned: () => void,
  signal: AbortSignal,
): Promise<void> {
  let timeoutFailure: unknown;
  try {
    // The timed-out operation is still in flight here, so this callback must not decide anything
    // that depends on its outcome; it only records the attempt and schedules the retry.
    await onTimeout();
  } catch (error) {
    timeoutFailure = error;
  }
  await settleAfterTimeout(operation, graceMs, onLateSettle, onAbandoned, signal);
  if (timeoutFailure) throw timeoutFailure;
}

export async function withOperationDeadline(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<void>,
  onTimeout: () => Promise<void>,
  onLateSettle: () => Promise<void>,
  onAbandoned: () => void = () => undefined,
  graceMs = DEFAULT_OPERATION_TIMEOUT_GRACE_MS,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(OPERATION_TIMEOUT));
      reject(new Error(OPERATION_TIMEOUT));
    }, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([operationPromise, timeout]);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== OPERATION_TIMEOUT) throw error;
    await handleTimeout(operationPromise, graceMs, onTimeout, onLateSettle, onAbandoned, controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
