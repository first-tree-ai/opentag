import { describe, expect, it } from "vitest";
import { AnalyticsReporter } from "./analytics.js";
import type { GtagCommand } from "./gtag.js";
import { installRouteAnalytics, type ResolvedRouteSubscriber } from "./route-analytics.js";

interface FakeRouter extends ResolvedRouteSubscriber {
  go(pathname: string, fullPath: string, searchStr?: string): void;
}

function fakeRouter(pathname: string, fullPath: string | undefined, searchStr = ""): FakeRouter {
  const listeners = new Set<() => void>();
  const state = {
    location: { pathname, searchStr },
    // No matches is how the real router reports "resolving"; it knows the address, not the route.
    matches: fullPath === undefined ? [] : [{ fullPath }],
  };
  return {
    state,
    subscribe: (_event, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    go(nextPathname, nextFullPath, nextSearch = "") {
      state.location = { pathname: nextPathname, searchStr: nextSearch };
      state.matches = [{ fullPath: nextFullPath }];
      for (const listener of listeners) listener();
    },
  };
}

function fakeWindow(referrer = ""): Window {
  return {
    location: { origin: "https://app.opentag.build" },
    document: { referrer, title: "OpenTag" },
  } as unknown as Window;
}

function armed(pathname = "/agents"): { reporter: AnalyticsReporter; sent: GtagCommand[] } {
  const sent: GtagCommand[] = [];
  const reporter = new AnalyticsReporter({ location: () => ({ pathname }) });
  reporter.arm((command) => sent.push(command));
  return { reporter, sent };
}

function pageViews(sent: GtagCommand[]): GtagCommand[] {
  return sent.filter((command) => command[0] === "event");
}

describe("route analytics", () => {
  it("reports the page the visit starts on, named by its route", () => {
    const { reporter, sent } = armed();

    installRouteAnalytics(fakeRouter("/agents", "/agents"), fakeWindow(), reporter);

    expect(pageViews(sent)).toEqual([
      [
        "event",
        "page_view",
        {
          page_location: "https://app.opentag.build/agents",
          page_path: "/agents",
          page_referrer: undefined,
          page_title: "OpenTag",
        },
      ],
    ]);
  });

  it("reports the route template, never the address that matched it", () => {
    const { reporter, sent } = armed();
    const router = fakeRouter("/agents", "/agents");

    installRouteAnalytics(router, fakeWindow(), reporter);
    // A route with a free-form parameter: no rule over the *value* could tell this from a secret.
    router.go(
      "/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b/settings/private-note",
      "/agents/$agentId/settings/$section",
    );

    expect(pageViews(sent)[1]?.[2]).toEqual({
      page_location: "https://app.opentag.build/agents/:agentId/settings/:section",
      page_path: "/agents/:agentId/settings/:section",
      page_referrer: "https://app.opentag.build/agents",
      page_title: "OpenTag",
    });
    expect(JSON.stringify(sent)).not.toContain("private-note");
    expect(JSON.stringify(sent)).not.toContain("6f1b3c2e");
  });

  it("reports one constant path for a URL the router did not match, carrying none of it", () => {
    const { reporter, sent } = armed();
    const token = "A".repeat(43);
    // `/invites/<token>` renders the not-found page rather than failing to match, and that token
    // grants access to an Account.
    const router = fakeRouter(`/invites/${token}`, "/");

    installRouteAnalytics(router, fakeWindow(), reporter);

    expect(pageViews(sent)[0]?.[2]).toMatchObject({
      page_location: "https://app.opentag.build/(not-found)",
      page_path: "/(not-found)",
    });
    expect(JSON.stringify(sent)).not.toContain(token);
  });

  it("waits for the router to resolve instead of filing the first page of a visit as unrouted", () => {
    const { reporter, sent } = armed();
    const router = fakeRouter("/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b", undefined);

    installRouteAnalytics(router, fakeWindow(), reporter);
    expect(pageViews(sent)).toHaveLength(0);

    router.go("/agents/6f1b3c2e-9d4a-4f8b-8a11-2c3d4e5f6a7b", "/agents/$agentId/");
    expect(pageViews(sent)[0]?.[2]).toMatchObject({ page_path: "/agents/:agentId" });
  });

  it("still reports the root itself as the root", () => {
    const { reporter, sent } = armed("/");

    installRouteAnalytics(fakeRouter("/", "/"), fakeWindow(), reporter);

    expect(pageViews(sent)[0]?.[2]).toMatchObject({ page_path: "/" });
  });

  it("names the referring site by origin on the first view of a document", () => {
    const { reporter, sent } = armed();

    installRouteAnalytics(fakeRouter("/agents", "/agents"), fakeWindow("https://news.example/a/story?id=7"), reporter);

    expect(pageViews(sent)[0]?.[2]).toMatchObject({ page_referrer: "https://news.example" });
  });

  it("does not count the first resolve twice, nor a resolve that lands on the same template", () => {
    const { reporter, sent } = armed();
    const router = fakeRouter("/agents/a", "/agents/$agentId");

    installRouteAnalytics(router, fakeWindow(), reporter);
    router.go("/agents/a", "/agents/$agentId");
    // Two Agents are one page: the report groups them that way.
    router.go("/agents/b", "/agents/$agentId");

    expect(pageViews(sent)).toHaveLength(1);
  });

  it("stops reporting once the subscription is released", () => {
    const { reporter, sent } = armed();
    const router = fakeRouter("/agents", "/agents");

    installRouteAnalytics(router, fakeWindow(), reporter)();
    router.go("/account", "/account");

    expect(pageViews(sent)).toHaveLength(1);
  });
});
