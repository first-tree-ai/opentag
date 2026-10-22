import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { type CSSProperties, lazy, Suspense, useEffect, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Icon, Sidebar, SidebarProvider, SkeletonLine, Tooltip } from "../../ui/design-system.js";
import { OpenTagLogo } from "../../ui/opentag-logo.js";
import { AccountMenu } from "./account-menu.js";
import { AppShellContext } from "./shell-context.js";
import { ShellMain } from "./shell-main.js";

const ACCOUNT_ONLY_AGENT_SEGMENTS = new Set(["computers", "new", "setup"]);
const AgentNavigation = lazy(() => import("./agent-shell.js"));

/** Keep one content track mounted; only the navigation surface changes scope. */
export function AppShell() {
  const agentId = useRouterState({
    select: (state) => agentIdFromPathname(state.resolvedLocation?.pathname ?? state.location.pathname),
  });
  return (
    <AppShellContext value={true}>
      <SidebarProvider
        className="h-full min-h-0 overflow-hidden bg-kumo-canvas"
        collapsible="none"
        defaultOpen
        mobileBreakpoint={0}
        style={
          {
            "--sidebar-width": agentId ? "var(--ui-navigation-width)" : "var(--ui-rail-width)",
          } as CSSProperties
        }
        variant="floating"
      >
        <WorkspaceShell />
      </SidebarProvider>
    </AppShellContext>
  );
}

function WorkspaceShell() {
  const pathname = useRouterState({ select: (state) => state.resolvedLocation?.pathname ?? state.location.pathname });
  const agentId = agentIdFromPathname(pathname);
  const navigation = useAgentExit(agentId, pathname);
  const isHome = /^\/agents\/?$/.test(pathname);

  return (
    <div
      className="app-workspace-shell flex h-full min-h-0 min-w-0 flex-1 bg-kumo-canvas"
      data-ui={agentId ? "agent-shell" : "account-shell"}
      data-scope={agentId ? "agent" : "workspace"}
    >
      <Sidebar
        aria-label={agentId ? m.shell_agent_navigation() : m.shell_account_agents()}
        className="app-navigation"
        contentClassName="app-navigation-container"
      >
        {!agentId && (
          <Link
            className="app-brand-mark rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-kumo-brand"
            to="/agents"
          >
            <OpenTagLogo variant="mark" label={m.auth_brand_name()} />
          </Link>
        )}
        <nav className="app-global-navigation" aria-label={m.shell_account_agents()}>
          <GlobalHome compact={!agentId} active={isHome} />
        </nav>
        <div className="app-agent-navigation" inert={!agentId} aria-hidden={!agentId}>
          {navigation && (
            <Suspense fallback={<NavigationLoading />}>
              <AgentNavigation agentId={navigation.agentId} pathname={navigation.pathname} />
            </Suspense>
          )}
        </div>
        <Sidebar.Footer className="app-account-navigation h-14 w-full px-1.5 group-not-data-[state=collapsed]/sidebar:px-1.5">
          <Sidebar.Menu className="min-w-0 flex-1">
            <Sidebar.MenuItem>
              <AccountMenu placement={agentId ? "sidebar" : "dock"} />
            </Sidebar.MenuItem>
          </Sidebar.Menu>
        </Sidebar.Footer>
      </Sidebar>
      <div className="app-main flex min-h-0 min-w-0 flex-1 flex-col bg-kumo-canvas" data-ui="app-main">
        <ShellMain pathname={pathname} scope={agentId ? "agent" : "workspace"}>
          <Outlet />
        </ShellMain>
      </div>
    </div>
  );
}

function GlobalHome({ compact, active }: { compact: boolean; active: boolean }) {
  return (
    <Tooltip
      content={m.shell_all_agents()}
      disabled={!compact}
      side="right"
      render={
        <Link
          className="app-home-link"
          to="/agents"
          activeOptions={{ exact: true }}
          aria-label={m.shell_all_agents()}
          aria-current={active ? "page" : undefined}
          data-compact={compact ? "true" : undefined}
        >
          <span className="app-home-icon grid size-6 shrink-0 place-items-center" aria-hidden="true">
            <Icon className="size-4.5" name="home" weight="regular" />
          </span>
          <span className="app-nav-label">{m.shell_all_agents()}</span>
        </Link>
      }
    />
  );
}

function NavigationLoading() {
  return (
    <div className="flex h-16 items-center px-5">
      <span className="w-full" aria-busy="true">
        <span className="sr-only">{m.shell_loading_agent_workspace()}</span>
        <SkeletonLine />
      </span>
    </div>
  );
}

export function agentIdFromPathname(pathname: string): string | undefined {
  const [, root, candidate] = pathname.split("/");
  if (root !== "agents" || !candidate || ACCOUNT_ONLY_AGENT_SEGMENTS.has(candidate)) return undefined;
  return candidate;
}

/** Keep outgoing labels for their brief fade, then release the Agent queries. */
function useAgentExit(agentId: string | undefined, pathname: string) {
  const [previous, setPrevious] = useState<{ agentId: string; pathname: string }>();
  useEffect(() => {
    if (agentId) {
      setPrevious({ agentId, pathname });
      return;
    }
    const timeout = setTimeout(() => setPrevious(undefined), 80);
    return () => clearTimeout(timeout);
  }, [agentId, pathname]);
  return agentId ? { agentId, pathname } : previous;
}
