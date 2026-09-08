import { describe, expect, it } from "vitest";
import { AnalyticsReporter } from "./analytics.js";
import type { GtagCommand } from "./gtag.js";

function reporterOn(pathname: string): { reporter: AnalyticsReporter; sent: GtagCommand[] } {
  const sent: GtagCommand[] = [];
  const reporter = new AnalyticsReporter({ location: () => ({ pathname }) });
  reporter.arm((command) => sent.push(command));
  return { reporter, sent };
}

describe("analytics reporter", () => {
  it("reports nothing until it is armed, so an unarmed suite cannot report", () => {
    const reporter = new AnalyticsReporter({ location: () => ({ pathname: "/agents" }) });

    expect(reporter.active).toBe(false);
    expect(() => {
      reporter.track("agent_created", {});
      reporter.identify("6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b");
      reporter.page({
        href: "https://opentag.example/agents",
        origin: "https://opentag.example",
        referrer: "",
        title: "OpenTag",
      });
    }).not.toThrow();
  });

  it("identifies the Account by its opaque id", () => {
    const { reporter, sent } = reporterOn("/agents");

    reporter.identify("6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b");

    expect(sent).toEqual([["set", { user_id: "6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b" }]]);
  });

  it("clears the identity when the session ends", () => {
    const { reporter, sent } = reporterOn("/agents");

    reporter.identify(null);

    expect(sent).toEqual([["set", { user_id: null }]]);
  });

  it("refuses to report from a preview surface, where nothing that happens is real", () => {
    const { reporter, sent } = reporterOn("/internal/agent-setup");

    reporter.track("computer_connected", { mode: "create" });
    reporter.page({
      href: "https://opentag.example/internal/agent-setup",
      origin: "https://opentag.example",
      referrer: "",
      title: "OpenTag",
    });

    expect(sent).toEqual([]);
  });

  it("sends a page view whose location and referrer carry no identifiers, and records it as a default", () => {
    const { reporter, sent } = reporterOn("/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b");

    reporter.page({
      href: "https://opentag.example/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b?agentId=6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b",
      origin: "https://opentag.example",
      referrer: "https://opentag.example/agents/11112222-3333-4444-8555-666677778888",
      title: "OpenTag",
    });

    const expected = {
      page_location: "https://opentag.example/agents/:id",
      page_path: "/agents/:id",
      page_referrer: "https://opentag.example/agents/:id",
      page_title: "OpenTag",
    };
    // Set as well as sent: a hit the tag raises on its own must not read the raw URL back off the
    // document.
    expect(sent).toEqual([
      ["set", expected],
      ["event", "page_view", expected],
    ]);
    expect(JSON.stringify(sent)).not.toContain("6f1b3c2e");
  });

  it("stops reporting once disarmed", () => {
    const { reporter, sent } = reporterOn("/agents");

    reporter.disarm();
    reporter.track("agent_created", {});

    expect(reporter.active).toBe(false);
    expect(sent).toEqual([]);
  });
});
