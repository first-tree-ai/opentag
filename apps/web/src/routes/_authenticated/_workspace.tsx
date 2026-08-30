import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useAccount, WorkspaceContext } from "../../features/session/session-context.js";
import { Button, Text } from "../../ui/design-system.js";

export const Route = createFileRoute("/_authenticated/_workspace")({
  component: WorkspaceAuthorityGate,
});

/** Refuses the Account-shaped dead end to the routes that act on stored resources. */
function WorkspaceAuthorityGate() {
  const { me, refreshMe, reloadMe } = useAccount();
  const membership = me.workspaces[0];
  if (!membership) return <NoWorkspaceAccess onRetry={reloadMe} />;
  return (
    <WorkspaceContext value={{ me, membership, refreshMe, reloadMe }}>
      <Outlet />
    </WorkspaceContext>
  );
}

function NoWorkspaceAccess({ onRetry }: { onRetry: () => void }) {
  return (
    <main
      className="mx-auto grid max-w-xl gap-4 rounded-lg bg-kumo-base p-6 ring ring-kumo-line"
      data-ui="account-access"
    >
      <span className="text-xs font-medium uppercase text-kumo-subtle">Account access</span>
      <Text as="h1" size="lg" variant="heading">
        OpenTag is not ready for this account
      </Text>
      <Text as="p" variant="secondary">
        The server has not assigned the internal access needed to use OpenTag.
      </Text>
      <div className="rounded-md bg-kumo-info-tint p-3 text-sm" role="status">
        Retry after provisioning finishes, or contact an operator if this continues.
      </div>
      <Button onClick={onRetry}>Check again</Button>
    </main>
  );
}
