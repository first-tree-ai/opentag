import { ErrorReportRequestSchema } from "@opentag/shared/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createErrorReportSink, resetErrorReportContext } from "./error-reporting.js";
import { installRouteErrorContext } from "./route-error-context.js";

const target = () => ({
  location: { href: "https://opentag.example/agents/42" } as Location,
  navigator: { userAgent: "Mozilla/5.0 (test)" } as Navigator,
});

/** The slice of the router the installer reads, driven by hand so a resolve is an explicit step. */
function fakeRouter(pathname: string, matches: readonly { fullPath: string }[]) {
  const listeners = new Set<() => void>();
  const state = { location: { pathname, searchStr: "" }, matches };
  return {
    router: {
      state,
      subscribe: (_event: "onResolved", listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    resolve(nextPathname: string, nextMatches: readonly { fullPath: string }[]) {
      state.location = { pathname: nextPathname, searchStr: "" };
      state.matches = nextMatches;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

async function reportedRoute(): Promise<string | undefined> {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
  createErrorReportSink({ fetchImpl, target })({ code: "unhandled_error", message: `probe ${Math.random()}` });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
  expect(ErrorReportRequestSchema.safeParse(body).success).toBe(true);
  return body.route;
}

describe("installRouteErrorContext", () => {
  afterEach(() => {
    resetErrorReportContext();
  });

  it("reports the matched route template rather than the address", async () => {
    const { router } = fakeRouter("/agents/42", [{ fullPath: "/" }, { fullPath: "/agents/$agentId" }]);

    installRouteErrorContext(router);

    expect(await reportedRoute()).toBe("/agents/:agentId");
  });

  it("follows the router, and reports an unrouted address as one constant", async () => {
    const { router, resolve } = fakeRouter("/agents", [{ fullPath: "/agents" }]);
    installRouteErrorContext(router);
    expect(await reportedRoute()).toBe("/agents");

    resolve("/nothing-here", [{ fullPath: "/" }]);

    expect(await reportedRoute()).toBe("/(not-found)");
  });

  it("names no route until the router has resolved one", async () => {
    const { router } = fakeRouter("/agents/42", []);

    installRouteErrorContext(router);

    expect(await reportedRoute()).toBeUndefined();
  });

  it("stops following the router once disposed", async () => {
    const { router, resolve, listenerCount } = fakeRouter("/agents", [{ fullPath: "/agents" }]);
    const dispose = installRouteErrorContext(router);

    dispose();
    resolve("/login", [{ fullPath: "/login" }]);

    expect(listenerCount()).toBe(0);
    expect(await reportedRoute()).toBe("/agents");
  });
});
