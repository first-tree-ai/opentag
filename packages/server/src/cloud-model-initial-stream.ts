import { cloudModelRetryAfter } from "./cloud-model-retry.js";

const CLOUD_MODEL_STREAM_PRELUDE_MAX_BYTES = 8 * 1024;

function initialRateLimit(data: string): { retryAfter?: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 1 || !("error" in value)) {
    return undefined;
  }
  const error = value.error;
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "rate_limit_exceeded") {
    return undefined;
  }
  if (!("pre_stream_rejection" in error) || error.pre_stream_rejection !== true) return undefined;
  const retryAfter =
    "retry_after" in error && typeof error.retry_after === "string"
      ? cloudModelRetryAfter(error.retry_after)
      : undefined;
  return retryAfter === undefined ? {} : { retryAfter };
}

function firstData(text: string): string | undefined {
  const events = text.replaceAll("\r\n", "\n").split("\n\n");
  events.pop();
  for (const event of events) {
    const lines = event.split("\n").filter((line) => line.startsWith("data:"));
    if (lines.length) return lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  }
  return undefined;
}

function rateLimitResponse(upstream: Response, hint?: string): Response {
  const retryAfter = hint ?? cloudModelRetryAfter(upstream.headers.get("retry-after"));
  return Response.json(
    { error: { code: "rate_limit_exceeded", message: "The model upstream rate limit was reached" } },
    { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } },
  );
}

function replayPrefix(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

/** Router streaming rejections arrive as HTTP 200 SSE; classify only before any model data is sent. */
export async function normalizeInitialModelStream(upstream: Response): Promise<Response> {
  if (
    upstream.status !== 200 ||
    !upstream.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
    !upstream.body
  ) {
    return upstream;
  }
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < CLOUD_MODEL_STREAM_PRELUDE_MAX_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Model stream ended before its first data event");
      chunks.push(chunk.value);
      text += decoder.decode(chunk.value.subarray(0, CLOUD_MODEL_STREAM_PRELUDE_MAX_BYTES - bytes), { stream: true });
      bytes += chunk.value.byteLength;
      const data = firstData(text);
      if (data === undefined) continue;
      const rejection = initialRateLimit(data);
      if (!rejection) break;
      await reader.cancel();
      reader.releaseLock();
      return rateLimitResponse(upstream, rejection.retryAfter);
    }
    return new Response(replayPrefix(reader, chunks), { status: upstream.status, headers: upstream.headers });
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw error;
  }
}
