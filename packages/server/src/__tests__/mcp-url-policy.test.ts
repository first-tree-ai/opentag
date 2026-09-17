import { readdirSync, readFileSync } from "node:fs";
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

/**
 * A resolver that answers one public address, so a test about redirects, body bounds, or
 * concurrency does not need a network — and does not fail because the gate now resolves names.
 */
const PUBLIC_RESOLVER = { resolveAddresses: async (): Promise<string[]> => ["93.184.216.34"] };
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

  /*
   * The leading-bit arithmetic this replaced read every address by its last two groups, because
   * JavaScript's `<<` and `|` truncate to 32 bits: `2001:db8::` came out as `::` (a false positive)
   * and a full documentation address came out as its tail (a false negative). It also threw
   * `RangeError` on five or more leading groups. Each case below is one of those failures.
   */
  it("decides an IPv6 destination by its leading bits, not its last two groups", () => {
    for (const host of [
      "[2001:db8::1]",
      "[2001:db8:1:2:3:4:5:6]",
      "[2001::1]",
      "[100::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:8.8.8.8]",
      "[::]",
    ]) {
      expect(blockedBy(`https://${host}/mcp`)?.code, host).toBe(MCP_ERROR_CODES.URL_BLOCKED);
    }
  });

  it("admits public IPv6 destinations with five or more leading groups", () => {
    for (const host of ["[2606:4700::1]", "[2606:4700:1:2:3::1]", "[2606:4700:4700::1111]"]) {
      expect(blockedBy(`https://${host}/mcp`), host).toBeUndefined();
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

  /*
   * The spelling rules that `assertOutboundUrl` alone can enforce. A hostname carries no address, so
   * the resolution check on the fetcher catches what these do not — but a name that *looks* like
   * loopback must still be refused here, before any resolver is consulted.
   */
  it("treats the reserved `.localhost` tree and a trailing dot as loopback", () => {
    for (const host of ["localhost.", "foo.localhost", "foo.localhost.", "LOCALHOST"]) {
      expect(blockedBy(`https://${host}/mcp`)?.code, host).toBe(MCP_ERROR_CODES.URL_BLOCKED);
    }
  });

  it("refuses deprecated site-local IPv6, which is still unroutable", () => {
    for (const host of ["[fec0::1]", "[feff::1]"]) {
      expect(blockedBy(`https://${host}/mcp`)?.code, host).toBe(MCP_ERROR_CODES.URL_BLOCKED);
    }
    // The neighbouring public space stays reachable: 2000::/3 is global unicast.
    expect(blockedBy("https://[2001:4860:4860::8888]/mcp")).toBeUndefined();
  });
});

describe("McpOutboundFetcher DNS policy", () => {
  /** A fetcher whose resolver is scripted, so the policy is testable without a network. */
  function fetcherResolving(addresses: string[] | Error) {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    return {
      fetcher: new McpOutboundFetcher({
        allowLoopback: false,
        fetch: fetchImpl,
        resolveAddresses: async () => {
          if (addresses instanceof Error) throw addresses;
          return addresses;
        },
      }),
      fetchImpl,
    };
  }

  /*
   * The gate's promise is that non-public destinations are refused, and a hostname is the ordinary
   * way to reach one: `assertOutboundUrl` sees only the name, which says nothing about the address.
   * Every case below was admitted before this check existed.
   */
  it("refuses a public name that resolves to a private address", async () => {
    const cases: [string, string][] = [
      ["https://localtest.me/mcp", "127.0.0.1"],
      ["https://metadata.google.internal/mcp", "169.254.169.254"],
      ["https://internal.example.com/mcp", "10.0.0.5"],
      ["https://internal.example.com/mcp", "fd00::1"],
      ["https://internal.example.com/mcp", "::ffff:127.0.0.1"],
    ];
    for (const [host, address] of cases) {
      const { fetcher, fetchImpl } = fetcherResolving([address]);
      await expect(fetcher.fetchOutbound(ACCOUNT, host), host).rejects.toMatchObject({
        code: MCP_ERROR_CODES.URL_BLOCKED,
      });
      // Refused before dialing: the request must never leave the process.
      expect(fetchImpl, host).not.toHaveBeenCalled();
    }
  });

  it("refuses a name with one public and one private address, whatever the resolver's order", async () => {
    // Checking only the first record would make the verdict depend on record order.
    for (const addresses of [
      ["93.184.216.34", "127.0.0.1"],
      ["127.0.0.1", "93.184.216.34"],
    ]) {
      const { fetcher } = fetcherResolving(addresses);
      await expect(fetcher.fetchOutbound(ACCOUNT, "https://split.example.com/mcp")).rejects.toMatchObject({
        code: MCP_ERROR_CODES.URL_BLOCKED,
      });
    }
  });

  it("admits a name that resolves only to public addresses", async () => {
    const { fetcher } = fetcherResolving(["93.184.216.34", "2606:4700:4700::1111"]);
    await expect(fetcher.fetchOutbound(ACCOUNT, "https://mcp.example.com/mcp")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("reports a name that does not resolve as unreachable rather than blocked", async () => {
    // The caller's URL is valid; the peer is missing. Saying "blocked" would send them hunting for a
    // policy problem that does not exist.
    const { fetcher } = fetcherResolving(new Error("ENOTFOUND"));
    await expect(fetcher.fetchOutbound(ACCOUNT, "https://nope.example.com/mcp")).rejects.toMatchObject({
      code: MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
    const empty = fetcherResolving([]);
    await expect(empty.fetcher.fetchOutbound(ACCOUNT, "https://nope.example.com/mcp")).rejects.toMatchObject({
      code: MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
  });

  it("does not resolve a literal address, which the URL check already judged", async () => {
    const { fetcher } = fetcherResolving(new Error("should not be consulted"));
    await expect(fetcher.fetchOutbound(ACCOUNT, "https://93.184.216.34/mcp")).resolves.toMatchObject({ status: 200 });
  });

  it("counts the resolution against the concurrency bound", async () => {
    /*
     * A lookup is a network round trip the Account asked for. Resolving before taking a slot let a
     * hostile Server answering with many distinct names spend as many concurrent lookups as it liked
     * while the counter sat at zero.
     */
    let resolving = 0;
    let peak = 0;
    const fetcher = new McpOutboundFetcher({
      allowLoopback: false,
      maxConcurrentPerAccount: 2,
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch,
      resolveAddresses: async () => {
        resolving += 1;
        peak = Math.max(peak, resolving);
        await new Promise((resolve) => setTimeout(resolve, 20));
        resolving -= 1;
        return ["93.184.216.34"];
      },
    });

    const outcomes = await Promise.allSettled([
      fetcher.fetchOutbound(ACCOUNT, "https://a.example.com/mcp"),
      fetcher.fetchOutbound(ACCOUNT, "https://b.example.com/mcp"),
      fetcher.fetchOutbound(ACCOUNT, "https://c.example.com/mcp"),
    ]);

    // Two proceed and the third is refused, so the lookups never exceed the bound either.
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("McpOutboundFetcher", () => {
  it("never follows a redirect and never reads its Location", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    ) as unknown as typeof globalThis.fetch;
    const fetcher = new McpOutboundFetcher({ ...PUBLIC_RESOLVER, allowLoopback: false, fetch: fetchImpl });
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
    const fetcher = new McpOutboundFetcher({ ...PUBLIC_RESOLVER, allowLoopback: false, fetch: fetchImpl });
    await expect(fetcher.fetchOutbound(ACCOUNT, "https://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      code: MCP_ERROR_CODES.URL_BLOCKED,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds the response body, using the declared length first", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("x".repeat(64), { status: 200, headers: { "content-length": "4096" } }),
    ) as unknown as typeof globalThis.fetch;
    const fetcher = new McpOutboundFetcher({
      ...PUBLIC_RESOLVER,
      allowLoopback: false,
      fetch: fetchImpl,
      maxResponseBytes: 1024,
    });
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
    const fetcher = new McpOutboundFetcher({
      ...PUBLIC_RESOLVER,
      allowLoopback: false,
      fetch: fetchImpl,
      maxConcurrentPerAccount: 2,
    });
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
 * The regression gate: no module under `services/mcp` and none of the MCP API routes may call `fetch`
 * themselves. Only the policy module may, and every other module takes its `fetchOutbound` from it, so
 * the gate is a property of the dependency graph rather than of a reviewer's attention.
 *
 * Swept by directory rather than from a list of names. The list was four files with a comment claiming
 * three, and either way a module added later escaped the check silently — which is the failure mode the
 * gate exists to prevent. `services/mcp/index.ts` and the test fixtures are exempt by path.
 */
describe("MCP outbound gate regression", () => {
  const moduleDirectory = fileURLToPath(new URL("../services/mcp/", import.meta.url));
  const apiDirectory = fileURLToPath(new URL("../api/", import.meta.url));

  /** Every MCP source file that must reach the network only through the policy module. */
  function outboundModules(): { name: string; path: string }[] {
    const services = readdirSync(moduleDirectory)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name: `services/mcp/${name}`, path: `${moduleDirectory}${name}` }));
    const routes = readdirSync(apiDirectory)
      .filter((name) => name.startsWith("mcp-") && name.endsWith(".ts"))
      .map((name) => ({ name: `api/${name}`, path: `${apiDirectory}${name}` }));
    return [...services, ...routes];
  }

  it("covers every module that dials, so a new one cannot escape the scan", () => {
    const names = outboundModules().map((module) => module.name);
    // The modules the gate was written for are still covered, and the sweep is not empty.
    for (const expected of [
      "services/mcp/mcp-transport.ts",
      "services/mcp/mcp-oauth.ts",
      "services/mcp/mcp-probe.ts",
      "services/mcp/mcp-oauth-flow-service.ts",
      "api/mcp-oauth.ts",
    ]) {
      expect(names, expected).toContain(expected);
    }
    expect(names.length).toBeGreaterThan(10);
  });

  it("keeps a direct fetch() out of every module but the policy", () => {
    for (const { name, path } of outboundModules()) {
      // The policy module is the one place a dial is allowed; `index.ts` is a barrel with no calls.
      if (name === "services/mcp/mcp-url-policy.ts" || name === "services/mcp/index.ts") continue;
      const source = readFileSync(path, "utf8");
      expect(source, name).not.toMatch(/\bfetch\s*\(/);
      expect(source, name).not.toMatch(/globalThis\.fetch/);
    }
  });

  it("confines the fetch call to the policy module", () => {
    const source = readFileSync(`${moduleDirectory}mcp-url-policy.ts`, "utf8");
    expect(source).toMatch(/assertOutboundUrl/);
    expect(source).toMatch(/this\.#fetch\(/);
  });
});
