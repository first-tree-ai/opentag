import { MCP_LEGACY_PROTOCOL_VERSIONS, MCP_MODERN_PROTOCOL_VERSION } from "@opentag/shared";
import {
  MCP_RPC_UNSUPPORTED_PROTOCOL_VERSION,
  McpTransport,
  McpTransportError,
  negotiateProtocolVersion,
} from "./mcp-transport.js";
import type { McpOutboundFetcher } from "./mcp-url-policy.js";

/**
 * One upstream JSON-RPC call on behalf of a running Agent.
 *
 * The probe already knows how to speak to both protocol eras, but that knowledge is private to
 * `McpProbe` because a probe is a fixed two-step script. A runtime call is a single arbitrary
 * method, so the era handling lives here — deliberately as its own module rather than as another
 * method on the probe, since the two have different budgets (a probe may paginate for 30 seconds; a
 * tool call answers one request) and different failure semantics.
 *
 * What is *not* duplicated is anything that touches the network or the credential: every request
 * goes through the same {@link McpOutboundFetcher} the probe uses, so the SSRF gate, the
 * per-Account concurrency budget, the redirect refusal, and the response bound all apply unchanged.
 */

export interface McpUpstreamCallInput {
  accountId: string;
  url: string;
  authHeaders: Record<string, string>;
  method: string;
  params: Record<string, unknown>;
  /** `params.name`, required by the transport headers for `tools/call`. */
  name?: string;
  /** The era cached on this authorization row, or null when unknown. */
  cachedEra: "modern" | "legacy" | null;
  cachedVersion: string | null;
  signal?: AbortSignal;
}

export interface McpUpstreamCallResult {
  result: unknown;
  /** The era actually spoken, so a caller can refresh a stale cache. */
  era: "modern" | "legacy";
  protocolVersion: string;
  /** True when the cached era proved wrong and the row's cache should be dropped. */
  eraInvalidated: boolean;
}

export interface McpUpstreamCallerOptions {
  fetcher: McpOutboundFetcher;
  clientInfo?: { name: string; version: string };
}

export class McpUpstreamCaller {
  readonly #fetcher: McpOutboundFetcher;
  readonly #clientInfo: { name: string; version: string };

  constructor(options: McpUpstreamCallerOptions) {
    this.#fetcher = options.fetcher;
    this.#clientInfo = options.clientInfo ?? { name: "opentag", version: "1" };
  }

  async call(input: McpUpstreamCallInput): Promise<McpUpstreamCallResult> {
    if (input.cachedEra === "legacy") return this.#callLegacy(input);
    return this.#callModern(input);
  }

  /**
   * The modern path, with exactly one replayable refusal.
   *
   * A tool call is **not idempotent**, which is the whole difference between this and the probe it
   * was adapted from. The probe replays freely because `server/discover` and `tools/list` are reads;
   * replaying a `tools/call` can file the issue twice, and the gateway would report only the second.
   *
   * So a retry happens only when the refusal *proves the call was never dispatched* — see
   * {@link retryableVersionRefusal}. Every other failure, including a 5xx and a JSON-RPC error
   * carrying a tool's own complaint, propagates untouched. A wrong cached era therefore surfaces as
   * one failed call rather than a silent second execution; re-probing is what corrects it, and a
   * callable tool always has an era on its row because only a succeeded probe publishes one.
   */
  async #callModern(input: McpUpstreamCallInput): Promise<McpUpstreamCallResult> {
    const version = input.cachedVersion ?? MCP_MODERN_PROTOCOL_VERSION;
    const transport = new McpTransport({
      clientInfo: this.#clientInfo,
      fetcher: this.#fetcher,
      protocolVersion: version,
    });
    try {
      const result = await this.#dispatchModern(transport, input);
      return { result, era: "modern", protocolVersion: version, eraInvalidated: false };
    } catch (error) {
      const advertised = retryableVersionRefusal(error);
      if (!advertised) throw error;
      const retryVersion = negotiateProtocolVersion(advertised.length > 0 ? advertised : [MCP_MODERN_PROTOCOL_VERSION]);
      // One retry only: the refusal that authorized it cannot authorize a second, because the peer
      // has now seen this exact call at a version it said it speaks.
      const retry = new McpTransport({
        clientInfo: this.#clientInfo,
        fetcher: this.#fetcher,
        protocolVersion: retryVersion,
      });
      const result = await this.#dispatchModern(retry, input);
      return {
        result,
        era: "modern",
        protocolVersion: retryVersion,
        eraInvalidated: retryVersion !== version,
      };
    }
  }

  #dispatchModern(transport: McpTransport, input: McpUpstreamCallInput): Promise<unknown> {
    return transport.call(input.accountId, input.url, input.method, input.params, input.authHeaders, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /**
   * The legacy path: `initialize` establishes a session, then the call rides it.
   *
   * The handshake is repeated per call rather than cached. A legacy session is connection state the
   * peer may drop at any time, and a stale session id fails the call it was meant to serve; paying
   * one extra round trip on the rarer era is the cheaper mistake. Both requests come out of the same
   * per-Account concurrency budget, so this cannot be used to double an Account's outbound spend.
   */
  async #callLegacy(input: McpUpstreamCallInput): Promise<McpUpstreamCallResult> {
    const transport = new McpTransport({ clientInfo: this.#clientInfo, fetcher: this.#fetcher });
    const { sessionId, result: handshake } = await transport.initialize(input.accountId, input.url, input.authHeaders);
    if (sessionId) {
      await transport.notifyLegacy(
        input.accountId,
        input.url,
        "notifications/initialized",
        input.authHeaders,
        sessionId,
      );
    }
    /*
     * The negotiated version is checked against the *legacy* list before it is spoken, for the same
     * reason the probe does it: the supported set includes the modern version, so a legacy peer that
     * names it would otherwise get the modern header stamped on a handshake-based session.
     */
    const named =
      isRecord(handshake) && typeof handshake.protocolVersion === "string" ? handshake.protocolVersion : undefined;
    const negotiatedVersion =
      named !== undefined && MCP_LEGACY_PROTOCOL_VERSIONS.includes(named as never) ? named : undefined;
    const result = await transport.callLegacy(
      input.accountId,
      input.url,
      input.method,
      input.params,
      input.authHeaders,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(sessionId ? { headers: { "mcp-session-id": sessionId } } : {}),
        ...(negotiatedVersion ? { negotiatedVersion } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    return {
      result,
      era: "legacy",
      ...(negotiatedVersion ? { protocolVersion: negotiatedVersion } : { protocolVersion: "" }),
      eraInvalidated: false,
    };
  }
}

/**
 * The versions to retry at when a refusal proves this call was never executed, or `undefined`.
 *
 * Exactly one refusal qualifies: JSON-RPC `-32022 UnsupportedProtocolVersion`, which a Server emits
 * while rejecting the envelope, before it can have run anything. The `data.supported` list it
 * carries is what the retry uses.
 *
 * Everything else is deliberately excluded, and each exclusion was a live replay path:
 *
 * - **Any non-400/404/405 status**, which `detectEraFromRpcError` reports as "modern, no versions
 *   suggested". A 500 — or a 200 carrying `-32603` — meant the peer may well have executed the tool
 *   and then failed while answering.
 * - **A 400 or 404 whose body is not a recognized modern error**, previously read as "this peer
 *   predates us" and answered by replaying the call over the legacy handshake. A modern Server that
 *   404s for a tool-specific reason would have executed it twice.
 * - **`-32601 MethodNotFound`**, which `invalidatesProtocolEra` treats as grounds to re-detect the
 *   era. For a `tools/call` that code can come from inside the tool itself.
 */
function retryableVersionRefusal(error: unknown): readonly string[] | undefined {
  if (!(error instanceof McpTransportError)) return undefined;
  const rpcError = error.rpcError;
  if (rpcError?.code !== MCP_RPC_UNSUPPORTED_PROTOCOL_VERSION) return undefined;
  const supported = (rpcError.data as { supported?: unknown } | undefined)?.supported;
  return Array.isArray(supported) ? supported.filter((value): value is string => typeof value === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
