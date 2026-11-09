import { describe, expect, it } from "vitest";
import { normalizeInitialModelStream } from "../cloud-model-initial-stream.js";

const RATE_LIMIT =
  'data: {"error":{"code":"rate_limit_exceeded","type":"rate_limit_error","pre_stream_rejection":true,"retry_after":"30","message":"private-upstream-text"}}\n\n';

function source(chunks: string[], cancel?: () => void): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
      cancel,
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("initial Router SSE rate-limit rejection", () => {
  it.each([
    [RATE_LIMIT],
    [": heartbeat\n\n", RATE_LIMIT],
    [": heartbeat\r\n\r\n", RATE_LIMIT.replaceAll("\n", "\r\n")],
    [...RATE_LIMIT],
  ])("classifies only a complete initial error event across chunk boundaries", async (...chunks) => {
    const response = await normalizeInitialModelStream(source(chunks));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.text()).not.toContain("private-upstream-text");
  });

  it.each([
    ['data: {"choices":[{"delta":{"content":"started"}}]}\n\n', RATE_LIMIT],
    ['data: {"error":{"code":"upstream_uncertain"}}\n\n'],
    ['data: {"error":{"code":"insufficient_quota"}}\n\n'],
    ['data: {"error":{"code":"context_length_exceeded"}}\n\n'],
    ['data: {"error":{"code":"rate_limit_exceeded"}}\n\n'],
    ['data: {"error":{"code":"rate_limit_exceeded","pre_stream_rejection":false}}\n\n'],
    ['data: {"error":{"code":"rate_limit_exceeded","pre_stream_rejection":"true"}}\n\n'],
    ['data: {"error":{"code":"rate_limit_exceeded"},"choices":[{}]}\n\n'],
    ["data: [DONE]\n\n"],
    ["data: invalid\n\n"],
    [`data: ${"x".repeat(9_000)}`, RATE_LIMIT],
  ])("preserves model data, uncertain failures and oversized prefixes byte for byte", async (...chunks) => {
    const response = await normalizeInitialModelStream(source(chunks));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(chunks.join(""));
  });

  it.each([[], [": heartbeat\n\n"], ['data: {"error":']])(
    "rejects clean EOF before a complete first data event",
    async (...chunks) => {
      const upstream = source(chunks);
      await expect(normalizeInitialModelStream(upstream)).rejects.toThrow("before its first data event");
      expect(upstream.body?.locked).toBe(false);
    },
  );

  it("propagates cancellation while waiting for the initial data event", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const upstream = new Response(
      new ReadableStream({
        start(value) {
          controller = value;
        },
      }),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
    const pending = normalizeInitialModelStream(upstream);
    const failed = expect(pending).rejects.toThrow("cancelled");
    controller?.error(new Error("cancelled"));
    await failed;
  });

  it("cancels the original reader when the preserved model stream is cancelled", async () => {
    let cancelled = false;
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const response = await normalizeInitialModelStream(upstream);
    await response.body?.cancel();
    expect(cancelled).toBe(true);
  });
});
