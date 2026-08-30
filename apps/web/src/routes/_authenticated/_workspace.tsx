import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/_workspace")({
  component: AuthenticatedResourceLayout,
});

/**
 * Pathless layout for Account-owned resource pages. Workspace membership is no longer an
 * authority gate; setup completion is enforced by the onboarding and shell routes.
 */
function AuthenticatedResourceLayout() {
  return <Outlet />;
}
