import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnalyticsReporter,
  analytics,
  installAnalytics,
  isPreviewPath,
  syncAnalyticsSuppression,
} from "./analytics.js";
import { ANALYTICS_MEASUREMENT_ID } from "./config.js";
import { GTAG_SCRIPT_ORIGIN, type GtagCommand } from "./gtag.js";

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

  it("reads the current path from the document when it was not given one", () => {
    // The default is the page's own location, which is what makes the preview refusal unconditional.
    window.history.replaceState({}, "", "/internal/agent-setup");
    const sent: GtagCommand[] = [];
    const reporter = new AnalyticsReporter();
    reporter.arm((command) => sent.push(command));

    reporter.track("computer_connected", {});

    expect(sent).toEqual([]);
  });

  it("stops a track once the path it reads becomes a preview", () => {
    // The location is read per report, so a preview entered without a remount stops everything.
    let pathname = "/agents";
    const sent: GtagCommand[] = [];
    const reporter = new AnalyticsReporter({ location: () => ({ pathname }) });
    reporter.arm((command) => sent.push(command));

    reporter.track("agent_created", {});
    pathname = "/internal/agent-setup";
    reporter.track("agent_created", {});

    expect(sent).toEqual([["event", "agent_created", {}]]);
  });
});

/**
 * Installation. It is the only place the tag is fetched and the only place the preview flag is set
 * before the tag can send anything, so it is asserted through the document it is handed rather than
 * through jsdom's own window.
 */
describe("installAnalytics", () => {
  /**
   * Measurement is compiled in, so the production flag has to be reported as on for the installer to
   * do anything. The suites above never need it because they never call the installer.
   */
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A window just real enough for the installer: a location, a document, and a data layer. */
  function targetWindow(hostname: string, pathname: string) {
    const head = { append: vi.fn() };
    const document = {
      createElement: vi.fn((tag: string) => ({ tagName: tag.toUpperCase(), async: false, src: "" })),
      head,
    };
    return {
      document,
      location: { hostname, pathname },
    } as unknown as Window & { document: typeof document };
  }

  it("does nothing at all on a host the deployment does not measure", () => {
    vi.stubEnv("PROD", true);
    const target = targetWindow("localhost", "/agents");
    const reporter = new AnalyticsReporter();
    const arm = vi.spyOn(reporter, "arm");

    const dispose = installAnalytics(target, reporter);

    expect(arm).not.toHaveBeenCalled();
    expect(target.document.head.append).not.toHaveBeenCalled();
    expect(dispose()).toBeUndefined();
  });

  it("suppresses previews before the tag can send, then configures and fetches it", () => {
    vi.stubEnv("PROD", true);
    const target = targetWindow("app.opentag.build", "/agents");
    const reporter = new AnalyticsReporter();

    const dispose = installAnalytics(target, reporter);

    // The flag is set from the pathname the installer was handed, before any command is queued.
    expect(Reflect.get(target, `ga-disable-${ANALYTICS_MEASUREMENT_ID}`)).toBe(false);
    expect(reporter.active).toBe(true);
    const queued = target.dataLayer as unknown[][];
    expect(queued[0]?.[0]).toBe("js");
    expect(queued[1]?.[0]).toBe("config");
    expect(queued[1]?.[1]).toBe(ANALYTICS_MEASUREMENT_ID);
    // Automatic page views are off and advertising signals are refused in the same config command.
    expect(queued[1]?.[2]).toMatchObject({
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      traffic_type: undefined,
    });
    const script = target.document.createElement.mock.results[0]?.value as { src: string; async: boolean };
    expect(script.src).toBe(`${GTAG_SCRIPT_ORIGIN}/gtag/js?id=${ANALYTICS_MEASUREMENT_ID}`);
    expect(script.async).toBe(true);
    expect(target.document.head.append).toHaveBeenCalledWith(script);

    // The disposer stops further reporting; a fetched script cannot be unfetched.
    reporter.track("agent_created", {});
    dispose();
    expect(reporter.active).toBe(false);
  });

  it("opens on a preview already suppressed, so a direct visit reports nothing", () => {
    vi.stubEnv("PROD", true);
    const target = targetWindow("app.opentag.build", "/internal/agent-setup");
    const reporter = new AnalyticsReporter();

    installAnalytics(target, reporter);

    expect(Reflect.get(target, `ga-disable-${ANALYTICS_MEASUREMENT_ID}`)).toBe(true);
  });

  it("marks a non-production host as internal traffic in the same config command", () => {
    vi.stubEnv("PROD", true);
    const target = targetWindow("staging.opentag.build", "/agents");

    installAnalytics(target, new AnalyticsReporter());

    expect((target.dataLayer as unknown[][])[1]?.[2]).toMatchObject({ traffic_type: "internal" });
  });

  it("defaults to the module reporter and the document's own window", () => {
    // The default argument is what `main.tsx` relies on; it must not throw and must leave the
    // shared reporter inert on a host this document does not measure.
    expect(analytics.active).toBe(false);
    const dispose = installAnalytics();
    expect(analytics.active).toBe(false);
    dispose();
  });
});
