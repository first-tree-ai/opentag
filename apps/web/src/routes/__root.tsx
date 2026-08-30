import { createRootRoute, Outlet } from "@tanstack/react-router";
import { StandaloneNotFoundPage } from "../features/not-found.js";

export const Route = createRootRoute({
  component: RootRoute,
  // The catch-all sits outside every gate, so an unknown path answers without asking for a session.
  notFoundComponent: StandaloneNotFoundPage,
});

function RootRoute() {
  return <Outlet />;
}
