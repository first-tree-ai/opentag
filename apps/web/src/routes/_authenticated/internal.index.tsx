import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { browserApi } from "../../api.js";
import { StandaloneNotFoundPage } from "../../features/not-found.js";
import { AsyncState, toResourceState } from "../../features/resource/resource-state.js";
import { useAccount } from "../../features/session/session-context.js";
import { InternalToolsPage } from "../../internal/internal-tools-page.js";
import { queryKeys } from "../../query/keys.js";

export const Route = createFileRoute("/_authenticated/internal/")({
  component: InternalToolsRoute,
});

/**
 * The staging-only internal tools index. A deployment outside staging is answered exactly like a
 * page that does not exist; on staging every signed-in Account may reset its own onboarding, so
 * reachability is the only question the Server answers here.
 */
function InternalToolsRoute() {
  const { me, refreshMe } = useAccount();
  const navigate = useNavigate();
  const offered = toResourceState(
    useQuery({ queryKey: queryKeys.internalToolsOffered(), queryFn: () => browserApi.internalToolsOffered() }),
  );
  return (
    <AsyncState state={offered}>
      {(value) =>
        value ? (
          <InternalToolsPage
            user={me.user}
            onResetSucceeded={async () => {
              // Success is never inferred from client state: Agent creation is offered only once the
              // refreshed Account actually reports having no Agent left.
              const account = await refreshMe();
              if (account.hasActiveAgent) {
                throw new Error("The Account still reports an Agent; try again.");
              }
              await navigate({ replace: true, to: "/agents/setup" });
            }}
          />
        ) : (
          // The page renders outside AppShell, so its not-found answer carries its own page frame.
          <StandaloneNotFoundPage />
        )
      }
    </AsyncState>
  );
}
