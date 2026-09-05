const OPERATION_TIMEOUT = "IM_DELIVERY_OPERATION_TIMEOUT";

async function settleAfterTimeout(operation: Promise<void>, onLateSettle: () => void): Promise<void> {
  await operation.catch(() => undefined);
  onLateSettle();
}

async function handleTimeout(
  operation: Promise<void>,
  onTimeout: () => Promise<void>,
  onLateSettle: () => void,
): Promise<void> {
  let timeoutFailure: unknown;
  try {
    await onTimeout();
  } catch (error) {
    timeoutFailure = error;
  }
  await settleAfterTimeout(operation, onLateSettle);
  if (timeoutFailure) throw timeoutFailure;
}

export async function withOperationDeadline(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<void>,
  onTimeout: () => Promise<void>,
  onLateSettle: () => void,
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
    await handleTimeout(operationPromise, onTimeout, onLateSettle);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
