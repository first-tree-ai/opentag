import { describe, expect, it } from "vitest";
import {
  MCP_TOOL_DESCRIPTION_MAX_BYTES,
  MCP_TOOL_INPUT_SCHEMA_MAX_BYTES,
  MCP_TOOL_NAME_MAX_BYTES,
  MCPToolSnapshotSchema,
  probedServerDescription,
} from "../mcp.js";

/**
 * The Server's own description, read out of the `serverInfo` a probe recorded.
 *
 * This is derived on read rather than stored, so the only thing that can be wrong here is the
 * extraction: `server_info` is jsonb written from a peer's response and read back by a later build,
 * which means every input below is untrusted and most of them are not the specification's
 * `Implementation` shape at all.
 */
describe("probedServerDescription", () => {
  it("reads the description out of a specification-shaped serverInfo", () => {
    expect(probedServerDescription({ name: "linear", version: "1.2.0", description: "Issue tracking" })).toBe(
      "Issue tracking",
    );
  });

  it("returns null when the Server omitted the field, since it is optional in the specification", () => {
    expect(probedServerDescription({ name: "linear", version: "1.2.0" })).toBeNull();
    expect(probedServerDescription({ name: "linear", description: "" })).toBeNull();
    expect(probedServerDescription({ name: "linear", description: "   " })).toBeNull();
  });

  it("returns null for every value that is not an object with a string description", () => {
    for (const value of [null, undefined, "Issue tracking", 42, true, [], [1, 2], { description: 42 }]) {
      expect(probedServerDescription(value)).toBeNull();
    }
  });

  it("trims the value and bounds it to the column's 1024 characters", () => {
    expect(probedServerDescription({ description: "  Issue tracking  " })).toBe("Issue tracking");
    expect(probedServerDescription({ description: "x".repeat(5000) })).toHaveLength(1024);
  });

  it("ignores a nested description, which belongs to some other object", () => {
    expect(probedServerDescription({ name: "linear", nested: { description: "Issue tracking" } })).toBeNull();
  });
});

/**
 * The stored tool snapshot is parsed back with this schema before it reaches a live catalogue, so
 * it must accept exactly what the probe stores — bounded in UTF-8 bytes, not in code units.
 */
describe("MCPToolSnapshotSchema", () => {
  const tool = (overrides: Record<string, unknown>) => ({
    name: "create_issue",
    description: null,
    inputSchema: null,
    ...overrides,
  });

  it("accepts a description at the byte bound and refuses one byte over it", () => {
    expect(
      MCPToolSnapshotSchema.safeParse(tool({ description: "d".repeat(MCP_TOOL_DESCRIPTION_MAX_BYTES) })).success,
    ).toBe(true);
    expect(
      MCPToolSnapshotSchema.safeParse(tool({ description: "d".repeat(MCP_TOOL_DESCRIPTION_MAX_BYTES + 1) })).success,
    ).toBe(false);
  });

  it("counts multi-byte text in bytes, so a short string of wide characters can still be over", () => {
    // Half the bound in code units, but two bytes each: 16386 bytes, over by two.
    const wide = "é".repeat(MCP_TOOL_DESCRIPTION_MAX_BYTES / 2 + 1);
    expect(wide.length).toBeLessThan(MCP_TOOL_DESCRIPTION_MAX_BYTES);
    expect(MCPToolSnapshotSchema.safeParse(tool({ description: wide })).success).toBe(false);
    expect(
      MCPToolSnapshotSchema.safeParse(tool({ description: "é".repeat(MCP_TOOL_DESCRIPTION_MAX_BYTES / 2) })).success,
    ).toBe(true);
  });

  it("bounds the name in bytes as well and refuses an empty one", () => {
    expect(MCPToolSnapshotSchema.safeParse(tool({ name: "n".repeat(MCP_TOOL_NAME_MAX_BYTES) })).success).toBe(true);
    expect(MCPToolSnapshotSchema.safeParse(tool({ name: "n".repeat(MCP_TOOL_NAME_MAX_BYTES + 1) })).success).toBe(
      false,
    );
    expect(MCPToolSnapshotSchema.safeParse(tool({ name: "é".repeat(MCP_TOOL_NAME_MAX_BYTES / 2 + 1) })).success).toBe(
      false,
    );
    expect(MCPToolSnapshotSchema.safeParse(tool({ name: "" })).success).toBe(false);
  });

  it("bounds the input schema by its serialized bytes: at the bound passes, one byte over fails", () => {
    // `{"text":"<padding>"}` serializes to the padding plus 11 bytes of punctuation and key.
    const framing = JSON.stringify({ text: "" }).length;
    const atBound = { text: "x".repeat(MCP_TOOL_INPUT_SCHEMA_MAX_BYTES - framing) };
    expect(JSON.stringify(atBound).length).toBe(MCP_TOOL_INPUT_SCHEMA_MAX_BYTES);
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: atBound })).success).toBe(true);
    const oneOver = { text: "x".repeat(MCP_TOOL_INPUT_SCHEMA_MAX_BYTES - framing + 1) };
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: oneOver })).success).toBe(false);
    // In bytes of the serialization, not code units: wide characters count double.
    const wide = { text: "é".repeat(MCP_TOOL_INPUT_SCHEMA_MAX_BYTES / 2) };
    expect(JSON.stringify(wide).length).toBeLessThan(MCP_TOOL_INPUT_SCHEMA_MAX_BYTES);
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: wide })).success).toBe(false);
  });

  it("refuses an input schema that cannot be serialized instead of throwing out of the parse", () => {
    const circular: Record<string, unknown> = { type: "object" };
    circular.self = circular;
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: circular })).success).toBe(false);
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: { max: 1n } })).success).toBe(false);
    // Null stays a valid "takes no arguments" schema.
    expect(MCPToolSnapshotSchema.safeParse(tool({ inputSchema: null })).success).toBe(true);
  });
});
