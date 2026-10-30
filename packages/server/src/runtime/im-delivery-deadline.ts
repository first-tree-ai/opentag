const OPERATION_TIMEOUT = "IM_DELIVERY_OPERATION_TIMEOUT";
export const DEFAULT_OPERATION_TIMEOUT_GRACE_MS = 1_000;

/**
 * Wait for the timed-out operation: a settlement inside the grace is reported through
 * `onLateSettle`, and its work is awaited so the caller observes a durable outcome before this
 * attempt ends. Past the grace the operation is abandoned — it may still settle later, so
 * `onLateSettle` never runs for it and the caller must not decide anything terminal about it.
 */
async function settleAfterTimeout(
  operation: Promise<void>,
  graceMs: number,
  onLateSettle: () => Promise<void>,
  onAbandoned: () => void,
): Promise<void> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = new Promise<"late" | "abandoned">((resolve) => {
    const settle = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve("late");
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve("abandoned");
    }, graceMs);
    timer.unref();
    void operation.then(settle, settle);
  });
  if ((await outcome) === "abandoned") onAbandoned();
  else await onLateSettle();
}

async function handleTimeout(
  operation: Promise<void>,
  graceMs: number,
  onTimeout: () => Promise<void>,
  onLateSettle: () => Promise<void>,
  onAbandoned: () => void,
): Promise<void> {
  let timeoutFailure: unknown;
  try {
    // The timed-out operation is still in flight here, so this callback must not decide anything
    // that depends on its outcome; it only records the attempt and schedules the retry.
    await onTimeout();
  } catch (error) {
    timeoutFailure = error;
  }
  await settleAfterTimeout(operation, graceMs, onLateSettle, onAbandoned);
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
    await handleTimeout(operationPromise, graceMs, onTimeout, onLateSettle, onAbandoned);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
