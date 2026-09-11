import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  type CSSProperties,
  type KeyboardEvent,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as m from "../../paraglide/messages.js";
import {
  Icon,
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  SkeletonLine,
  Tooltip,
  useSidebar,
} from "../../ui/design-system.js";
import { AccountMenu } from "./account-menu.js";
import { ShellMain } from "./shell-main.js";
import { ShellMemoryProvider } from "./shell-memory.js";

const ACCOUNT_ONLY_AGENT_SEGMENTS = new Set(["computers", "new", "setup"]);
const AgentNavigation = lazy(() => import("./agent-shell.js"));

/** Keep one content track mounted; only the navigation surface changes scope. */
export function AppShell() {
  const isMobile = useSyncExternalStore(subscribeViewport, mobileViewport, () => false);
  return (
    <ShellMemoryProvider>
      <SidebarProvider
        className="h-full min-h-0 overflow-hidden bg-kumo-canvas"
        collapsible={isMobile ? "icon" : "none"}
        defaultOpen
        mobileBreakpoint={768}
        style={{ "--sidebar-width": "15rem" } as CSSProperties}
        variant="floating"
      >
        <WorkspaceShell />
      </SidebarProvider>
    </ShellMemoryProvider>
  );
}

function WorkspaceShell() {
  const pathname = useRouterState({ select: (state) => state.resolvedLocation?.pathname ?? state.location.pathname });
  const agentId = agentIdFromPathname(pathname);
  const { isMobile, setOpenMobile } = useSidebar();
  const navigation = useAgentExit(agentId, pathname);
  const isHome = /^\/agents\/?$/.test(pathname);
  const previousPath = useRef(pathname);
  useEffect(() => {
    // Route blockers have already settled. Rejected navigation must not dismiss the drawer.
    if (previousPath.current !== pathname) setOpenMobile(false);
    previousPath.current = pathname;
  }, [pathname, setOpenMobile]);

  return (
    <div
      className="app-workspace-shell flex h-full min-h-0 min-w-0 flex-1 bg-kumo-canvas"
      data-ui={agentId ? "agent-shell" : "account-shell"}
      data-scope={agentId ? "agent" : "workspace"}
    >
      {(!isMobile || agentId) && (
        <Sidebar
          aria-label={agentId ? m.shell_agent_navigation() : m.shell_account_agents()}
          className="app-navigation"
          contentClassName="app-navigation-container"
          onKeyDown={isMobile ? containMobileFocus : undefined}
          fullScreenOnMobile
        >
          <div aria-hidden="true" className="app-navigation-surface" />
          <nav className="app-global-navigation" aria-label={m.shell_account_agents()}>
            <GlobalHome compact={!agentId && !isMobile} active={isHome} />
            {isMobile && <Sidebar.Close />}
          </nav>
          <div className="app-agent-navigation" inert={!agentId} aria-hidden={!agentId}>
            {navigation && (
              <Suspense fallback={<NavigationLoading />}>
                <AgentNavigation agentId={navigation.agentId} pathname={navigation.pathname} />
              </Suspense>
            )}
          </div>
          <Sidebar.Footer className="app-account-navigation h-14 px-1.5">
            <Sidebar.Menu className="min-w-0 flex-1">
              <Sidebar.MenuItem>
                <AccountMenu placement={agentId ? "sidebar" : "dock"} />
              </Sidebar.MenuItem>
            </Sidebar.Menu>
          </Sidebar.Footer>
        </Sidebar>
      )}
      <div className="app-main flex min-h-0 min-w-0 flex-1 flex-col bg-kumo-canvas" data-ui="app-main">
        {isMobile && (
          <header className="app-mobile-header h-14 shrink-0 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4">
            <Link
              className="app-home-link"
              to="/agents"
              activeOptions={{ exact: true }}
              aria-current={isHome ? "page" : undefined}
            >
              <Icon className="size-5" name="home" />
              <span>{m.shell_all_agents()}</span>
            </Link>
            {agentId ? (
              <SidebarTrigger aria-label={m.shell_open_agent_navigation()} title={m.shell_open_agent_navigation()} />
            ) : (
              <AccountMenu placement="page" />
            )}
          </header>
        )}
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
            <Icon className="size-5" name="home" />
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

function mobileViewport() {
  return window.matchMedia("(max-width: 767px)").matches;
}

function subscribeViewport(listener: () => void) {
  const query = window.matchMedia("(max-width: 767px)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
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

function containMobileFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]'),
  ].filter((node) => node.getClientRects().length > 0);
  const first = controls.at(0);
  const last = controls.at(-1);
  const next = event.shiftKey ? last : first;
  const boundary = event.shiftKey ? first : last;
  if (document.activeElement === boundary && next) {
    event.preventDefault();
    next.focus();
  }
}
