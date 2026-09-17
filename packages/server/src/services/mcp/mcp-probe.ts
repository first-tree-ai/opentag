import {
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_PROBE_MAX_TOOLS,
  MCP_PROBE_MAX_TOOLS_BYTES,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "@opentag/shared";
import { boundedMcpSummary, MCP_ERROR_CODES, McpServiceError } from "./errors.js";
import {
  detectEraFromRpcError,
  invalidatesProtocolEra,
  MCP_META_SERVER_INFO,
  McpTransport,
  McpTransportError,
  negotiateProtocolVersion,
} from "./mcp-transport.js";
import type { McpOutboundFetcher } from "./mcp-url-policy.js";

/**
 * Capability probing: `server/discover` for identity, capabilities and instructions, then a
 * paginated `tools/list` for the snapshot.
 *
 * The probe writes only to the authorization row it probed. The tool list genuinely differs per
 * credential, so the snapshot belongs to the row, not to the shared Server definition — and keeping
 * automatic writes off the definition is also what lets a human edit's `expectedRevision` stay valid
 * while probes run concurrently.
 */

/** Per-tool bounds; a page violating any of them fails the probe rather than being truncated. */
const MAX_TOOL_NAME_BYTES = 128;
const MAX_TOOL_DESCRIPTION_BYTES = 1024;
const MAX_TOOL_INPUT_SCHEMA_BYTES = 8 * 1024;
/** Total probe budget across every page, so a Server cannot keep us paginating forever. */
const DEFAULT_PROBE_BUDGET_MS = 30_000;
const MAX_PROBE_PAGES = 20;

export interface McpProbeTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

export interface McpProbeResult {
  probeState: "succeeded" | "failed";
  protocolEra: "modern" | "legacy" | null;
  protocolVersion: string | null;
  serverInfo: unknown;
  capabilities: unknown;
  instructions: string | null;
  tools: McpProbeTool[];
  toolsCount: number;
  toolsTruncated: boolean;
  probeError: string | null;
  /** True when the cached era must be dropped and re-detected on the next attempt. */
  eraInvalidated: boolean;
}

export interface McpProbeInput {
  accountId: string;
  url: string;
  authHeaders: Record<string, string>;
  /** The era cached on this authorization row, or null when unknown. */
  cachedEra: "modern" | "legacy" | null;
  cachedVersion: string | null;
  /** The specification's `resource` value for OAuth calls; absent for bearer/none. */
  resource?: string;
}

export interface McpProbeOptions {
  fetcher: McpOutboundFetcher;
  now?: () => Date;
  probeBudgetMs?: number;
  clientInfo?: { name: string; version: string };
}

export class McpProbe {
  readonly #budgetMs: number;
  readonly #clientInfo: { name: string; version: string };
  readonly #fetcher: McpOutboundFetcher;
  readonly #now: () => Date;

  constructor(options: McpProbeOptions) {
    this.#budgetMs = options.probeBudgetMs ?? DEFAULT_PROBE_BUDGET_MS;
    this.#clientInfo = options.clientInfo ?? { name: "opentag", version: "1" };
    this.#fetcher = options.fetcher;
    this.#now = options.now ?? (() => new Date());
  }

  async probe(input: McpProbeInput): Promise<McpProbeResult> {
    const deadline = this.#now().getTime() + this.#budgetMs;
    try {
      return input.cachedEra === "legacy"
        ? await this.#probeLegacy(input, deadline)
        : await this.#probeModern(input, deadline);
    } catch (error) {
      return failed(error, invalidatesProtocolEra(error));
    }
  }

  /**
   * The modern path. On a `400`/`404`/`405` the body decides: a recognizable modern JSON-RPC error
   * means retry with an advertised version (never downgrade), anything else means the peer is older
   * and the legacy handshake is the only way forward.
   */
  async #probeModern(input: McpProbeInput, deadline: number): Promise<McpProbeResult> {
    const transport = new McpTransport({ clientInfo: this.#clientInfo, fetcher: this.#fetcher });
    const discover = await this.#discover(input, transport);
    if (discover.kind === "legacy") return this.#probeLegacy(input, deadline);
    const { payload, protocolVersion } = discover;
    const era = protocolVersion === MCP_MODERN_PROTOCOL_VERSION ? "modern" : "legacy";
    const negotiated = new McpTransport({
      clientInfo: this.#clientInfo,
      fetcher: this.#fetcher,
      protocolVersion,
    });
    const tools = await this.#collectTools(input, negotiated, deadline);
    return {
      probeState: "succeeded",
      protocolEra: era,
      protocolVersion,
      serverInfo: serverInfoOf(payload),
      capabilities: payload.capabilities ?? null,
      instructions: boundedInstructions(payload.instructions),
      tools: tools.tools,
      toolsCount: tools.tools.length,
      toolsTruncated: tools.truncated,
      probeError: null,
      eraInvalidated: false,
    };
  }

  async #discover(
    input: McpProbeInput,
    transport: McpTransport,
  ): Promise<{ kind: "modern"; payload: Record<string, unknown>; protocolVersion: string } | { kind: "legacy" }> {
    try {
      const result = await transport.call(input.accountId, input.url, "server/discover", {}, input.authHeaders);
      return { kind: "modern", payload: asRecord(result), protocolVersion: transport.protocolVersion };
    } catch (error) {
      if (!(error instanceof McpTransportError) || error.status === undefined) throw error;
      const detection = detectEraFromRpcError(error.status, error.rpcError);
      if (detection.era === "legacy") return { kind: "legacy" };
      /*
       * Modern peer, wrong version. Retry once with a version it advertised; if it advertised none
       * this client speaks, `negotiateProtocolVersion` reports a protocol failure rather than
       * silently downgrading.
       */
      const version = negotiateProtocolVersion(
        detection.retryWithVersions.length > 0 ? detection.retryWithVersions : [MCP_MODERN_PROTOCOL_VERSION],
      );
      const retry = new McpTransport({
        clientInfo: this.#clientInfo,
        fetcher: this.#fetcher,
        protocolVersion: version,
      });
      const result = await retry.call(input.accountId, input.url, "server/discover", {}, input.authHeaders);
      return { kind: "modern", payload: asRecord(result), protocolVersion: version };
    }
  }

  /** The legacy `initialize` handshake, used only for an origin that predates the modern model. */
  async #probeLegacy(input: McpProbeInput, deadline: number): Promise<McpProbeResult> {
    const transport = new McpTransport({ clientInfo: this.#clientInfo, fetcher: this.#fetcher });
    const { sessionId, result } = await transport.initialize(input.accountId, input.url, input.authHeaders);
    const payload = asRecord(result);
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
     * The version the peer negotiated, checked against the ones this client speaks. An unrecognized
     * value is recorded as absent rather than echoed onto later requests: a Server naming a version we
     * do not implement would otherwise have us stamp it on the `tools/list` that follows.
     */
    const negotiated = typeof payload.protocolVersion === "string" ? payload.protocolVersion : undefined;
    const supported = negotiated !== undefined && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated as never);
    const tools = await this.#collectLegacyTools(
      input,
      transport,
      sessionId,
      supported ? negotiated : undefined,
      deadline,
    );
    return {
      probeState: "succeeded",
      protocolEra: "legacy",
      protocolVersion: supported && negotiated !== undefined ? negotiated : null,
      serverInfo: payload.serverInfo ?? null,
      capabilities: payload.capabilities ?? null,
      instructions: boundedInstructions(payload.instructions),
      tools: tools.tools,
      toolsCount: tools.tools.length,
      toolsTruncated: tools.truncated,
      probeError: null,
      eraInvalidated: false,
    };
  }

  /**
   * Page the legacy `tools/list` to exhaustion, under the same caps as the modern path.
   *
   * It previously read a single page and reported `truncated: true` for any Server that sent a
   * cursor — which claimed a complete snapshot whenever the Server fit on one page, and claimed a
   * partial one even when more pages were available and cheap. The modern path's loop is the
   * reference: page until the cursor runs out, the budget expires, or a cap is hit, and only then
   * call the snapshot truncated.
   */
  async #collectLegacyTools(
    input: McpProbeInput,
    transport: McpTransport,
    sessionId: string | undefined,
    negotiatedVersion: string | undefined,
    deadline: number,
  ): Promise<{ tools: McpProbeTool[]; truncated: boolean }> {
    const collected: McpProbeTool[] = [];
    /*
     * The caller's deadline is the probe's own, not a fresh budget: this runs after the handshake has
     * already spent part of it, and starting a second window let a legacy probe run about twice the
     * configured budget.
     */
    const sessionHeaders = sessionId ? { headers: { "mcp-session-id": sessionId } } : {};
    let cursor: string | undefined;
    let truncated = false;
    let pages = 0;
    for (;;) {
      if (this.#now().getTime() >= deadline || pages >= MAX_PROBE_PAGES) {
        // Stopped with a cursor still outstanding, so the snapshot is explicitly partial.
        truncated = true;
        break;
      }
      pages += 1;
      const page = readToolsPage(
        asRecord(
          await transport.callLegacy(
            input.accountId,
            input.url,
            "tools/list",
            cursor === undefined ? {} : { cursor },
            input.authHeaders,
            { ...sessionHeaders, ...(negotiatedVersion === undefined ? {} : { negotiatedVersion }) },
          ),
        ),
      );
      for (const tool of page.tools) collected.push(validateTool(tool));
      truncated = this.#applyToolCaps(collected) || truncated;
      if (truncated || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    return { tools: collected, truncated };
  }

  /**
   * Page through `tools/list` until the cursor is exhausted, the limits are hit, or the probe budget
   * runs out. A one-page implementation would silently drop tools, so this is the only way the
   * snapshot can be trusted as "everything the Server offered within the cap".
   */
  async #collectTools(
    input: McpProbeInput,
    transport: McpTransport,
    deadline: number,
  ): Promise<{ tools: McpProbeTool[]; truncated: boolean }> {
    const collected: McpProbeTool[] = [];
    let cursor: string | undefined;
    let truncated = false;
    let pages = 0;
    for (;;) {
      if (this.#now().getTime() >= deadline || pages >= MAX_PROBE_PAGES) {
        // The budget or the page cap stopped us with a cursor still outstanding, so the snapshot is
        // explicitly partial rather than presented as the whole tool set.
        truncated = true;
        break;
      }
      pages += 1;
      const page = readToolsPage(
        asRecord(
          await transport.call(
            input.accountId,
            input.url,
            "tools/list",
            cursor === undefined ? {} : { cursor },
            input.authHeaders,
          ),
        ),
      );
      // Each page is validated as a unit: an over-limit tool fails the probe rather than being
      // quietly dropped or stored mangled.
      for (const tool of page.tools) collected.push(validateTool(tool));
      truncated = this.#applyToolCaps(collected) || truncated;
      if (truncated || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    return { tools: collected, truncated };
  }

  /**
   * Apply the count and byte caps to the running snapshot. Returns true when a cap was hit, which
   * also means the snapshot must be reported as truncated — `tools_truncated` covers both "the
   * Server offered more" and "pagination did not finish", because either way the list is partial.
   */
  #applyToolCaps(collected: McpProbeTool[]): boolean {
    if (collected.length >= MCP_PROBE_MAX_TOOLS) {
      collected.length = MCP_PROBE_MAX_TOOLS;
      return true;
    }
    if (serializedToolsBytes(collected) <= MCP_PROBE_MAX_TOOLS_BYTES) return false;
    while (collected.length > 0 && serializedToolsBytes(collected) > MCP_PROBE_MAX_TOOLS_BYTES) collected.pop();
    return true;
  }
}

function readToolsPage(payload: Record<string, unknown>): { tools: unknown[]; nextCursor: string | undefined } {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const nextCursor =
    typeof payload.nextCursor === "string" && payload.nextCursor.length > 0 ? payload.nextCursor : undefined;
  return { tools, nextCursor };
}

/**
 * Validate one tool against the documented bounds. A page that violates them fails the whole probe:
 * storing a silently mangled schema would be worse than reporting that the Server's answer was not
 * usable.
 */
function validateTool(value: unknown): McpProbeTool {
  const tool = asRecord(value);
  const name = tool.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new McpServiceError(MCP_ERROR_CODES.PROBE_FAILED, "The Server returned a tool without a name");
  }
  if (Buffer.byteLength(name, "utf8") > MAX_TOOL_NAME_BYTES) {
    throw new McpServiceError(MCP_ERROR_CODES.PROBE_FAILED, "The Server returned a tool name over the size limit");
  }
  const description = typeof tool.description === "string" ? tool.description : null;
  if (description !== null && Buffer.byteLength(description, "utf8") > MAX_TOOL_DESCRIPTION_BYTES) {
    throw new McpServiceError(
      MCP_ERROR_CODES.PROBE_FAILED,
      "The Server returned a tool description over the size limit",
    );
  }
  const inputSchema = tool.inputSchema ?? null;
  if (inputSchema !== null && Buffer.byteLength(JSON.stringify(inputSchema), "utf8") > MAX_TOOL_INPUT_SCHEMA_BYTES) {
    throw new McpServiceError(MCP_ERROR_CODES.PROBE_FAILED, "The Server returned a tool schema over the size limit");
  }
  return { name, description, inputSchema };
}

function serializedToolsBytes(tools: readonly McpProbeTool[]): number {
  return Buffer.byteLength(JSON.stringify(tools), "utf8");
}

function boundedInstructions(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Buffer.byteLength(value, "utf8") <= 4096 ? value : value.slice(0, 4096);
}

/**
 * The Server's identity out of a `server/discover` result, where the specification puts it under
 * `_meta`. Reading the top level instead would silently report a nameless Server for every conforming
 * peer.
 */
function serverInfoOf(payload: Record<string, unknown>): unknown {
  const meta = payload._meta;
  if (typeof meta === "object" && meta !== null && MCP_META_SERVER_INFO in meta) {
    return (meta as Record<string, unknown>)[MCP_META_SERVER_INFO] ?? null;
  }
  return payload[MCP_META_SERVER_INFO] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function failed(error: unknown, eraInvalidated: boolean): McpProbeResult {
  const code = error instanceof McpServiceError ? error.code : MCP_ERROR_CODES.PROBE_FAILED;
  const summary = error instanceof Error ? boundedMcpSummary(error.message) : "The probe failed";
  return {
    probeState: "failed",
    protocolEra: null,
    protocolVersion: null,
    serverInfo: null,
    capabilities: null,
    instructions: null,
    tools: [],
    toolsCount: 0,
    toolsTruncated: false,
    probeError: `${code}: ${summary}`,
    eraInvalidated,
  };
}
