import {
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_PROBE_MAX_TOOLS,
  MCP_PROBE_MAX_TOOLS_BYTES,
  MCP_TOOL_DESCRIPTION_MAX_BYTES,
  MCP_TOOL_INPUT_SCHEMA_MAX_BYTES,
  MCP_TOOL_NAME_MAX_BYTES,
} from "@opentag/shared";
import type { ServiceLogger } from "../../observability/service-logger.js";
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
  /**
   * True when the snapshot is not the Server's whole tool set: a list-level cap was hit, pagination
   * stopped early, or at least one tool was skipped for violating a per-tool bound.
   */
  toolsTruncated: boolean;
  /** How many `tools/list` entries were skipped for violating a per-tool bound. */
  toolsSkipped: number;
  probeError: string | null;
  /** True when the cached era must be dropped and re-detected on the next attempt. */
  eraInvalidated: boolean;
}

/** Why one `tools/list` entry was skipped; the name of the bound it violated, when there is one. */
type SkippedToolReason =
  | { reason: "not_an_object" }
  | { reason: "missing_name" }
  | { reason: "over_bound"; bound: string; limitBytes: number; observedBytes: number };

type ToolValidation = { ok: true; tool: McpProbeTool } | ({ ok: false; name: string | null } & SkippedToolReason);

interface CollectedTools {
  tools: McpProbeTool[];
  truncated: boolean;
  skipped: number;
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
  /** Receives one `warn` line per skipped tool; absent means skipped tools are counted silently. */
  logger?: ServiceLogger;
}

export class McpProbe {
  readonly #budgetMs: number;
  readonly #clientInfo: { name: string; version: string };
  readonly #fetcher: McpOutboundFetcher;
  readonly #logger: ServiceLogger | undefined;
  readonly #now: () => Date;

  constructor(options: McpProbeOptions) {
    this.#budgetMs = options.probeBudgetMs ?? DEFAULT_PROBE_BUDGET_MS;
    this.#clientInfo = options.clientInfo ?? { name: "opentag", version: "1" };
    this.#fetcher = options.fetcher;
    this.#logger = options.logger;
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
      toolsSkipped: tools.skipped,
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
     * The version the peer negotiated, checked against the *legacy* list.
     *
     * `MCP_SUPPORTED_PROTOCOL_VERSIONS` includes the modern `2026-07-28`, so a legacy-era Server naming
     * it was accepted and then had the modern `MCP-Protocol-Version` stamped on its `tools/list` — the
     * exact failure this check exists to prevent — while the row recorded `era: legacy` with a modern
     * version. Only a legacy version can be spoken on the legacy path.
     */
    const negotiated = typeof payload.protocolVersion === "string" ? payload.protocolVersion : undefined;
    const supported = negotiated !== undefined && MCP_LEGACY_PROTOCOL_VERSIONS.includes(negotiated as never);
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
      toolsSkipped: tools.skipped,
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
  ): Promise<CollectedTools> {
    const collected: McpProbeTool[] = [];
    let skipped = 0;
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
      skipped += this.#acceptTools(input, page.tools, collected);
      truncated = this.#applyToolCaps(collected) || truncated;
      if (truncated || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    return { tools: collected, truncated: truncated || skipped > 0, skipped };
  }

  /**
   * Page through `tools/list` until the cursor is exhausted, the limits are hit, or the probe budget
   * runs out. A one-page implementation would silently drop tools, so this is the only way the
   * snapshot can be trusted as "everything the Server offered within the cap".
   */
  async #collectTools(input: McpProbeInput, transport: McpTransport, deadline: number): Promise<CollectedTools> {
    const collected: McpProbeTool[] = [];
    let cursor: string | undefined;
    let truncated = false;
    let skipped = 0;
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
      skipped += this.#acceptTools(input, page.tools, collected);
      truncated = this.#applyToolCaps(collected) || truncated;
      if (truncated || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    // A skipped tool does not stop pagination — the rest of the list is still usable — but the
    // snapshot is partial all the same, and `tools_truncated` is the one flag that says so.
    return { tools: collected, truncated: truncated || skipped > 0, skipped };
  }

  /**
   * Validate one page's entries into the running snapshot, skipping — never storing, never
   * failing on — any that violate a per-tool bound. Returns how many were skipped. Each skip is
   * logged on its own line so an operator can see which tool a Server lost and why, because the UI
   * only learns that the list is partial.
   */
  #acceptTools(input: McpProbeInput, entries: readonly unknown[], collected: McpProbeTool[]): number {
    let skipped = 0;
    for (const entry of entries) {
      const validation = validateTool(entry);
      if (validation.ok) {
        collected.push(validation.tool);
        continue;
      }
      skipped += 1;
      const { ok: _ok, name, ...detail } = validation;
      this.#logger?.warn(
        { accountId: input.accountId, url: input.url, tool: name, ...detail },
        "MCP probe skipped a tool that violates a per-tool bound",
      );
    }
    return skipped;
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
 * Validate one tool against the documented per-tool bounds. A violation is reported, not thrown:
 * the tool is skipped and the snapshot marked partial, the same outcome as the list-level caps.
 * Real hosted Servers ship a few tools far larger than the rest, and failing the whole probe on
 * one of them left the Agent with no tools at all instead of with every tool but that one. The
 * tool is never stored mangled — an over-bound value is dropped whole, not trimmed.
 */
function validateTool(value: unknown): ToolValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, name: null, reason: "not_an_object" };
  }
  const tool = value as Record<string, unknown>;
  const name = tool.name;
  if (typeof name !== "string" || name.length === 0) return { ok: false, name: null, reason: "missing_name" };
  const nameBytes = Buffer.byteLength(name, "utf8");
  if (nameBytes > MCP_TOOL_NAME_MAX_BYTES) {
    return overBound(name, "MCP_TOOL_NAME_MAX_BYTES", MCP_TOOL_NAME_MAX_BYTES, nameBytes);
  }
  const description = typeof tool.description === "string" ? tool.description : null;
  const descriptionBytes = description === null ? 0 : Buffer.byteLength(description, "utf8");
  if (descriptionBytes > MCP_TOOL_DESCRIPTION_MAX_BYTES) {
    return overBound(name, "MCP_TOOL_DESCRIPTION_MAX_BYTES", MCP_TOOL_DESCRIPTION_MAX_BYTES, descriptionBytes);
  }
  const inputSchema = tool.inputSchema ?? null;
  const schemaBytes = inputSchema === null ? 0 : Buffer.byteLength(JSON.stringify(inputSchema), "utf8");
  if (schemaBytes > MCP_TOOL_INPUT_SCHEMA_MAX_BYTES) {
    return overBound(name, "MCP_TOOL_INPUT_SCHEMA_MAX_BYTES", MCP_TOOL_INPUT_SCHEMA_MAX_BYTES, schemaBytes);
  }
  return { ok: true, tool: { name, description, inputSchema } };
}

function overBound(name: string, bound: string, limitBytes: number, observedBytes: number): ToolValidation {
  return { ok: false, name, reason: "over_bound", bound, limitBytes, observedBytes };
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
    toolsSkipped: 0,
    probeError: `${code}: ${summary}`,
    eraInvalidated,
  };
}
