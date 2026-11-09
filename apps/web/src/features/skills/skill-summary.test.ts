import { describe, expect, it } from "vitest";
import { presetSummary, skillSummary } from "./skill-summary.js";

const routing = "Connect, authorize, and manage MCP Servers… Do not answer those requests with a web-console guide.";

describe("Skill summaries shown to admins", () => {
  it("shows a bundled Skill's localized summary instead of its Agent-facing description", () => {
    expect(skillSummary({ name: "mcp-onboarding", description: routing, source: "preset" })).toBe(
      "Connect and authorize connectors from the chat.",
    );
    expect(presetSummary({ name: "mcp-onboarding", description: routing })).toBe(
      "Connect and authorize connectors from the chat.",
    );
  });

  it("keeps an uploaded Skill's own description, even with a bundled Skill's name", () => {
    expect(skillSummary({ name: "mcp-onboarding", description: "Mine.", source: "web_upload" })).toBe("Mine.");
    expect(skillSummary({ name: "release-notes", description: "Draft notes.", source: "preset" })).toBe("Draft notes.");
  });
});
