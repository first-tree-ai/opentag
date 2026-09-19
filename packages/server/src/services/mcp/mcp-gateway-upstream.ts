import { MCP_LEGACY_PROTOCOL_VERSIONS, MCP_MODERN_PROTOCOL_VERSION } from "@opentag/shared";
import {
  detectEraFromRpcError,
  invalidatesProtocolEra,
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
    if (input.cachedEra === "legacy") return this.#callLegacy(input, false);
    try {
      return await this.#callModern(input);
    } catch (error) {
      /*
       * A cached `modern` that the peer just rejected on version grounds. The era cache is only a
       * cache, so one re-detection is allowed — but exactly one, because a peer that keeps refusing
       * would otherwise be retried forever.
       */
      if (input.cachedEra === "modern" && invalidatesProtocolEra(error)) {
        return this.#callLegacy(input, true);
      }
      throw error;
    }
  }

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
      if (!(error instanceof McpTransportError) || error.status === undefined) throw error;
      const detection = detectEraFromRpcError(error.status, error.rpcError);
      /*
       * The body decides, exactly as the probe's downgrade rule does: a recognizable modern JSON-RPC
       * error means the peer *is* modern and merely wants another version — never downgrade to the
       * handshake for one of those, because a modern Server would refuse `initialize` too.
       */
      if (detection.era === "legacy") return this.#callLegacy(input, input.cachedEra !== null);
      const retryVersion = negotiateProtocolVersion(
        detection.retryWithVersions.length > 0 ? detection.retryWithVersions : [MCP_MODERN_PROTOCOL_VERSION],
      );
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
  async #callLegacy(input: McpUpstreamCallInput, eraInvalidated: boolean): Promise<McpUpstreamCallResult> {
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
      eraInvalidated,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
