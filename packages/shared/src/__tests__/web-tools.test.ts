import { describe, expect, it } from "vitest";
import {
  capWebTimeoutMs,
  deriveWebIdempotencyKey,
  normalizeWebTargetUrl,
  parseWebDomain,
  parseWebTargetUrl,
  parseWebTimeoutHeader,
  RouterGatewayErrorSchema,
  RuntimeExecutionServiceSchema,
  WEB_FETCH_RESPONSE_MAX_BYTES,
  WEB_FETCH_TIMEOUT_CAP_MS,
  WEB_GATEWAY_FETCH_PATH,
  WEB_GATEWAY_SEARCH_PATH,
  WEB_SEARCH_TIMEOUT_CAP_MS,
  WebFetchExecutionRequestSchema,
  WebFetchParamsSchema,
  WebFetchResultSchema,
  WebGatewayFetchRequestSchema,
  WebGatewaySearchRequestSchema,
  WebSearchExecutionRequestSchema,
  WebSearchParamsSchema,
  WebSearchResultSchema,
  WebToolErrorEnvelopeSchema,
} from "../web-tools.js";

describe("WebSearchParamsSchema", () => {
  it("applies defaults and accepts a minimal query", () => {
    const parsed = WebSearchParamsSchema.parse({ query: "opentag" });
    expect(parsed).toEqual({ query: "opentag", limit: 5, depth: "basic" });
  });

  it("bounds the query at 400 codepoints, not UTF-16 units", () => {
    const ok = "汉".repeat(400);
    expect(WebSearchParamsSchema.safeParse({ query: ok }).success).toBe(true);
    const tooLong = "汉".repeat(401);
    expect(WebSearchParamsSchema.safeParse({ query: tooLong }).success).toBe(false);
    // Astral characters count as one codepoint each.
    const astral = "𐍈".repeat(400);
    expect(astral.length).toBe(800);
    expect(WebSearchParamsSchema.safeParse({ query: astral }).success).toBe(true);
  });

  it("rejects unknown fields, out-of-range limits, and bad enums", () => {
    expect(WebSearchParamsSchema.safeParse({ query: "a", tenant: "x" }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", limit: 0 }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", limit: 11 }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", limit: 2.5 }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", depth: "deep" }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", timeRange: "hour" }).success).toBe(false);
  });

  it("validates domains as public host names only", () => {
    expect(WebSearchParamsSchema.safeParse({ query: "a", domains: ["example.com"] }).success).toBe(true);
    expect(WebSearchParamsSchema.safeParse({ query: "a", domains: ["https://example.com"] }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", domains: ["example.com/path"] }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", domains: ["*.example.com"] }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", domains: ["127.0.0.1"] }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", domains: ["user@example.com"] }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", domains: Array(11).fill("example.com") }).success).toBe(false);
    expect(parseWebDomain("bücher.example")).toBe("xn--bcher-kva.example");
    // Router rejects an empty list and single-label (intranet) names.
    expect(WebSearchParamsSchema.safeParse({ query: "a", domains: [] }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", domains: ["internal"] }).success).toBe(false);
    // IDNA names and trailing dots are accepted and normalized like the Router does.
    expect(parseWebDomain("例子.中国")).toBe("xn--fsqu00a.xn--fiqs8s");
    expect(parseWebDomain("example.com.")).toBe("example.com");
  });

  it("validates the language field as a 1..64-character bounded non-control string", () => {
    expect(WebSearchParamsSchema.safeParse({ query: "a", language: "zh-CN" }).success).toBe(true);
    // Free-form bounded strings are the aligned contract: the Router accepts them too.
    expect(WebSearchParamsSchema.safeParse({ query: "a", language: "english please" }).success).toBe(true);
    // Tavily accepts English names, and the Router accepts arbitrary 1..64-character strings.
    expect(WebSearchParamsSchema.safeParse({ query: "a", language: "portuguese" }).success).toBe(true);
    expect(WebSearchParamsSchema.safeParse({ query: "a", language: "x" }).success).toBe(true);
    expect(WebSearchParamsSchema.safeParse({ query: "a", language: "中文" }).success).toBe(true);
    expect(WebSearchParamsSchema.safeParse({ query: "a", language: "a".repeat(64) }).success).toBe(true);
    expect(WebSearchParamsSchema.safeParse({ query: "a", language: "a".repeat(65) }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", language: "en\u0000" }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", language: "\ud800" }).success).toBe(false);
  });

  it("rejects explicit null optional fields and lone surrogates", () => {
    expect(WebSearchParamsSchema.safeParse({ query: "a", timeRange: null }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", domains: null }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "a", language: null }).success).toBe(false);
    expect(WebSearchParamsSchema.safeParse({ query: "\ud800" }).success).toBe(false);
  });
});

describe("parseWebTargetUrl", () => {
  it("accepts public http/https targets", () => {
    expect(parseWebTargetUrl("https://example.com/page?x=1")?.hostname).toBe("example.com");
    expect(parseWebTargetUrl("http://8.8.8.8/dns")?.hostname).toBe("8.8.8.8");
    expect(parseWebTargetUrl("https://[2606:4700:4700::1111]/")?.hostname).toBe("[2606:4700:4700::1111]");
  });

  it("rejects non-http schemes, credentials, and empty hosts", () => {
    expect(parseWebTargetUrl("ftp://example.com/")).toBeUndefined();
    expect(parseWebTargetUrl("file:///etc/passwd")).toBeUndefined();
    expect(parseWebTargetUrl("https://user:pass@example.com/")).toBeUndefined();
    expect(parseWebTargetUrl("https://user@example.com/")).toBeUndefined();
    expect(parseWebTargetUrl("not a url")).toBeUndefined();
  });

  it("rejects non-public literal IPv4 destinations", () => {
    for (const host of [
      "http://127.0.0.1/",
      "http://10.0.0.8/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://224.0.0.1/",
      "http://192.0.0.8/",
      "http://192.0.2.1/",
      "http://198.51.100.7/",
      "http://203.0.113.9/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://0x7f.0.0.1/",
    ]) {
      expect(parseWebTargetUrl(host), host).toBeUndefined();
    }
    expect(parseWebTargetUrl("http://172.15.0.1/")?.hostname).toBe("172.15.0.1");
    expect(parseWebTargetUrl("http://100.63.255.1/")?.hostname).toBe("100.63.255.1");
    // Public addresses inside the wider blocks 192.0/16, 198.51/16, 203.0/16 must still pass.
    expect(parseWebTargetUrl("http://192.0.3.1/")?.hostname).toBe("192.0.3.1");
    expect(parseWebTargetUrl("http://198.51.101.1/")?.hostname).toBe("198.51.101.1");
    expect(parseWebTargetUrl("http://203.0.114.1/")?.hostname).toBe("203.0.114.1");
  });

  it("rejects non-public literal IPv6 destinations", () => {
    expect(parseWebTargetUrl("http://[::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[fe80::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[fc00::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[fd00::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[ff02::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[::ffff:127.0.0.1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[::ffff:10.1.2.3]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[2001:db8::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[::ffff:8.8.8.8]/")?.hostname).toBe("[::ffff:808:808]");
    // Actual reserved/transition ranges: discard-only, IETF protocol assignments, 6to4,
    // documentation, local-use NAT64.
    expect(parseWebTargetUrl("http://[100::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[2001::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[2001:2::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[2002::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[3fff::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[64:ff9b:1::1]/")).toBeUndefined();
    expect(parseWebTargetUrl("http://[2606:4700:4700::1111]/")).not.toBeUndefined();
  });

  it("rejects raw control characters and local-only host names", () => {
    expect(parseWebTargetUrl("https://example.com/a\nb")).toBeUndefined();
    expect(parseWebTargetUrl("https://example.com/a\rb")).toBeUndefined();
    expect(parseWebTargetUrl("https://exa\tmple.com/")).toBeUndefined();
    expect(parseWebTargetUrl(" https://example.com/")).toBeUndefined();
    expect(parseWebTargetUrl("http://metadata.google.internal/")).toBeUndefined();
    expect(parseWebTargetUrl("http://localhost/")).toBeUndefined();
    expect(parseWebTargetUrl("http://db.local/")).toBeUndefined();
    expect(parseWebTargetUrl("http://service.corp/")).toBeUndefined();
    expect(parseWebTargetUrl("http://intranet-host/")).toBeUndefined();
    expect(parseWebTargetUrl("http://example.com./")).toBeUndefined();
    expect(parseWebTargetUrl("https://\ud800.example/")).toBeUndefined();
    expect(parseWebTargetUrl("https://example.com/")?.hostname).toBe("example.com");
  });

  it("bounds URL size at 4 KiB", () => {
    const long = `https://example.com/${"a".repeat(4096)}`;
    expect(parseWebTargetUrl(long)).toBeUndefined();
  });
});

describe("normalizeWebTargetUrl", () => {
  it("strips fragments, default ports, and case while keeping semantic query", () => {
    expect(normalizeWebTargetUrl("HTTPS://EXAMPLE.com:443/path?q=1#frag")).toBe("https://example.com/path?q=1");
    expect(normalizeWebTargetUrl("http://example.com:80/a")).toBe("http://example.com/a");
    expect(normalizeWebTargetUrl("https://example.com:8443/a#x")).toBe("https://example.com:8443/a");
    expect(normalizeWebTargetUrl("http://127.0.0.1/")).toBeUndefined();
  });
});

describe("WebFetch schemas", () => {
  it("bounds urls to 1..3 and rejects unknown fields", () => {
    expect(WebFetchParamsSchema.safeParse({ urls: [] }).success).toBe(false);
    expect(
      WebFetchParamsSchema.safeParse({
        urls: ["https://a.com", "https://b.com", "https://c.com", "https://d.com"],
      }).success,
    ).toBe(false);
    expect(WebFetchParamsSchema.safeParse({ urls: ["https://a.com"], query: "x" }).success).toBe(false);
    expect(WebFetchParamsSchema.parse({ urls: ["https://a.com"] }).depth).toBe("basic");
  });

  it("parses the full discriminated fetch result", () => {
    const result = WebFetchResultSchema.parse({
      requestId: "req-1",
      status: "partial",
      retrievedAt: "2026-09-17T00:00:00Z",
      effectiveDepth: "advanced",
      results: [
        {
          status: "ok",
          url: "https://a.com/",
          finalUrl: null,
          contentKind: "extracted",
          completeness: "unknown",
          content: "# hello",
          sourceFetchedAt: null,
          previewTruncated: false,
          artifactTruncated: false,
          upstreamTruncated: null,
        },
        { status: "failed", url: "https://b.com/", code: "timeout", retryable: true },
      ],
    });
    expect(result.results).toHaveLength(2);
    // The wire payload never carries extension-local artifact fields.
    expect(
      WebFetchResultSchema.safeParse({
        ...result,
        results: [{ ...result.results[0], artifactPath: ".opentag/web/x/page-0.md" }, result.results[1]],
      }).success,
    ).toBe(false);
  });
});

describe("execution and gateway requests", () => {
  const base = { query: "q" };
  it("requires protocol v1 and UUID identities", () => {
    const id = "6b1d0b6c-5f7a-4c0a-9a2f-2d5c3d2f0a11";
    const ok = WebSearchExecutionRequestSchema.safeParse({
      protocolVersion: 1,
      executionId: id,
      toolCallId: id,
      ...base,
    });
    expect(ok.success).toBe(true);
    expect(
      WebSearchExecutionRequestSchema.safeParse({ protocolVersion: 2, executionId: id, toolCallId: id, ...base })
        .success,
    ).toBe(false);
    expect(
      WebSearchExecutionRequestSchema.safeParse({ protocolVersion: 1, executionId: "nope", toolCallId: id, ...base })
        .success,
    ).toBe(false);
    // Identity must not be smuggled through extra fields.
    expect(
      WebSearchExecutionRequestSchema.safeParse({
        protocolVersion: 1,
        executionId: id,
        toolCallId: id,
        accountId: id,
        ...base,
      }).success,
    ).toBe(false);
  });

  it("gateway requests mirror the same strict shape", () => {
    const id = "6b1d0b6c-5f7a-4c0a-9a2f-2d5c3d2f0a11";
    expect(WebGatewaySearchRequestSchema.safeParse({ protocolVersion: 1, toolCallId: id, query: "q" }).success).toBe(
      true,
    );
    expect(
      WebGatewayFetchRequestSchema.safeParse({
        protocolVersion: 1,
        toolCallId: id,
        urls: ["https://example.com"],
        executionId: id,
      }).success,
    ).toBe(false);
    expect(
      WebFetchExecutionRequestSchema.safeParse({ protocolVersion: 1, executionId: id, toolCallId: id, urls: ["x"] })
        .success,
    ).toBe(false);
  });

  it("service grants are exact", () => {
    expect(
      RuntimeExecutionServiceSchema.safeParse({ service: "web", scopes: ["web:search", "web:fetch"] }).success,
    ).toBe(true);
    expect(RuntimeExecutionServiceSchema.safeParse({ service: "web", scopes: ["web:delete"] }).success).toBe(false);
    expect(RuntimeExecutionServiceSchema.safeParse({ service: "llm", scopes: [] }).success).toBe(false);
  });
});

describe("results and errors", () => {
  it("parses a search result and rejects unknown fields", () => {
    const parsed = WebSearchResultSchema.parse({
      requestId: "r1",
      status: "ok",
      retrievedAt: "2026-09-17T00:00:00Z",
      effectiveDepth: "basic",
      results: [{ sourceId: "s1", title: "t", url: "https://a.com", snippet: "s", publishedAt: "2026-09-16" }],
    });
    expect(parsed.results[0]?.sourceId).toBe("s1");
    expect(
      WebSearchResultSchema.safeParse({
        requestId: "r1",
        status: "ok",
        retrievedAt: "2026-09-17T00:00:00Z",
        effectiveDepth: "basic",
        results: [],
        apiKey: "tvly-...",
      }).success,
    ).toBe(false);
  });

  it("accepts publishedAt up to 128 UTF-8 bytes and rejects longer provider timestamps", () => {
    const item = {
      requestId: "r1",
      status: "ok" as const,
      retrievedAt: "2026-09-17T00:00:00Z",
      effectiveDepth: "basic" as const,
      results: [{ sourceId: "s1", title: "t", url: "https://a.com", snippet: "s", publishedAt: "x".repeat(100) }],
    };
    expect(WebSearchResultSchema.safeParse(item).success).toBe(true);
    const ascii128 = { ...item, results: [{ ...item.results[0], publishedAt: "x".repeat(128) }] };
    expect(WebSearchResultSchema.safeParse(ascii128).success).toBe(true);
    // 120 non-ASCII characters = 360 UTF-8 bytes, over the aligned 128-byte bound.
    const unicode120 = { ...item, results: [{ ...item.results[0], publishedAt: "汉".repeat(120) }] };
    expect(WebSearchResultSchema.safeParse(unicode120).success).toBe(false);
    const ascii129 = { ...item, results: [{ ...item.results[0], publishedAt: "x".repeat(129) }] };
    expect(WebSearchResultSchema.safeParse(ascii129).success).toBe(false);
  });

  it("parses the bounded error envelope and the Router gateway envelope", () => {
    expect(
      WebToolErrorEnvelopeSchema.parse({ error: { code: "timeout", message: "timed out", retryable: true } }).error
        .code,
    ).toBe("timeout");
    expect(WebToolErrorEnvelopeSchema.safeParse({ error: { code: "nope", message: "x" } }).success).toBe(false);
    // The distinct Router outcomes stay distinct bounded codes.
    for (const code of ["request_in_progress", "request_uncertain", "insufficient_credit", "result_unavailable"]) {
      expect(WebToolErrorEnvelopeSchema.safeParse({ error: { code, message: "x" } }).success, code).toBe(true);
    }
    const gateway = RouterGatewayErrorSchema.parse({
      error: {
        message: "conflict",
        type: "idempotency_error",
        param: null,
        code: "idempotency_conflict",
        request_id: "r",
      },
    });
    expect(gateway.error.code).toBe("idempotency_conflict");
  });
});

describe("idempotency and timeout helpers", () => {
  it("derives stable printable keys within the Router bound", () => {
    const id = "6b1d0b6c-5f7a-4c0a-9a2f-2d5c3d2f0a11";
    const other = "1b1d0b6c-5f7a-4c0a-9a2f-2d5c3d2f0a22";
    const key = deriveWebIdempotencyKey({ executionId: id, toolCallId: other });
    expect(key).toBe(`opentag.web.v1:${id}:${other}`);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(deriveWebIdempotencyKey({ executionId: id, toolCallId: other })).toBe(key);
  });

  it("caps timeouts per operation and fails closed on invalid explicit budgets", () => {
    expect(capWebTimeoutMs("search", 60_000)).toBe(WEB_SEARCH_TIMEOUT_CAP_MS);
    expect(capWebTimeoutMs("fetch", 60_000)).toBe(WEB_FETCH_TIMEOUT_CAP_MS);
    expect(capWebTimeoutMs("fetch", 1_000)).toBe(1_000);
    // Absent means the operation cap; every explicit invalid value fails closed to zero.
    expect(capWebTimeoutMs("search", undefined)).toBe(WEB_SEARCH_TIMEOUT_CAP_MS);
    expect(capWebTimeoutMs("search", 0)).toBe(0);
    expect(capWebTimeoutMs("search", -5)).toBe(0);
    expect(capWebTimeoutMs("search", Number.NaN)).toBe(0);
    expect(capWebTimeoutMs("search", Number.POSITIVE_INFINITY)).toBe(0);
    expect(capWebTimeoutMs("search", 1.5)).toBe(0);
  });

  it("parses the remaining-budget header strictly", () => {
    expect(parseWebTimeoutHeader("5000", "fetch")).toBe(5_000);
    expect(parseWebTimeoutHeader("9999999999999", "search")).toBeUndefined();
    expect(parseWebTimeoutHeader("9999999", "search")).toBe(WEB_SEARCH_TIMEOUT_CAP_MS);
    expect(parseWebTimeoutHeader(undefined, "search")).toBeUndefined();
    expect(parseWebTimeoutHeader("0", "search")).toBeUndefined();
    expect(parseWebTimeoutHeader("-5", "search")).toBeUndefined();
    expect(parseWebTimeoutHeader("1.5", "search")).toBeUndefined();
    expect(parseWebTimeoutHeader(" 100", "search")).toBeUndefined();
    // Bounded ASCII digits only (7 max): Unicode digits and oversized values are invalid.
    expect(parseWebTimeoutHeader("²", "search")).toBeUndefined();
    expect(parseWebTimeoutHeader("1".repeat(8), "search")).toBeUndefined();
  });

  it("documents the fixed gateway paths and response bounds", () => {
    expect(WEB_GATEWAY_SEARCH_PATH).toBe("/web/search");
    expect(WEB_GATEWAY_FETCH_PATH).toBe("/web/fetch");
    expect(WEB_FETCH_RESPONSE_MAX_BYTES).toBe(3 * 1024 * 1024);
  });
});
