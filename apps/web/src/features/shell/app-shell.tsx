import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { initials } from "../../i18n/format.js";
import {
  DropdownMenu,
  Icon,
  type IconName,
  Loader,
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "../../ui/design-system.js";
import { useAccount } from "../session/session-context.js";

export function AppShell() {
  return (
    <SidebarProvider className="h-full min-h-0 overflow-hidden" collapsible="icon" defaultOpen>
      <AppShellContent />
    </SidebarProvider>
  );
}

export function AppShellContent() {
  const { endSession, me } = useAccount();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  const [openMenu, setOpenMenu] = useState<"account">();
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState<string>();
  const accountMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openMenu !== "account") return;
    accountMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus();
  }, [openMenu]);
  async function logout() {
    setLoggingOut(true);
    setAccountError(undefined);
    try {
      await browserApi.logout();
      // Everything read here belongs to the Account that is signing out. End the session before the
      // login navigation, so a later Account cannot observe the previous one's data while its own
      // reads are pending, and so a refresh still in flight cannot put it back afterwards.
      endSession();
      void navigate({ replace: true, to: "/login" });
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : "Unable to sign out");
      setLoggingOut(false);
    }
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 bg-kumo-canvas" data-ui="shell">
      <Sidebar aria-label="Primary navigation" fullScreenOnMobile>
        <Sidebar.Header>
          <Link className="text-lg font-semibold text-kumo-strong" to="/agents" onClick={() => setOpenMobile(false)}>
            OpenTag
          </Link>
        </Sidebar.Header>
        <Sidebar.Content>
          <nav aria-label="Product">
            <Sidebar.Group>
              <Sidebar.Menu>
                <Sidebar.MenuButton
                  active={isSidebarNavActive(pathname, "/agents")}
                  aria-current={isSidebarNavActive(pathname, "/agents") ? "page" : undefined}
                  href="/agents"
                  icon={<WorkspaceNavIcon name="agents" />}
                  onClick={() => setOpenMobile(false)}
                >
                  Agents
                </Sidebar.MenuButton>
                <Sidebar.MenuButton
                  active={isSidebarNavActive(pathname, "/tasks")}
                  aria-current={isSidebarNavActive(pathname, "/tasks") ? "page" : undefined}
                  href="/tasks"
                  icon={<WorkspaceNavIcon name="tasks" />}
                  onClick={() => setOpenMobile(false)}
                >
                  Tasks
                </Sidebar.MenuButton>
                <Sidebar.MenuButton
                  active={isSidebarNavActive(pathname, "/skills")}
                  aria-current={isSidebarNavActive(pathname, "/skills") ? "page" : undefined}
                  href="/skills"
                  icon={<WorkspaceNavIcon name="skills" />}
                  onClick={() => setOpenMobile(false)}
                >
                  Skills
                </Sidebar.MenuButton>
                <Sidebar.MenuButton
                  active={isSidebarNavActive(pathname, "/integrations")}
                  aria-current={isSidebarNavActive(pathname, "/integrations") ? "page" : undefined}
                  href="/integrations"
                  icon={<WorkspaceNavIcon name="integrations" />}
                  onClick={() => setOpenMobile(false)}
                >
                  Integrations
                </Sidebar.MenuButton>
              </Sidebar.Menu>
            </Sidebar.Group>
          </nav>
        </Sidebar.Content>
        <Sidebar.Footer>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Sidebar.Menu className="min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
              <Sidebar.MenuItem>
                <DropdownMenu
                  open={openMenu === "account"}
                  onOpenChange={(open) => setOpenMenu(open ? "account" : undefined)}
                >
                  <DropdownMenu.Trigger
                    render={
                      <Sidebar.MenuButton
                        aria-label="Account menu"
                        className="justify-start"
                        icon={
                          <span
                            className="grid size-8 place-items-center rounded-full bg-kumo-tint text-sm font-semibold"
                            aria-hidden="true"
                          >
                            {initials(me.user.displayName)}
                          </span>
                        }
                      >
                        <span className="min-w-0 flex-1 truncate text-left">
                          <strong>{me.user.displayName}</strong>
                        </span>
                        <span aria-hidden="true">
                          <Icon name="more-vertical" />
                        </span>
                      </Sidebar.MenuButton>
                    }
                  />
                  <DropdownMenu.Content aria-label="Account" ref={accountMenuRef}>
                    <DropdownMenu.Item href="/agents/computers" onClickCapture={() => setOpenMobile(false)}>
                      Computers
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onClick={() => {
                        setOpenMobile(false);
                        void navigate({ to: "/account" });
                      }}
                    >
                      Account
                    </DropdownMenu.Item>
                    <DropdownMenu.Item disabled={loggingOut} onClick={() => void logout()}>
                      {loggingOut ? (
                        <span className="flex items-center gap-2">
                          <span aria-hidden="true">
                            <Loader aria-label="Signing out" size="sm" />
                          </span>
                          Signing out…
                        </span>
                      ) : (
                        "Sign out"
                      )}
                    </DropdownMenu.Item>
                    {accountError ? (
                      <span className="text-sm text-kumo-danger" role="alert">
                        {accountError}
                      </span>
                    ) : null}
                  </DropdownMenu.Content>
                </DropdownMenu>
              </Sidebar.MenuItem>
            </Sidebar.Menu>
            <Sidebar.Trigger title="Toggle sidebar" />
          </div>
        </Sidebar.Footer>
      </Sidebar>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-ui="app-main">
        <header className="app-mobile-header shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-base px-4 py-3">
          <Link className="font-semibold text-kumo-strong" to="/agents" onClick={() => setOpenMobile(false)}>
            OpenTag
          </Link>
          <SidebarTrigger aria-label="Open navigation" title="Open navigation" />
        </header>
        <main
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5 md:px-8 md:py-8"
          data-ui="content"
        >
          <div className="@container/workspace mx-auto w-full min-w-0 max-w-5xl" data-ui="workspace-page-frame">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

export function WorkspaceNavIcon({ name }: { name: "agents" | "integrations" | "skills" | "tasks" }) {
  const icon: IconName =
    name === "agents" ? "user" : name === "tasks" ? "instructions" : name === "skills" ? "shield" : "settings";
  return <Icon name={icon} />;
}

export function isSidebarNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
