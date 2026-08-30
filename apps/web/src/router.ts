import { createRouter } from "@tanstack/react-router";
import type { AgentDetailView } from "./features/agents/agent-model.js";
import { routeTree } from "./routeTree.gen.js";

export function createAppRouter() {
  // The shell owns its own scrolling region, so the router must not drive window scroll.
  return createRouter({ routeTree, scrollRestoration: false });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }

  /**
   * History state carries an already-loaded Agent so a settings or usage page opened from a detail
   * page does not flash a loading state, plus the Agent a "Back to …" shortcut should return to.
   * The return destination is the Agent's id rather than a path so the link stays type-checked.
   */
  interface HistoryState {
    agent?: AgentDetailView;
    returnLabel?: string;
    returnAgentId?: string;
  }
}
