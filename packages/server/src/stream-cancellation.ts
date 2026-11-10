export function createStreamCancellation(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let errored = false;
  void reader.closed.catch(() => {
    errored = true;
  });

  return async (reason?: unknown): Promise<void> => {
    if (errored) return;
    try {
      await reader.cancel(reason);
    } catch (error) {
      // An errored stream rejects with its stored error. A source cancel failure leaves the stream closed.
      if (!errored) throw error;
    }
  };
}
