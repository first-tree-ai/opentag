import {
  composeGatewayToolName,
  MCP_GATEWAY_MAX_TOOLS,
  type MCPToolSnapshot,
  MCPToolSnapshotSchema,
} from "@opentag/shared";
import { z } from "zod";
import { MCP_ERROR_CODES, McpServiceError } from "./errors.js";
import type { McpAuthorizationService } from "./mcp-authorization-service.js";
import type { McpUpstreamCaller } from "./mcp-gateway-upstream.js";
import { type McpJoinedBinding, McpServerService } from "./mcp-server-service.js";

/**
 * The runtime half of MCP: one Agent's bound Servers, presented as a single tool catalogue and a
 * single call entry point.
 *
 * Aggregation is transparent — a model sees `linear__create_issue`, not a `call_mcp_tool` meta tool
 * — because a model calls a tool it can read the schema of far more reliably than one it must first
 * discover through another call. The cost is context: this is why the catalogue is bounded.
 */

export interface McpGatewayTool {
  /** The composed, model-facing name. */
  name: string;
  description: string | null;
  inputSchema: unknown;
}

export interface McpGatewayCatalog {
  tools: McpGatewayTool[];
  /**
   * Human-readable notes about Servers that could not be included, surfaced to the model as the
   * MCP `instructions` string. A Server whose probe failed is a fact the model should know: without
   * it, a tool the user expects is simply absent with no explanation anywhere the model can see.
   */
  notes: string[];
}

export interface McpGatewayToolCallResult {
  /** The upstream `tools/call` result, forwarded structurally. */
  result: unknown;
}

export interface McpGatewayServiceOptions {
  servers: McpServerService;
  authorizations: McpAuthorizationService;
  upstream: McpUpstreamCaller;
  /** Bound on the published catalogue; overridable so a test can reach it cheaply. */
  maxTools?: number;
}

/** A mount that is actually usable right now, with its composed tool names resolved. */
interface UsableMount {
  joined: McpJoinedBinding;
  serverName: string;
  tools: MCPToolSnapshot[];
}

export class McpGatewayService {
  readonly #servers: McpServerService;
  readonly #authorizations: McpAuthorizationService;
  readonly #upstream: McpUpstreamCaller;
  readonly #maxTools: number;

  constructor(options: McpGatewayServiceOptions) {
    this.#servers = options.servers;
    this.#authorizations = options.authorizations;
    this.#upstream = options.upstream;
    this.#maxTools = options.maxTools ?? MCP_GATEWAY_MAX_TOOLS;
  }

  /**
   * The Agent's whole tool catalogue, served from the stored probe snapshots.
   *
   * Reading the snapshot rather than fanning out a live `tools/list` to every bound Server is
   * deliberate. `tools/list` is called at the start of every run; a live fan-out would add one
   * round trip per Server to every turn and would contend for the same four-per-Account outbound
   * slots a real tool call needs. The snapshot is already the documented model — it is bounded at
   * 200 tools and 256 KiB per row, refreshed on every authorization change, and explicitly
   * described as a snapshot rather than an authoritative whole.
   */
  async catalog(accountId: string, agentId: string): Promise<McpGatewayCatalog> {
    const bindings = await this.#servers.listAgentBindings(accountId, agentId);
    const tools: McpGatewayTool[] = [];
    const notes: string[] = [];
    const seen = new Map<string, string>();
    let truncated = false;
    for (const mount of usableMounts(bindings, notes)) {
      for (const tool of mount.tools) {
        if (tools.length >= this.#maxTools) {
          truncated = true;
          break;
        }
        const name = composeGatewayToolName(mount.serverName, tool.name);
        const owner = seen.get(name);
        if (owner !== undefined) {
          /*
           * Two snapshot entries composed to one name. Publishing either would make the call
           * ambiguous and route silently to whichever won the race, so both are dropped and the
           * collision is stated — a missing tool with a reason beats a tool that calls the wrong
           * Server.
           */
          notes.push(`Tool "${name}" is unavailable: ${owner} and ${mount.serverName} both produce that name.`);
          continue;
        }
        seen.set(name, mount.serverName);
        tools.push({ name, description: tool.description, inputSchema: tool.inputSchema ?? undefined });
      }
      if (truncated) break;
    }
    if (truncated) {
      notes.push(`Only the first ${this.#maxTools} tools are listed; some bound MCP Servers are not represented.`);
    }
    return { tools, notes };
  }

  /**
   * Route one `tools/call` to the Server that owns the composed name.
   *
   * The name is resolved by recomputing composed names over this Agent's own snapshots rather than
   * by splitting on the separator. Splitting would be wrong twice over: an upstream tool name may
   * itself contain the separator, and a shortened name does not contain its tool half at all. It
   * also means the resolution set is exactly what this Agent is allowed to call, so a name borrowed
   * from another Agent resolves to nothing rather than to someone else's Server.
   */
  async callTool(input: {
    accountId: string;
    agentId: string;
    name: string;
    arguments?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<McpGatewayToolCallResult> {
    const bindings = await this.#servers.listAgentBindings(input.accountId, input.agentId);
    const target = resolveTool(bindings, input.name);
    if (!target) {
      throw new McpServiceError(
        MCP_ERROR_CODES.BINDING_NOT_FOUND,
        `No MCP tool named "${input.name}" is available to this Agent`,
      );
    }
    const mcpServerId = target.joined.server.id;
    const resolved = await this.#authorizations.resolveActiveCredential(input.accountId, input.agentId, mcpServerId);
    if (!resolved) {
      throw new McpServiceError(
        MCP_ERROR_CODES.AUTHORIZATION_REQUIRED,
        `This Agent is not authorized for the MCP Server "${target.serverName}"`,
      );
    }
    const effective = McpServerService.resolveEffectiveConfig(resolved.server, resolved.binding);
    const headers = this.#authorizations.buildHeadersFor(resolved);
    const call = await this.#upstream.call({
      accountId: input.accountId,
      url: effective.url,
      authHeaders: headers,
      method: "tools/call",
      params: { name: target.upstreamName, arguments: input.arguments ?? {} },
      name: target.upstreamName,
      cachedEra: resolved.authorization.protocolEra,
      cachedVersion: resolved.authorization.protocolVersion,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { result: call.result };
  }
}

/**
 * The mounts whose tools may be published, in the order the join returned them.
 *
 * Three independent conditions must hold, and each failure is reported rather than swallowed,
 * because "my tool disappeared" is otherwise indistinguishable between a disabled mount, a revoked
 * credential, and an MCP Server that stopped answering.
 */
function usableMounts(bindings: readonly McpJoinedBinding[], notes: string[]): UsableMount[] {
  const usable: UsableMount[] = [];
  for (const joined of bindings) {
    const serverName = joined.server.name;
    if (!joined.binding.enabled) continue;
    const authorization = joined.authorization;
    if (authorization?.status !== "active") {
      notes.push(`MCP Server "${serverName}" is not authorized for this Agent, so its tools are unavailable.`);
      continue;
    }
    if (authorization.probeState !== "succeeded") {
      notes.push(
        `MCP Server "${serverName}" has no usable tool snapshot (${authorization.probeState}), so its tools are unavailable.`,
      );
      continue;
    }
    const tools = readToolSnapshot(authorization.tools);
    if (tools.length === 0) continue;
    usable.push({ joined, serverName, tools });
  }
  return usable;
}

/** Recompute composed names over the Agent's usable mounts and find the exact match. */
function resolveTool(
  bindings: readonly McpJoinedBinding[],
  name: string,
): { joined: McpJoinedBinding; serverName: string; upstreamName: string } | undefined {
  const matches: { joined: McpJoinedBinding; serverName: string; upstreamName: string }[] = [];
  for (const mount of usableMounts(bindings, [])) {
    for (const tool of mount.tools) {
      if (composeGatewayToolName(mount.serverName, tool.name) !== name) continue;
      matches.push({ joined: mount.joined, serverName: mount.serverName, upstreamName: tool.name });
    }
  }
  // An ambiguous name was never published (see `catalog`), so refusing here keeps the two paths
  // agreeing rather than letting a call reach a Server the catalogue declined to name.
  return matches.length === 1 ? matches[0] : undefined;
}

const ToolSnapshotArraySchema = z.array(MCPToolSnapshotSchema);

/**
 * Read the stored tool snapshot back out of its jsonb column.
 *
 * The column is untyped at the database boundary, and the probe that wrote it may have run against
 * an older bound. Parsing rather than casting means a row written by a past version cannot put a
 * malformed tool into a live catalogue; an unreadable snapshot degrades to "this Server contributes
 * nothing" instead of to a tool whose name or schema the caller cannot trust.
 */
function readToolSnapshot(value: unknown): MCPToolSnapshot[] {
  const parsed = ToolSnapshotArraySchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}
