import { describe, expect, it } from "vitest";
import { AnalyticsReporter, isPreviewPath, syncAnalyticsSuppression } from "./analytics.js";
import { ANALYTICS_MEASUREMENT_ID } from "./config.js";
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
      reporter.page({ location: "https://app.opentag.build/agents", path: "/agents", title: "OpenTag" });
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
      location: "https://app.opentag.build/internal/agent-setup",
      path: "/internal/agent-setup",
      title: "OpenTag",
    });

    expect(sent).toEqual([]);
  });

  it("records the page view as a default as well as sending it", () => {
    const { reporter, sent } = reporterOn("/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b");

    reporter.page({
      location: "https://app.opentag.build/agents/:agentId",
      path: "/agents/:agentId",
      referrer: "https://app.opentag.build/agents",
      title: "OpenTag",
    });

    const expected = {
      page_location: "https://app.opentag.build/agents/:agentId",
      page_path: "/agents/:agentId",
      page_referrer: "https://app.opentag.build/agents",
      page_title: "OpenTag",
    };
    // Set as well as sent: a hit the tag raises on its own must not read the raw URL back off the
    // document.
    expect(sent).toEqual([
      ["set", expected],
      ["event", "page_view", expected],
    ]);
  });

  it("turns the tag itself off on a preview surface, not just this application's calls", () => {
    // Enhanced Measurement raises scroll, click and form events of the tag's own accord, which
    // refusing `track()` and `page()` cannot stop. Google's flag is read at hit time.
    const flag = `ga-disable-${ANALYTICS_MEASUREMENT_ID}`;
    const target = { location: { pathname: "/internal/agent-setup" } } as unknown as Window;

    syncAnalyticsSuppression("/internal/agent-setup", target);
    expect(Reflect.get(target, flag)).toBe(true);

    // And back on when the reader navigates away, so a preview does not silence the whole visit.
    syncAnalyticsSuppression("/agents", target);
    expect(Reflect.get(target, flag)).toBe(false);
  });

  it("counts every internal route as a preview, however it was entered", () => {
    expect(isPreviewPath("/internal")).toBe(true);
    expect(isPreviewPath("/internal/agent-setup")).toBe(true);
    expect(isPreviewPath("/agents")).toBe(false);
  });

  it("stops reporting once disarmed", () => {
    const { reporter, sent } = reporterOn("/agents");

    reporter.disarm();
    reporter.track("agent_created", {});

    expect(reporter.active).toBe(false);
    expect(sent).toEqual([]);
  });
});
