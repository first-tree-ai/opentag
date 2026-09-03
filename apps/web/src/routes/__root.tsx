import { createRootRoute, Outlet } from "@tanstack/react-router";
import { RouteErrorPage } from "../features/error-boundary.js";
import { StandaloneNotFoundPage } from "../features/not-found.js";

export const Route = createRootRoute({
  component: RootRoute,
  errorComponent: RouteErrorPage,
  // The catch-all sits outside every gate, so an unknown path answers without asking for a session.
  notFoundComponent: StandaloneNotFoundPage,
});

function RootRoute() {
  return <Outlet />;
}
