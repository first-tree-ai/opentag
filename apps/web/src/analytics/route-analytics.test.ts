import { describe, expect, it } from "vitest";
import { AnalyticsReporter } from "./analytics.js";
import type { GtagCommand } from "./gtag.js";
import { installRouteAnalytics } from "./route-analytics.js";

function fakeRouter(): { subscribe: (event: "onResolved", listener: () => void) => () => void; resolve: () => void } {
  const listeners = new Set<() => void>();
  return {
    subscribe: (_event, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolve: () => {
      for (const listener of listeners) listener();
    },
  };
}

function fakeWindow(href: string, referrer = ""): Window {
  const url = new URL(href);
  return {
    location: {
      get href() {
        return url.href;
      },
      origin: url.origin,
    },
    document: { referrer, title: "OpenTag" },
    navigate: (next: string) => {
      const target = new URL(next, url.origin);
      url.href = target.href;
    },
  } as unknown as Window & { navigate: (next: string) => void };
}

function pageViews(sent: GtagCommand[]): GtagCommand[] {
  return sent.filter((command) => command[0] === "event");
}

describe("route analytics", () => {
  it("reports the page the visit starts on", () => {
    const sent: GtagCommand[] = [];
    const reporter = new AnalyticsReporter({ location: () => ({ pathname: "/agents" }) });
    reporter.arm((command) => sent.push(command));

    installRouteAnalytics(fakeRouter(), fakeWindow("https://opentag.example/agents"), reporter);

    expect(pageViews(sent)).toEqual([
      [
        "event",
        "page_view",
        {
          page_location: "https://opentag.example/agents",
          page_path: "/agents",
          page_referrer: undefined,
          page_title: "OpenTag",
        },
      ],
    ]);
  });

  it("reports each resolved route and names the page navigated from as the referrer", () => {
    const sent: GtagCommand[] = [];
    const reporter = new AnalyticsReporter({ location: () => ({ pathname: "/agents" }) });
    reporter.arm((command) => sent.push(command));
    const router = fakeRouter();
    const target = fakeWindow("https://opentag.example/agents") as Window & { navigate: (next: string) => void };

    installRouteAnalytics(router, target, reporter);
    target.navigate("/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b");
    router.resolve();

    expect(pageViews(sent)).toHaveLength(2);
    expect(pageViews(sent)[1]).toEqual([
      "event",
      "page_view",
      {
        page_location: "https://opentag.example/agents/:id",
        page_path: "/agents/:id",
        // The page actually navigated from, not the site the whole visit arrived from.
        page_referrer: "https://opentag.example/agents",
        page_title: "OpenTag",
      },
    ]);
  });

  it("does not count the first resolve twice, nor a resolve that lands on the same page", () => {
    const sent: GtagCommand[] = [];
    const reporter = new AnalyticsReporter({ location: () => ({ pathname: "/agents" }) });
    reporter.arm((command) => sent.push(command));
    const router = fakeRouter();

    installRouteAnalytics(router, fakeWindow("https://opentag.example/agents"), reporter);
    router.resolve();
    router.resolve();

    expect(pageViews(sent)).toHaveLength(1);
  });

  it("treats two Agents as the same page, because the report groups them that way", () => {
    const sent: GtagCommand[] = [];
    const reporter = new AnalyticsReporter({ location: () => ({ pathname: "/agents" }) });
    reporter.arm((command) => sent.push(command));
    const router = fakeRouter();
    const target = fakeWindow("https://opentag.example/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b") as Window & {
      navigate: (next: string) => void;
    };

    installRouteAnalytics(router, target, reporter);
    target.navigate("/agents/11112222-3333-4444-8555-666677778888");
    router.resolve();

    expect(pageViews(sent)).toHaveLength(1);
  });

  it("stops reporting once the subscription is released", () => {
    const sent: GtagCommand[] = [];
    const reporter = new AnalyticsReporter({ location: () => ({ pathname: "/agents" }) });
    reporter.arm((command) => sent.push(command));
    const router = fakeRouter();
    const target = fakeWindow("https://opentag.example/agents") as Window & { navigate: (next: string) => void };

    const remove = installRouteAnalytics(router, target, reporter);
    remove();
    target.navigate("/account");
    router.resolve();

    expect(pageViews(sent)).toHaveLength(1);
  });
});
