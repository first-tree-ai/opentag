import { CloudRunAdminError } from "./errors.js";

/** Limit bytes while streaming, before allocating a potentially untrusted response body. */
export async function readBoundedJson(response: Response, limit = 256 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new CloudRunAdminError("unknown", "Cloud Run response has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new CloudRunAdminError("unknown", "Cloud Run response exceeded bounds");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) {
    if (error instanceof CloudRunAdminError) throw error;
    throw new CloudRunAdminError("unknown", "Cloud Run response could not be decoded");
  } finally {
    reader.releaseLock();
  }
}
