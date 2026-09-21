import type { WebFetchExecutionRequest, WebSearchExecutionRequest } from "@opentag/shared";
import { WEB_TIMEOUT_HEADER } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { WebToolsClientError, WebToolsServerClient } from "../runtime/web-tools-client.js";

const searchRequest: WebSearchExecutionRequest = {
  protocolVersion: 1,
  executionId: "11111111-2222-4333-8444-555555555555",
  toolCallId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  query: "open tag",
  limit: 5,
  depth: "basic",
};

const fetchRequest: WebFetchExecutionRequest = {
  protocolVersion: 1,
  executionId: "11111111-2222-4333-8444-555555555555",
  toolCallId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  urls: ["https://example.com/page"],
  depth: "basic",
};

const searchResult = {
  requestId: "r1",
  status: "ok" as const,
  retrievedAt: "2026-09-17T00:00:00.000Z",
  effectiveDepth: "basic" as const,
  results: [],
};

function client(options: { fetchImpl: typeof fetch }): WebToolsServerClient {
  return new WebToolsServerClient({
    serverUrl: "https://server.example.test",
    machineToken: "machine-token",
    fetchImpl: options.fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("WebToolsServerClient", () => {
  it("forwards the operation cap when no remaining budget is supplied and the exact remainder otherwise", async () => {
    const headers: Array<string | null> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get(WEB_TIMEOUT_HEADER));
      return jsonResponse(searchResult);
    }) as typeof fetch;
    const web = client({ fetchImpl });
    await web.search({ request: searchRequest });
    await web.search({ request: searchRequest, remainingMs: 4_321 });
    await web.fetch({ request: fetchRequest });
    expect(headers).toEqual(["15000", "4321", "45000"]);
  });

  it("fails before dispatch when the remaining budget is already exhausted", async () => {
    let calls = 0;
    const web = client({
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(searchResult);
      }) as typeof fetch,
    });
    for (const remainingMs of [0, -1, 1.5, Number.NaN]) {
      await expect(web.search({ request: searchRequest, remainingMs })).rejects.toMatchObject({
        code: "timeout",
      });
    }
    expect(calls).toBe(0);
  });

  it("preserves Router lifecycle and credit error codes from the Server envelope", async () => {
    const cases: Array<[number, string]> = [
      [409, "request_in_progress"],
      [409, "request_uncertain"],
      [409, "idempotency_conflict"],
      [402, "insufficient_credit"],
      [410, "result_unavailable"],
    ];
    for (const [status, code] of cases) {
      const web = client({
        fetchImpl: (async () => jsonResponse({ error: { code, message: "bounded" } }, status)) as typeof fetch,
      });
      await expect(web.search({ request: searchRequest })).rejects.toMatchObject({ code });
    }
    // A bare status without an envelope still maps meaningfully.
    const bare = client({
      fetchImpl: (async () => jsonResponse({}, 402)) as typeof fetch,
    });
    await expect(bare.search({ request: searchRequest })).rejects.toMatchObject({ code: "insufficient_credit" });
  });

  it("times out a stalled response body under the combined deadline, not as a protocol error", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"requestId":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const web = client({
      fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch,
    });
    const error = await web.search({ request: searchRequest, remainingMs: 60 }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WebToolsClientError);
    expect((error as WebToolsClientError).code).toBe("timeout");
    expect(cancelled).toBe(true);
  });

  it("maps caller cancellation during a stalled body to aborted", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Never produces data; the caller aborts instead.
      },
    });
    const web = client({
      fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch,
    });
    const pending = web.search({ request: searchRequest, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("maps a slow body timeout whose fetch rejection is a bare DOM TimeoutError", async () => {
    const fetchImpl = (async () => {
      // Some fetch implementations reject with a numeric-code DOMException after their own
      // timeout; the trusted client must classify it by its own deadline, not by error name.
      throw Object.assign(new Error("The operation was aborted due to timeout"), { code: 23, name: "TimeoutError" });
    }) as typeof fetch;
    const web = client({ fetchImpl });
    await expect(web.search({ request: searchRequest, remainingMs: 40 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects malformed and schema-invalid successful payloads without echoing them", async () => {
    const malformed = client({
      fetchImpl: (async () =>
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    await expect(malformed.search({ request: searchRequest })).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
    const invalid = client({
      fetchImpl: (async () => jsonResponse({ requestId: "r1", status: "ok" })) as typeof fetch,
    });
    await expect(invalid.search({ request: searchRequest })).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("rejects a declared oversized body before reading it", async () => {
    const web = client({
      fetchImpl: (async () =>
        jsonResponse(searchResult, 200, { "content-length": String(8 * 1024 * 1024) })) as typeof fetch,
    });
    await expect(web.search({ request: searchRequest })).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("maps network failures to upstream_unavailable and caller aborts to aborted", async () => {
    const broken = client({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(broken.search({ request: searchRequest })).rejects.toMatchObject({ code: "upstream_unavailable" });

    const controller = new AbortController();
    const aborted = client({
      fetchImpl: (async () => {
        controller.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      }) as typeof fetch,
    });
    await expect(aborted.search({ request: searchRequest, signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
  });
});
