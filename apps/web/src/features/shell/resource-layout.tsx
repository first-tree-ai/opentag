import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAccount } from "../session/session-context.js";
import { AppShell } from "./app-shell.js";
import { clearStandaloneSetup, hasStandaloneSetup, rememberStandaloneSetup } from "./setup-layout.js";
import { ShellMemoryProvider } from "./shell-memory.js";

/** One shell and one session-local memory survive navigation into and out of Agent Setup. */
export function ResourceLayout() {
  const { me } = useAccount();
  return (
    <ShellMemoryProvider key={me.user.id}>
      <AccountResources />
    </ShellMemoryProvider>
  );
}

function AccountResources() {
  const { me } = useAccount();
  const { setup, slackProvision, cardLink } = useRouterState({
    select: (state) => {
      const location = state.resolvedLocation ?? state.location;
      const search = location.search as Record<string, unknown>;
      const provision = search.slackProvision;
      return {
        setup: /^\/agents\/setup\/?$/.test(location.pathname),
        slackProvision: location.pathname === "/account" && (provision === true || provision === "true"),
        // A link from an IM card, which any conversation member may open before having an Agent.
        cardLink: location.pathname.startsWith("/im-feedback/") && typeof search.open === "string",
      };
    },
  });
  const [journey, setJourney] = useState(() => ({
    setup,
    standalone: setup && (!me.setupCompletedAt || hasStandaloneSetup(me.user.id)),
  }));
  // Admission updates /me in the middle of first-time setup. Only entering or leaving the
  // route changes its presentation; an Account refresh must not introduce a sidebar mid-step.
  let current = journey;
  if (journey.setup !== setup) {
    current = { setup, standalone: setup && !me.setupCompletedAt };
    setJourney(current);
  }
  const standalone = current.standalone;
  useEffect(() => {
    if (setup && standalone) rememberStandaloneSetup(me.user.id);
    else clearStandaloneSetup();
  }, [setup, standalone, me.user.id]);

  if ((!me.setupCompletedAt && !slackProvision && !cardLink) || (setup && standalone)) return <Outlet />;
  return <AppShell />;
}
