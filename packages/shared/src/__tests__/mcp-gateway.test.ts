import { describe, expect, it } from "vitest";
import {
  composeGatewayToolName,
  MCP_GATEWAY_ALLOWED_TOOL_RULE,
  MCP_GATEWAY_SERVER_NAME,
  MCP_GATEWAY_TOOL_NAME_MAX_BYTES,
} from "../mcp-gateway.js";
import { runtimeUtf8Length } from "../runtime-config.js";

describe("gateway identity", () => {
  /*
   * Claude Code parses a permission rule as `mcp__<server>(__<tool>)?` and accepts only word
   * characters and hyphens in the server half. A name that violates it is not rejected loudly — the
   * rule simply never matches, and every aggregated tool is silently denied.
   */
  it("the server name is addressable in a Claude Code permission rule", () => {
    expect(MCP_GATEWAY_SERVER_NAME).toMatch(/^[\w-]+$/);
    expect(MCP_GATEWAY_ALLOWED_TOOL_RULE).toMatch(/^mcp__[\w-]+(?:__(?:[\w.-]+|\*))?$/);
  });
});

describe("composeGatewayToolName", () => {
  it("uses the plain form when it fits", () => {
    expect(composeGatewayToolName("linear", "create_issue")).toBe("linear__create_issue");
  });

  it("is stable across calls", () => {
    const first = composeGatewayToolName("linear", "create_issue");
    const second = composeGatewayToolName("linear", "create_issue");
    expect(first).toBe(second);
  });

  it("keeps distinct upstream servers distinct", () => {
    expect(composeGatewayToolName("linear", "search")).not.toBe(composeGatewayToolName("notion", "search"));
  });

  it("shortens a name that would exceed the bound, and stays within it", () => {
    const tool = "a".repeat(200);
    const composed = composeGatewayToolName("linear", tool);
    expect(runtimeUtf8Length(composed)).toBeLessThanOrEqual(MCP_GATEWAY_TOOL_NAME_MAX_BYTES);
    expect(composed.startsWith("linear__")).toBe(true);
  });

  /*
   * The reason the digest covers the whole pair rather than only the truncated tail: two tools whose
   * names share a long prefix truncate to the same head, so without the digest they would compose to
   * one name and one of them would become unreachable.
   */
  it("disambiguates two long names sharing a prefix", () => {
    const shared = "b".repeat(200);
    const first = composeGatewayToolName("linear", `${shared}_one`);
    const second = composeGatewayToolName("linear", `${shared}_two`);
    expect(first).not.toBe(second);
    expect(runtimeUtf8Length(first)).toBeLessThanOrEqual(MCP_GATEWAY_TOOL_NAME_MAX_BYTES);
    expect(runtimeUtf8Length(second)).toBeLessThanOrEqual(MCP_GATEWAY_TOOL_NAME_MAX_BYTES);
  });

  /*
   * A byte budget cannot be applied with `slice`, which counts UTF-16 code units. Truncating a
   * multi-byte name mid-code-point would emit a lone surrogate and a name no client can echo back.
   */
  it("never splits a multi-byte character when shortening", () => {
    const composed = composeGatewayToolName("linear", "🙂".repeat(120));
    expect(runtimeUtf8Length(composed)).toBeLessThanOrEqual(MCP_GATEWAY_TOOL_NAME_MAX_BYTES);
    expect(composed.includes("�")).toBe(false);
    expect([...composed].every((character) => character.codePointAt(0) !== undefined)).toBe(true);
    // A well-formed string round-trips through UTF-8 unchanged; a split surrogate would not.
    expect(Buffer.from(composed, "utf8").toString("utf8")).toBe(composed);
  });

  it("still produces a bounded unique name when the server name alone fills the budget", () => {
    const serverName = "s".repeat(MCP_GATEWAY_TOOL_NAME_MAX_BYTES);
    const first = composeGatewayToolName(serverName, "one");
    const second = composeGatewayToolName(serverName, "two");
    expect(first).not.toBe(second);
  });
});
