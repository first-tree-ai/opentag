const OPERATION_TIMEOUT = "IM_DELIVERY_OPERATION_TIMEOUT";
export const DEFAULT_OPERATION_TIMEOUT_GRACE_MS = 1_000;

async function settleAfterTimeout(
  operation: Promise<void>,
  graceMs: number,
  onLateSettle: () => void,
  onAbandoned: () => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    let released = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notifyLateSettle = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      onLateSettle();
      if (!released) resolve();
    };
    timer = setTimeout(() => {
      if (settled) return;
      released = true;
      onAbandoned();
      resolve();
    }, graceMs);
    timer.unref();
    void operation.then(notifyLateSettle, notifyLateSettle);
  });
}

async function handleTimeout(
  operation: Promise<void>,
  graceMs: number,
  onTimeout: () => Promise<void>,
  onLateSettle: () => void,
  onAbandoned: () => void,
): Promise<void> {
  let timeoutFailure: unknown;
  try {
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
  onLateSettle: () => void,
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
