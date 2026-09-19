import { z } from "zod";
import { runtimeUtf8Length } from "./runtime-config.js";

/**
 * MCP gateway contract — the runtime half of the MCP feature.
 *
 * The management plane (`./mcp.ts`) lets an Account register MCP Servers and authorize them per
 * Agent. This module describes how a running Agent actually *reaches* those Servers: the OpenTag
 * Server publishes one inbound Streamable HTTP MCP endpoint, a provider CLI mounts it like any
 * other remote MCP Server, and the gateway aggregates every Server that Agent has bound.
 *
 * Two properties shape everything here:
 *
 * - **No upstream credential ever leaves the Server.** The gateway resolves the Agent's own
 *   authorization row and builds the outbound headers itself, so the Agent's machine never holds a
 *   decrypted upstream secret.
 * - **The Agent's credential is execution-scoped.** The bearer the provider CLI presents resolves to
 *   one live execution and nothing else; it is worthless the moment that execution ends, so a token
 *   read out of a config file by a prompt-injected Agent buys no lasting access.
 *
 * Nothing in this module carries a secret: the token itself travels in its own runtime frame
 * (`./runtime-credentials.ts`), never in a schema defined here.
 */

/** The single fixed inbound route. A caller cannot select another target. */
export const MCP_GATEWAY_PATH = "/api/v1/mcp" as const;

/**
 * The name the gateway registers itself under in a provider's MCP configuration.
 *
 * Constrained by Claude Code's permission-rule grammar, `/^mcp__[\w-]+(?:__(?:[\w.-]+|\*))?$/`: the
 * server half admits only word characters and hyphens. A bare `mcp__<server>` rule matches every
 * tool of that server, which is why the aggregated tool list need not be known at launch time.
 */
export const MCP_GATEWAY_SERVER_NAME = "opentag-mcp" as const;

/** The permission-rule entry that authorizes every aggregated tool. */
export const MCP_GATEWAY_ALLOWED_TOOL_RULE = `mcp__${MCP_GATEWAY_SERVER_NAME}` as const;

/* --------------------------- execution service ---------------------------- */

export const RUNTIME_MCP_SERVICE = "mcp" as const;

/**
 * The one scope this service grants. Listing and calling are not separable: a client that can see a
 * tool can call it, and a client that cannot see one has no name to call.
 */
export const RuntimeMcpServiceScopeSchema = z.enum(["mcp:tools"]);
export type RuntimeMcpServiceScope = z.infer<typeof RuntimeMcpServiceScopeSchema>;

/* -------------------------------- bounds ---------------------------------- */

/**
 * The composed tool name bound.
 *
 * An upstream tool name is already bounded at 128 bytes and a Server name at 64, so a naive
 * `<server>__<tool>` reaches 194 — past what several MCP clients accept. Names that would exceed
 * this are shortened deterministically; see {@link composeGatewayToolName}.
 */
export const MCP_GATEWAY_TOOL_NAME_MAX_BYTES = 128;

/** Total tools the gateway will publish for one Agent, across every Server it has bound. */
export const MCP_GATEWAY_MAX_TOOLS = 400;

/** Serialized bound on one `tools/call` result forwarded back to the caller. */
export const MCP_GATEWAY_RESULT_MAX_BYTES = 1024 * 1024;

/** Inbound JSON-RPC request bound. */
export const MCP_GATEWAY_REQUEST_MAX_BYTES = 1024 * 1024;

/** The separator between the Server name and the upstream tool name. */
export const MCP_GATEWAY_NAME_SEPARATOR = "__" as const;

/** Hex characters of the disambiguating digest appended to a shortened name. */
const DIGEST_LENGTH = 6;

/* ---------------------------- name composition ---------------------------- */

/**
 * Compose the model-facing name for one upstream tool.
 *
 * The plain form is `<serverName>__<toolName>`, which is what a model sees and what reads back
 * unambiguously to a human. When that exceeds {@link MCP_GATEWAY_TOOL_NAME_MAX_BYTES} the tool half
 * is truncated and a short digest of the *full* pair is appended, so two long tool names sharing a
 * prefix still land on distinct composed names.
 *
 * The result is a pure function of its inputs, which is what lets the gateway stay stateless: it
 * never stores a name map, it recomputes composed names over the Agent's stored tool snapshots and
 * matches the one the caller asked for.
 */
export function composeGatewayToolName(serverName: string, toolName: string): string {
  const plain = `${serverName}${MCP_GATEWAY_NAME_SEPARATOR}${toolName}`;
  if (runtimeUtf8Length(plain) <= MCP_GATEWAY_TOOL_NAME_MAX_BYTES) return plain;
  const digest = shortDigest(`${serverName}\u0000${toolName}`);
  const prefix = `${serverName}${MCP_GATEWAY_NAME_SEPARATOR}`;
  /*
   * The budget left for the tool half after the prefix and the `-<digest>` suffix. A Server name
   * long enough to leave nothing still yields a name that is unique for the pair, because the digest
   * is retained — the result is simply dominated by the prefix.
   */
  const reserved = runtimeUtf8Length(prefix) + DIGEST_LENGTH + 1;
  const budget = MCP_GATEWAY_TOOL_NAME_MAX_BYTES - reserved;
  const head = budget > 0 ? truncateToBytes(toolName, budget) : "";
  return `${prefix}${head}-${digest}`;
}

/**
 * Truncate to a byte budget without splitting a UTF-8 code point.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a budget expressed in bytes cannot be
 * applied directly: one emoji is two code units and four bytes. Characters are appended while the
 * running byte count fits, which also keeps a surrogate pair whole because iteration yields code
 * points rather than code units.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = runtimeUtf8Length(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += character;
  }
  return result;
}

/**
 * A short digest over the full name pair.
 *
 * FNV-1a rather than SHA-256: this module is browser-safe and must not reach for `node:crypto`, and
 * the digest is a disambiguator among at most {@link MCP_GATEWAY_MAX_TOOLS} names of one Account —
 * not a security boundary. A collision would make one tool unaddressable, which the gateway detects
 * when two snapshot entries compose to the same name.
 */
function shortDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, DIGEST_LENGTH);
}

/* ------------------------------ error codes ------------------------------- */

/**
 * Why the gateway refused, as a bounded code.
 *
 * These describe the *gateway*, not an upstream Server. An upstream failure is reported to the model
 * as a tool result with `isError: true`, because a model reads and recovers from that, while a
 * transport error ends its turn.
 */
export const MCP_GATEWAY_ERROR_CODES = [
  "unauthenticated",
  "execution_unknown",
  "execution_closed",
  "scope_denied",
  "invalid_request",
  "request_too_large",
  "protocol_unsupported",
  "tool_unknown",
  "tool_ambiguous",
  "catalog_unavailable",
  "result_too_large",
  "timeout",
  "unknown",
] as const;
export const McpGatewayErrorCodeSchema = z.enum(MCP_GATEWAY_ERROR_CODES);
export type McpGatewayErrorCode = z.infer<typeof McpGatewayErrorCodeSchema>;
