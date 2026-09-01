import { describe, expect, it } from "vitest";
import { ContextTreeConfigSchema, formatContextTreeTarget, parseContextTreeTarget } from "../context-tree.js";
import { AGENT_SLUG_MAX_LENGTH, OPENTAG_PLATFORM_INSTRUCTIONS, renderPlatformInstructions } from "../runtime-config.js";

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

  it.each([
    ["", "empty input"],
    ["   ", "whitespace only"],
    ["a".repeat(101), "a managed name beyond the length bound"],
  ])("rejects %s (%s)", (input) => {
    expect(parseContextTreeTarget(input)).toBeUndefined();
  });

  it("rejects an unknown field and a future schema version", () => {
    const target = { kind: "managed" as const, name: "shared" };
    expect(() => ContextTreeConfigSchema.parse({ schemaVersion: 1, target, extra: true })).toThrow();
    expect(() => ContextTreeConfigSchema.parse({ schemaVersion: 2, target })).toThrow();
  });
});

describe("platform instructions", () => {
  it("states the Agent slug so the Agent can find its own member directory", () => {
    const slug = "a".repeat(AGENT_SLUG_MAX_LENGTH);
    const rendered = renderPlatformInstructions({ agentSlug: slug });
    expect(rendered.startsWith(OPENTAG_PLATFORM_INSTRUCTIONS)).toBe(true);
    expect(rendered).toContain(`OpenTag Agent slug: ${slug}`);
    // Distinct slugs must produce distinct text, because the Agent revision tuple hashes it.
    expect(renderPlatformInstructions({ agentSlug: "reviewer" })).not.toBe(rendered);
  });
});
