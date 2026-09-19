import { describe, expect, it } from "vitest";
import { RuntimeExecutionServiceRequestSchema, RuntimeExecutionServiceSchema } from "../execution-services.js";

describe("execution service requests", () => {
  it("accepts every known service and rejects anything else", () => {
    expect(RuntimeExecutionServiceRequestSchema.safeParse("web").success).toBe(true);
    expect(RuntimeExecutionServiceRequestSchema.safeParse("mcp").success).toBe(true);
    expect(RuntimeExecutionServiceRequestSchema.safeParse("llm").success).toBe(false);
    expect(RuntimeExecutionServiceRequestSchema.safeParse("").success).toBe(false);
  });
});

describe("execution service grants", () => {
  it("service grants are exact", () => {
    expect(
      RuntimeExecutionServiceSchema.safeParse({ service: "web", scopes: ["web:search", "web:fetch"] }).success,
    ).toBe(true);
    expect(RuntimeExecutionServiceSchema.safeParse({ service: "web", scopes: ["web:delete"] }).success).toBe(false);
    expect(RuntimeExecutionServiceSchema.safeParse({ service: "llm", scopes: [] }).success).toBe(false);
  });

  it("accepts an mcp grant with its own scope", () => {
    expect(RuntimeExecutionServiceSchema.safeParse({ service: "mcp", scopes: ["mcp:tools"] }).success).toBe(true);
    expect(RuntimeExecutionServiceSchema.safeParse({ service: "mcp", scopes: [] }).success).toBe(false);
  });

  /*
   * The point of discriminating on `service` rather than flattening: each variant carries only its
   * own scope vocabulary, so a web scope can never satisfy an MCP grant and vice versa. A flat
   * object with a shared scope enum would have accepted both of these.
   */
  it("does not let one service borrow another's scopes", () => {
    expect(RuntimeExecutionServiceSchema.safeParse({ service: "mcp", scopes: ["web:search"] }).success).toBe(false);
    expect(RuntimeExecutionServiceSchema.safeParse({ service: "web", scopes: ["mcp:tools"] }).success).toBe(false);
  });

  it("rejects unknown fields on a grant", () => {
    expect(
      RuntimeExecutionServiceSchema.safeParse({ service: "mcp", scopes: ["mcp:tools"], token: "secret" }).success,
    ).toBe(false);
  });
});
