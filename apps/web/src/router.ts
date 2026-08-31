import { createRouter } from "@tanstack/react-router";
import type { AgentDetailView } from "./features/agents/agent-model.js";
import { RouteErrorPage, reportBoundaryError } from "./features/error-boundary.js";
import { StandaloneNotFoundPage } from "./features/not-found.js";
import { routeTree } from "./routeTree.gen.js";

export function createAppRouter() {
  // The shell owns its own scrolling region, so the router must not drive window scroll.
  return createRouter({
    defaultErrorComponent: RouteErrorPage,
    defaultNotFoundComponent: StandaloneNotFoundPage,
    defaultOnCatch: (error, errorInfo) => reportBoundaryError("route", error, errorInfo),
    routeTree,
    scrollRestoration: false,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }

  /**
   * History state carries an already-loaded Agent so a settings or usage page opened from a detail
   * page does not flash a loading state. Settings is one screen belonging to one Agent, so where
   * "Back to …" returns to follows from the Agent itself and needs nothing carried here.
   */
  interface HistoryState {
    agent?: AgentDetailView;
  }
}
