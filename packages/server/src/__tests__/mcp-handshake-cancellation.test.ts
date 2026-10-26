import { MCP_ERROR_CODES, MCP_MODERN_PROTOCOL_VERSION } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import type { McpServiceError } from "../services/mcp/errors.js";
import { McpUpstreamCaller } from "../services/mcp/mcp-gateway-upstream.js";
import { MCP_ACCEPT_HEADER } from "../services/mcp/mcp-transport.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

/**
 * Cancellation of the legacy `initialize -> notifications/initialized -> tools/call` handshake.
 *
 * The handshake is three requests, and the caller's `AbortSignal` has to reach all three. A signal
 * that is already aborted must produce *zero* outbound requests: a cancelled turn that still
 * dials the peer has already spent the Account's budget and the Server's attention on an answer
 * nobody will read. A signal that fires during either handshake step must end the call promptly and
 * must not let the tool call follow, because a `tools/call` is not idempotent — dispatching one
 * after its caller left is the same defect as replaying it.
 *
 * Every case counts the requests that actually reached `fetch`, through the real outbound gate, so
 * "no further request" is measured at the only place a request can leave the process.
 */

const ACCOUNT = "account-1";
const URL_ = "https://mcp.example.com/mcp";
const SESSION = "sess-1";
const NEGOTIATED = "2025-06-18";
/** Public address, so the gate's resolve-then-dial check never consults DNS. */
const PUBLIC_ADDRESS = "203.0.113.10";

interface Dial {
  method: string;
  headers: Record<string, string>;
}

/**
 * The real outbound gate in front of a recording `fetch`.
 *
 * Using `McpOutboundFetcher` rather than a hand-written stub keeps the production cancellation
 * semantics in the test: the pre-abort refusal and the abort-aware request both come from the
 * shipped code, so a handshake hop that drops the signal fails here for the right reason.
 */
function scriptedGate(options: { hang?: readonly string[] } = {}) {
  const dials: Dial[] = [];
  const waiters: Array<{ method: string; resolve: () => void }> = [];
  const hung: Array<() => void> = [];
  const hangOn = new Set(options.hang ?? []);
  let releasing = false;

  const respond = (body: Record<string, unknown>): Response => {
    const method = String(body.method ?? "");
    if (method === "notifications/initialized") {
      return new Response(null, {
        status: 202,
        headers: { "content-type": "application/json", "mcp-session-id": SESSION },
      });
    }
    const result =
      method === "initialize"
        ? { protocolVersion: NEGOTIATED, capabilities: {} }
        : { content: [{ type: "text", text: "created" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(method === "initialize" ? { "mcp-session-id": SESSION } : {}),
      },
    });
  };

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const method = String(body.method ?? "");
    dials.push({ method, headers: (init?.headers ?? {}) as Record<string, string> });
    for (const waiter of waiters.filter((candidate) => candidate.method === method)) {
      waiter.resolve();
    }
    if (!hangOn.has(method) || releasing) return respond(body);
    return await new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      hung.push(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(respond(body));
      });
    });
  }) as unknown as typeof globalThis.fetch;

  return {
    dials,
    methods: () => dials.map((dial) => dial.method),
    /** Resolves once a request for `method` has been put on the wire. */
    reached: (method: string): Promise<void> =>
      new Promise<void>((resolve) => {
        if (dials.some((dial) => dial.method === method)) resolve();
        else waiters.push({ method, resolve });
      }),
    /** Unblock anything still hanging, so a failed assertion cannot leave a request in flight. */
    release: () => {
      releasing = true;
      for (const unblock of hung.splice(0)) unblock();
    },
    fetcher: () =>
      new McpOutboundFetcher({
        allowLoopback: false,
        timeoutMs: 60_000,
        maxConcurrentPerAccount: 8,
        fetch: fetchImpl,
        resolveAddresses: async () => [PUBLIC_ADDRESS],
      }),
  };
}

/** An outcome observed within a bound, so "promptly" is asserted rather than the 60 s budget. */
async function outcomeWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<{ ok: true } | { ok: false; error: unknown } | "hung"> {
  return await Promise.race([
    promise.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);
}

function expectAborted(outcome: { ok: true } | { ok: false; error: unknown } | "hung"): void {
  expect(outcome).not.toBe("hung");
  expect(outcome).not.toMatchObject({ ok: true });
  expect((outcome as { error: McpServiceError }).error.code).toBe(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE);
}

function call(
  fetcher: McpOutboundFetcher,
  options: { era?: "legacy" | "modern"; signal?: AbortSignal } = {},
): Promise<unknown> {
  return new McpUpstreamCaller({ fetcher }).call({
    accountId: ACCOUNT,
    url: URL_,
    authHeaders: { authorization: "Bearer upstream" },
    method: "tools/call",
    params: { name: "create_issue", arguments: {} },
    name: "create_issue",
    cachedEra: options.era ?? "legacy",
    cachedVersion: options.era === "modern" ? MCP_MODERN_PROTOCOL_VERSION : NEGOTIATED,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

describe("a handshake the caller already cancelled", () => {
  it("issues no outbound request at all on the legacy path", async () => {
    const gate = scriptedGate();
    await expect(call(gate.fetcher(), { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE,
      detail: { cause: "aborted" },
    });
    // Not even `initialize`: nothing left the process, so no session was opened or abandoned.
    expect(gate.dials).toEqual([]);
  });

  /*
   * The same guarantee on the modern path, which has one request instead of three. Both eras share
   * one fetcher, so a regression that drops the signal would otherwise be caught on only one.
   */
  it("issues no outbound request at all on the modern path", async () => {
    const gate = scriptedGate();
    await expect(call(gate.fetcher(), { era: "modern", signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE,
      detail: { cause: "aborted" },
    });
    expect(gate.dials).toEqual([]);
  });
});

describe("a handshake cancelled in flight", () => {
  it("ends `initialize` promptly and never sends the notification or the tool call", async () => {
    const gate = scriptedGate({ hang: ["initialize"] });
    const controller = new AbortController();
    const pending = call(gate.fetcher(), { signal: controller.signal });
    try {
      await gate.reached("initialize");
      controller.abort();
      expectAborted(await outcomeWithin(pending, 1_000));
      // Exactly the request that was already on the wire: no `notifications/initialized`, no call.
      expect(gate.methods()).toEqual(["initialize"]);
    } finally {
      gate.release();
      await outcomeWithin(pending, 100);
    }
  });

  it("ends `notifications/initialized` promptly and never sends the tool call", async () => {
    const gate = scriptedGate({ hang: ["notifications/initialized"] });
    const controller = new AbortController();
    const pending = call(gate.fetcher(), { signal: controller.signal });
    try {
      await gate.reached("notifications/initialized");
      controller.abort();
      expectAborted(await outcomeWithin(pending, 1_000));
      // The handshake got as far as the notification; the non-idempotent call must not follow.
      expect(gate.methods()).toEqual(["initialize", "notifications/initialized"]);
    } finally {
      gate.release();
      await outcomeWithin(pending, 100);
    }
  });

  /*
   * A signal that fires after the notification has already been answered is still in time: the tool
   * call is the request that matters, and the gate refuses it before dialing rather than after.
   */
  it("refuses the tool call when the abort lands between the handshake and the call", async () => {
    const gate = scriptedGate({ hang: ["tools/call"] });
    const controller = new AbortController();
    const pending = call(gate.fetcher(), { signal: controller.signal });
    try {
      await gate.reached("tools/call");
      controller.abort();
      expectAborted(await outcomeWithin(pending, 1_000));
      expect(gate.methods()).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    } finally {
      gate.release();
      await outcomeWithin(pending, 100);
    }
  });
});

/*
 * The negative control. Without it, a change that silently stopped reading the session header or
 * stopped sending the negotiated version would leave every cancellation test above green.
 */
describe("the uncancelled handshake", () => {
  it("sends exactly initialize, the notification and the call, in that order", async () => {
    const gate = scriptedGate();
    await expect(call(gate.fetcher(), { signal: new AbortController().signal })).resolves.toMatchObject({
      result: { content: [{ type: "text", text: "created" }] },
    });
    expect(gate.methods()).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  it("sends the transport headers each handshake step requires", async () => {
    const gate = scriptedGate();
    await call(gate.fetcher(), { signal: new AbortController().signal });
    const [initialize, notification, toolCall] = gate.dials;
    expect(initialize?.headers).toMatchObject({
      authorization: "Bearer upstream",
      accept: MCP_ACCEPT_HEADER,
      "content-type": "application/json",
    });
    // `initialize` opens the session, so it predates both the session and the negotiated version.
    expect(initialize?.headers["mcp-session-id"]).toBeUndefined();
    expect(initialize?.headers["MCP-Protocol-Version"]).toBeUndefined();
    // The notification rides the session it just opened and speaks the negotiated revision.
    expect(notification?.headers).toMatchObject({
      authorization: "Bearer upstream",
      accept: MCP_ACCEPT_HEADER,
      "content-type": "application/json",
      "mcp-session-id": SESSION,
      "MCP-Protocol-Version": NEGOTIATED,
    });
    // The call rides the same session and speaks the version the peer negotiated.
    expect(toolCall?.headers).toMatchObject({
      authorization: "Bearer upstream",
      accept: MCP_ACCEPT_HEADER,
      "content-type": "application/json",
      "mcp-session-id": SESSION,
      "MCP-Protocol-Version": NEGOTIATED,
    });
  });
});
