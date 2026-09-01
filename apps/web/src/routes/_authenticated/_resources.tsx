import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/_resources")({
  component: AuthenticatedResourceLayout,
});

/**
 * Pathless layout for Account-owned resource pages. Setup completion is enforced by the
 * onboarding and shell routes.
 */
function AuthenticatedResourceLayout() {
  return <Outlet />;
}
