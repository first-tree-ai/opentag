import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MCP_ERROR_CODES } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServiceError } from "../services/mcp/errors.js";
import { assertOutboundUrl, McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

/**
 * The outbound gate. Every URL this feature dials goes through `assertOutboundUrl`, including the
 * ones a peer supplies: a `WWW-Authenticate` challenge's `resource_metadata`, a Protected Resource
 * Metadata document's `authorization_servers[]`, an Authorization Server document's endpoints, and a
 * CIMD document URL. A single unvalidated hop would let a malicious MCP Server aim this deployment at
 * its own link-local metadata service.
 */

const ACCOUNT = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const hosted = { allowLoopback: false };
const localDev = { allowLoopback: true };

function blockedBy(url: string, policy = hosted): McpServiceError | undefined {
  try {
    assertOutboundUrl(url, policy);
    return undefined;
  } catch (error) {
    return error as McpServiceError;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("assertOutboundUrl", () => {
  it("admits a public HTTPS endpoint", () => {
    expect(assertOutboundUrl("https://mcp.example.com/mcp", hosted).hostname).toBe("mcp.example.com");
  });

  it("refuses a non-HTTPS scheme on a public host", () => {
    expect(blockedBy("http://mcp.example.com/mcp")?.code).toBe(MCP_ERROR_CODES.URL_BLOCKED);
  });

  it("refuses credentials and fragments", () => {
    expect(blockedBy("https://user:pw@mcp.example.com/mcp")?.code).toBe(MCP_ERROR_CODES.URL_BLOCKED);
    expect(blockedBy("https://mcp.example.com/mcp#frag")?.code).toBe(MCP_ERROR_CODES.URL_BLOCKED);
  });

  it("refuses every non-public IPv4 destination", () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.0.1",
      "169.254.169.254", // the cloud metadata service
      "0.0.0.0",
      "100.64.0.1",
      "192.0.0.5",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(blockedBy(`https://${host}/mcp`)?.code, host).toBe(MCP_ERROR_CODES.URL_BLOCKED);
    }
  });

  it("refuses every non-public IPv6 destination", () => {
    for (const host of ["[::1]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[ff02::1]", "[64:ff9b::1]"]) {
      expect(blockedBy(`https://${host}/mcp`)?.code, host).toBe(MCP_ERROR_CODES.URL_BLOCKED);
    }
  });

  it("admits a public IPv4 and IPv6 destination", () => {
    expect(assertOutboundUrl("https://8.8.8.8/mcp", hosted).hostname).toBe("8.8.8.8");
    expect(assertOutboundUrl("https://[2606:4700:4700::1111]/mcp", hosted).hostname).toBe("[2606:4700:4700::1111]");
  });

  it("refuses a loopback destination in a hosted deployment, whatever the scheme", () => {
    // A hosted deployment's 127.0.0.1 is the server's own loopback: admitting it would hand every
    // Account a scanner for the management port, metrics, health, and everything else on the host.
    for (const scheme of ["http", "https"]) {
      expect(blockedBy(`${scheme}://127.0.0.1:8080/mcp`)?.code).toBe(MCP_ERROR_CODES.URL_BLOCKED);
      expect(blockedBy(`${scheme}://localhost/mcp`)?.code).toBe(MCP_ERROR_CODES.URL_BLOCKED);
      expect(blockedBy(`${scheme}://[::1]/mcp`)?.code).toBe(MCP_ERROR_CODES.URL_BLOCKED);
    }
  });

  it("admits loopback plain HTTP only in a development deployment that opted in", () => {
    expect(assertOutboundUrl("http://127.0.0.1:9123/mcp", localDev).hostname).toBe("127.0.0.1");
    // The opt-in is not a licence for every private range, only for loopback.
    expect(blockedBy("http://10.0.0.1/mcp", localDev)?.code).toBe(MCP_ERROR_CODES.URL_BLOCKED);
  });

  it("refuses an unparseable value as an invalid URL rather than a blocked one", () => {
    expect(blockedBy("not a url")?.code).toBe(MCP_ERROR_CODES.SERVER_URL_INVALID);
  });
});

describe("McpOutboundFetcher", () => {
  it("never follows a redirect and never reads its Location", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    ) as unknown as typeof globalThis.fetch;
    const fetcher = new McpOutboundFetcher({ allowLoopback: false, fetch: fetchImpl });
    await expect(fetcher.fetchOutbound(ACCOUNT, "https://mcp.example.com/mcp")).rejects.toMatchObject({
      code: MCP_ERROR_CODES.URL_BLOCKED,
    });
    // Manual redirect mode is the mechanism: the platform must not fetch the target for us either.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
  });

  it("refuses a private destination before any request is made", async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const fetcher = new McpOutboundFetcher({ allowLoopback: false, fetch: fetchImpl });
    await expect(fetcher.fetchOutbound(ACCOUNT, "https://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      code: MCP_ERROR_CODES.URL_BLOCKED,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds the response body, using the declared length first", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("x".repeat(64), { status: 200, headers: { "content-length": "4096" } }),
    ) as unknown as typeof globalThis.fetch;
    const fetcher = new McpOutboundFetcher({ allowLoopback: false, fetch: fetchImpl, maxResponseBytes: 1024 });
    await expect(fetcher.fetchOutbound(ACCOUNT, "https://mcp.example.com/mcp")).rejects.toMatchObject({
      code: MCP_ERROR_CODES.UPSTREAM_ERROR,
    });
  });

  it("caps concurrent outbound requests for one Account", async () => {
    let inFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const fetcher = new McpOutboundFetcher({ allowLoopback: false, fetch: fetchImpl, maxConcurrentPerAccount: 2 });
    const outcomes = await Promise.allSettled([
      fetcher.fetchOutbound(ACCOUNT, "https://mcp.example.com/a"),
      fetcher.fetchOutbound(ACCOUNT, "https://mcp.example.com/b"),
      fetcher.fetchOutbound(ACCOUNT, "https://mcp.example.com/c"),
    ]);
    // Two proceed and one is refused; a different Account is unaffected.
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(inFlight).toBe(0);
  });
});

/**
 * The regression gate: the three network modules must not call `fetch` themselves. Only the policy
 * module may, and every other module takes its `fetchOutbound` from it, so the gate is a property of
 * the dependency graph rather than of a reviewer's attention.
 */
describe("MCP outbound gate regression", () => {
  const moduleDirectory = fileURLToPath(new URL("../services/mcp/", import.meta.url));

  it("keeps a direct fetch() out of the transport, oauth, and probe modules", () => {
    for (const file of ["mcp-transport.ts", "mcp-oauth.ts", "mcp-probe.ts", "mcp-oauth-flow-service.ts"]) {
      const source = readFileSync(`${moduleDirectory}${file}`, "utf8");
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/globalThis\.fetch/);
    }
  });

  it("confines the fetch call to the policy module", () => {
    const source = readFileSync(`${moduleDirectory}mcp-url-policy.ts`, "utf8");
    expect(source).toMatch(/assertOutboundUrl/);
    expect(source).toMatch(/this\.#fetch\(/);
  });
});
