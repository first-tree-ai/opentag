import { describe, expect, it } from "vitest";
import { ContextTreeConfigSchema, formatContextTreeTarget, parseContextTreeTarget } from "../context-tree.js";
import { OPENTAG_PLATFORM_INSTRUCTIONS, renderPlatformInstructions } from "../runtime-config.js";

describe("Context Tree configuration", () => {
  it.each([
    ["team-context-tree", { kind: "managed", name: "team-context-tree" }],
    ["acme/shared-context", { kind: "github", repository: "acme/shared-context" }],
    ["/srv/trees/shared", { kind: "path", path: "/srv/trees/shared" }],
  ])("routes %s to a target and round-trips it through the config schema", (input, expected) => {
    const target = parseContextTreeTarget(input);
    expect(target).toEqual(expected);
    const config = ContextTreeConfigSchema.parse({ schemaVersion: 1, target });
    expect(ContextTreeConfigSchema.parse(JSON.parse(JSON.stringify(config)))).toEqual(config);
    expect(formatContextTreeTarget(config.target)).toBe(input);
  });

  // A name the Context Tree CLI could never accept must fail here, as a usage error, rather than
  // later as a confusing "no such tree" against a config file that was already written.
  it.each(["", "   ", "Not A Name", "a".repeat(101)])("refuses %j as a target", (input) => {
    expect(parseContextTreeTarget(input)).toBeUndefined();
  });

  it("rejects an unknown field and a future schema version", () => {
    const config = { schemaVersion: 1, target: { kind: "managed", name: "shared" } };
    expect(() => ContextTreeConfigSchema.parse({ ...config, extra: true })).toThrow();
    expect(() => ContextTreeConfigSchema.parse({ ...config, schemaVersion: 2 })).toThrow();
  });

  it("states the Agent slug so an Agent can find its own member directory", () => {
    const rendered = renderPlatformInstructions({ agentSlug: "code-reviewer" });
    expect(rendered.startsWith(OPENTAG_PLATFORM_INSTRUCTIONS)).toBe(true);
    expect(rendered).toContain("OpenTag Agent slug: code-reviewer");
  });
});
