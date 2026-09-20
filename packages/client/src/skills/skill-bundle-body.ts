/**
 * Bounded body reader for a Skill bundle response.
 *
 * `OpenTagApi.#fetchResponse` clears its request timer and abort listener as soon as response
 * headers arrive, so awaiting `response.arrayBuffer()` puts the body outside every deadline the
 * API applied. A server that sends headers and then stalls would hold runtime start indefinitely.
 * This reader races every chunk against the caller's signal, caps the body at the bundle's declared
 * length, and cancels the underlying stream on abort or overrun.
 */

/** `skill pull` is an interactive command, so its body deadline is far longer than a sync budget. */
export const SKILL_PULL_BUNDLE_TIMEOUT_MS = 60_000;

export interface ReadBundleBodyOptions {
  readonly signal: AbortSignal;
  /** The bundle's declared compressed byte length; an over-long body is rejected before buffering. */
  readonly maxBytes: number;
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function readBundleBody(response: Response, options: ReadBundleBodyOptions): Promise<Uint8Array> {
  const body = response.body;
  if (!body) throw new Error("Skill bundle response has no body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader, options.signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > options.maxBytes) {
        throw new Error(`Skill bundle body exceeds the expected ${options.maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
