import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { RouterWebClient } from "../runtime-credentials/web-router-client.js";

const BASE = "https://router.internal";

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  ) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const searchResult = {
  requestId: "r1",
  status: "ok",
  retrievedAt: "2026-09-17T00:00:00Z",
  effectiveDepth: "basic",
  results: [{ sourceId: "s", title: "t", url: "https://a.com", snippet: "x" }],
};

describe("RouterWebClient", () => {
  it("posts business params with reconstructed auth, idempotency, and remaining budget", async () => {
    const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const client = new RouterWebClient({
      baseUrl: BASE,
      fetchImpl: stubFetch(async (url, init) => {
        seen.url = url;
        seen.headers = Object.fromEntries(Object.entries((init.headers as Record<string, string> | undefined) ?? {}));
        seen.body = String(init.body);
        return jsonResponse(200, searchResult);
      }),
    });
    const result = await client.search({
      idempotencyKey: "opentag.web.v1:e:c",
      params: { query: "q", limit: 5, depth: "basic" },
      remainingMs: 12_000,
      routerKey: "tvly-key",
    });
    expect(result.requestId).toBe("r1");
    expect(seen.url).toBe(`${BASE}/v1/web/search`);
    expect(seen.headers?.authorization).toBe("Bearer tvly-key");
    expect(seen.headers?.["idempotency-key"]).toBe("opentag.web.v1:e:c");
    expect(seen.headers?.["x-web-timeout-ms"]).toBe("12000");
    expect(JSON.parse(seen.body ?? "")).toEqual({ query: "q", limit: 5, depth: "basic" });
  });

  it("caps the timeout header at the operation bound", async () => {
    const seen: { headers?: Record<string, string> } = {};
    const client = new RouterWebClient({
      baseUrl: BASE,
      fetchImpl: stubFetch(async (_url, init) => {
        seen.headers = Object.fromEntries(Object.entries(init.headers ?? {}));
        return jsonResponse(200, { ...searchResult, results: [] });
      }),
    });
    await client.search({
      idempotencyKey: "k",
      params: { query: "q", limit: 5, depth: "basic" },
      remainingMs: 999_999,
      routerKey: "key",
    });
    expect(seen.headers?.["x-web-timeout-ms"]).toBe("15000");
  });

  it("maps Router error statuses to bounded codes without echoing the upstream body", async () => {
    const cases: Array<[number, unknown, string, boolean | undefined]> = [
      [
        409,
        { error: { message: "conflict", type: "idempotency_error", code: "idempotency_conflict" } },
        "idempotency_conflict",
        undefined,
      ],
      [
        409,
        { error: { message: "conflict", type: "idempotency_error", code: "idempotency_key_reuse" } },
        "idempotency_conflict",
        undefined,
      ],
      [
        409,
        { error: { message: "running", type: "invalid_request_error", code: "request_in_progress" } },
        "request_in_progress",
        true,
      ],
      [
        409,
        { error: { message: "uncertain", type: "invalid_request_error", code: "request_uncertain" } },
        "request_uncertain",
        undefined,
      ],
      [
        409,
        { error: { message: "purged", type: "invalid_request_error", code: "result_unavailable" } },
        "result_unavailable",
        undefined,
      ],
      [
        402,
        { error: { message: "billing", type: "billing_error", code: "insufficient_credit" } },
        "insufficient_credit",
        undefined,
      ],
      [429, { error: { message: "slow down", type: "rate_limit", code: "rate_limited" } }, "rate_limited", true],
      [500, { error: { message: "boom", type: "server_error" } }, "upstream_unavailable", true],
      [401, { error: { message: "bad key", type: "auth" } }, "upstream_error", undefined],
      [400, { error: { message: "invalid", type: "invalid_request" } }, "invalid_request", undefined],
      [418, { error: { message: "teapot", type: "weird" } }, "unknown", undefined],
    ];
    for (const [status, body, code, retryable] of cases) {
      const client = new RouterWebClient({
        baseUrl: BASE,
        fetchImpl: stubFetch(async () => jsonResponse(status, body)),
      });
      const failure = await client
        .search({
          idempotencyKey: "k",
          params: { query: "q", limit: 5, depth: "basic" },
          remainingMs: 5000,
          routerKey: "key",
        })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code, message: expect.not.stringContaining("teapot") });
      expect((failure as { retryable?: boolean }).retryable).toBe(retryable);
    }
  });

  it("rejects oversized and malformed Router payloads", async () => {
    const huge = new RouterWebClient({
      baseUrl: BASE,
      fetchImpl: stubFetch(async () =>
        jsonResponse(200, { ...searchResult, results: [{ ...searchResult.results[0], snippet: "x".repeat(9000) }] }),
      ),
    });
    await expect(
      huge.search({
        idempotencyKey: "k",
        params: { query: "q", limit: 5, depth: "basic" },
        remainingMs: 5000,
        routerKey: "key",
      }),
    ).rejects.toMatchObject({ code: "provider_protocol_error" });

    const garbage = new RouterWebClient({
      baseUrl: BASE,
      fetchImpl: stubFetch(async () => new Response("not json", { status: 200 })),
    });
    await expect(
      garbage.search({
        idempotencyKey: "k",
        params: { query: "q", limit: 5, depth: "basic" },
        remainingMs: 5000,
        routerKey: "key",
      }),
    ).rejects.toMatchObject({ code: "provider_protocol_error" });
  });

  it("maps network failures to retryable upstream_unavailable and caller aborts to aborted", async () => {
    const down = new RouterWebClient({
      baseUrl: BASE,
      fetchImpl: stubFetch(async () => {
        throw new TypeError("connect ECONNREFUSED");
      }),
    });
    await expect(
      down.search({
        idempotencyKey: "k",
        params: { query: "q", limit: 5, depth: "basic" },
        remainingMs: 5000,
        routerKey: "key",
      }),
    ).rejects.toMatchObject({ code: "upstream_unavailable", retryable: true });

    const hanging = new RouterWebClient({
      baseUrl: BASE,
      fetchImpl: stubFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    });
    const abort = new AbortController();
    const pending = hanging.search({
      idempotencyKey: "k",
      params: { query: "q", limit: 5, depth: "basic" },
      remainingMs: 60_000,
      routerKey: "key",
      signal: abort.signal,
    });
    abort.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("fails closed before dispatch for an expired or explicitly invalid budget", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ...searchResult, results: [] }));
    const client = new RouterWebClient({ baseUrl: BASE, fetchImpl: fetchMock as unknown as typeof fetch });
    for (const remainingMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        client.search({
          idempotencyKey: "k",
          params: { query: "q", limit: 5, depth: "basic" },
          remainingMs,
          routerKey: "key",
        }),
      ).rejects.toMatchObject({ code: "timeout", retryable: true });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an absent budget as the operation cap", async () => {
    const seen: { headers?: Record<string, string> } = {};
    const client = new RouterWebClient({
      baseUrl: BASE,
      fetchImpl: stubFetch(async (_url, init) => {
        seen.headers = Object.fromEntries(Object.entries(init.headers ?? {}));
        return jsonResponse(200, { ...searchResult, results: [] });
      }),
    });
    await client.search({ idempotencyKey: "k", params: { query: "q", limit: 5, depth: "basic" }, routerKey: "key" });
    expect(seen.headers?.["x-web-timeout-ms"]).toBe("15000");
  });

  it("maps a header-phase deadline exhaustion to a retryable timeout", async () => {
    const slow = new RouterWebClient({
      baseUrl: BASE,
      fetchImpl: stubFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "TimeoutError")));
          }),
      ),
    });
    await expect(
      slow.search({
        idempotencyKey: "k",
        params: { query: "q", limit: 5, depth: "basic" },
        remainingMs: 25,
        routerKey: "key",
      }),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("maps a slow upstream body to timeout instead of a raw TimeoutError", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      const timer = setTimeout(() => response.end(JSON.stringify(searchResult).slice(1)), 1_000);
      response.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = new RouterWebClient({ baseUrl: `http://127.0.0.1:${port}` });
    const startedAt = Date.now();
    try {
      const failure = await client
        .search({
          idempotencyKey: "k",
          params: { query: "q", limit: 5, depth: "basic" },
          remainingMs: 80,
          routerKey: "key",
        })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: "RuntimeWebError", code: "timeout", retryable: true });
      expect(Date.now() - startedAt).toBeLessThan(900);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
