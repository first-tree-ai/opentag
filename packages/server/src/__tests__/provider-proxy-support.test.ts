import { describe, expect, it } from "vitest";
import { parseJsonResponse } from "../runtime-credentials/provider-proxy-support.js";
import {
  classifyStatusWriteOutcome,
  classifyWriteOutcome,
  type WriteOutcome,
} from "../runtime-credentials/write-outcome.js";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

describe("parseJsonResponse bounded reading", () => {
  it("parses valid JSON, treats empty bodies as {}, and rejects malformed JSON", async () => {
    await expect(parseJsonResponse(new Response(streamOf('{"ok":true}')), 64)).resolves.toEqual({ ok: true });
    await expect(parseJsonResponse(new Response(streamOf()), 64)).resolves.toEqual({});
    await expect(parseJsonResponse(new Response(null), 64)).resolves.toEqual({});
    await expect(parseJsonResponse(new Response(streamOf("not json")), 64)).rejects.toMatchObject({
      code: "response_invalid",
    });
  });

  it("cancels an oversized response as soon as the byte bound is exceeded", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        pulls += 1;
        if (pulls > 64) {
          controller.error(new Error("the response stream was exhausted"));
          return;
        }
        controller.enqueue(new TextEncoder().encode("0123456789"));
      },
    });
    await expect(parseJsonResponse(new Response(stream), 25)).rejects.toMatchObject({ code: "response_invalid" });
    expect(cancelled).toBe(true);
    // 10-byte chunks: the third read crosses 25 bytes and stops the stream instead of draining it.
    expect(pulls).toBeLessThanOrEqual(4);
  });

  it("accepts a response exactly at the byte bound and rejects one byte over", async () => {
    const payload = '{"ok":true}';
    const size = Buffer.byteLength(payload, "utf8");
    await expect(parseJsonResponse(new Response(streamOf(payload)), size)).resolves.toEqual({ ok: true });
    await expect(parseJsonResponse(new Response(streamOf(payload)), size - 1)).rejects.toMatchObject({
      code: "response_invalid",
    });
  });
});

describe("write outcome classification", () => {
  it("requires HTTP 2xx plus the provider success shape for a confirmed success", () => {
    expect(classifyWriteOutcome({ payload: { ok: true, ts: "1" }, provider: "slack", status: 200 })).toEqual({
      state: "succeeded",
      code: "http_200",
    });
    expect(classifyWriteOutcome({ payload: { code: 0, data: {} }, provider: "feishu", status: 200 })).toEqual({
      state: "succeeded",
      code: "http_200",
    });
    expect(classifyWriteOutcome({ payload: { ok: true }, provider: "feishu", status: 200 })).toEqual({
      state: "unknown",
      code: "provider_outcome_unconfirmed",
    });
    expect(classifyWriteOutcome({ payload: { code: 0 }, provider: "slack", status: 200 })).toEqual({
      state: "unknown",
      code: "provider_outcome_unconfirmed",
    });
  });

  it("uses controlled bounded codes for explicit provider rejections", () => {
    expect(
      classifyWriteOutcome({ payload: { ok: false, error: "channel_not_found" }, provider: "slack", status: 200 }),
    ).toEqual({
      state: "rejected",
      code: "channel_not_found",
    });
    expect(
      classifyWriteOutcome({ payload: { ok: false, error: "not a code!!" }, provider: "slack", status: 200 }),
    ).toEqual({
      state: "rejected",
      code: "provider_rejected",
    });
    expect(classifyWriteOutcome({ payload: { code: 99991400 }, provider: "feishu", status: 200 })).toEqual({
      state: "rejected",
      code: "feishu_99991400",
    });
    // A definite 4xx is a rejection even without a provider shape.
    expect(classifyWriteOutcome({ payload: { message: "bad" }, provider: "slack", status: 400 })).toEqual({
      state: "rejected",
      code: "http_400",
    });
  });

  it.each([
    ["a 5xx provider failure", 503, { ok: false, error: "server_error" }],
    ["a 408 timeout", 408, { ok: true, ts: "1" }],
    ["a 2xx body without success evidence", 200, {}],
  ] as Array<[string, number, unknown]>)("keeps %s unknown", (_label, status, payload) => {
    const outcome: WriteOutcome = classifyWriteOutcome({ payload, provider: "slack", status });
    expect(outcome.state).toBe("unknown");
    expect(outcome.code).not.toBe("http_200");
  });
});

describe("status-only write outcome classification", () => {
  it("accepts 2xx, rejects definite 4xx, and keeps 5xx/408 unknown", () => {
    expect(classifyStatusWriteOutcome(204)).toEqual({ state: "succeeded", code: "http_204" });
    expect(classifyStatusWriteOutcome(403)).toEqual({ state: "rejected", code: "http_403" });
    expect(classifyStatusWriteOutcome(408)).toEqual({ state: "unknown", code: "http_408" });
    expect(classifyStatusWriteOutcome(503)).toEqual({ state: "unknown", code: "http_503" });
  });
});
