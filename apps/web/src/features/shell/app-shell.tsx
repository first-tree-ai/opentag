import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { browserApi } from "../../api.js";
import opentagLogo from "../../assets/opentag-logo.png";
import { initials } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Button, DropdownMenu, Icon, type IconName, Loader, Sidebar } from "../../ui/design-system.js";
import { useAccount } from "../session/session-context.js";
import { ShellMain } from "./shell-main.js";

const ACCOUNT_ONLY_AGENT_SEGMENTS = new Set(["computers", "new"]);
const AgentShell = lazy(() => import("./agent-shell.js"));

/**
 * Account pages and Agent pages intentionally use different shells. The Account has one primary
 * destination — its Agents — so a global product sidebar would advertise Agent-owned resources at
 * the wrong scope. Once an Agent is selected, its own sidebar becomes the stable work context.
 */
export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const agentId = agentIdFromPathname(pathname);
  return agentId ? (
    <Suspense fallback={<ShellLoading />}>
      <AgentShell
        agentId={agentId}
        renderAccountMenu={(onNavigate) => <AccountMenu onNavigate={onNavigate} placement="sidebar" />}
      />
    </Suspense>
  ) : (
    <AccountShell />
  );
}

export function AccountShell() {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-kumo-canvas" data-ui="account-shell">
      <header className="shrink-0 px-4 pt-5 md:px-8 md:pt-7" data-ui="account-shell-header">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4">
          <Link className="inline-flex items-center gap-2 text-lg font-semibold text-kumo-strong" to="/agents">
            <img alt="" className="block size-6 shrink-0" height={24} src={opentagLogo} width={24} />
            <span>OpenTag</span>
          </Link>
          <AccountMenu placement="page" />
        </div>
      </header>
      <ShellMain>
        <Outlet />
      </ShellMain>
    </div>
  );
}

function ShellLoading() {
  return (
    <div className="grid h-full min-h-0 flex-1 place-items-center bg-kumo-canvas">
      <Loader aria-label={m.shell_loading_agent_workspace()} />
    </div>
  );
}

function AccountMenu({ onNavigate, placement }: { onNavigate?: () => void; placement: "page" | "sidebar" }) {
  const { endSession, me } = useAccount();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState<string>();
  const internalToolsOffered =
    useQuery({
      queryKey: queryKeys.internalToolsOffered(),
      queryFn: () => browserApi.internalToolsOffered(),
      staleTime: Number.POSITIVE_INFINITY,
    }).data === true;

  async function logout() {
    setLoggingOut(true);
    setAccountError(undefined);
    try {
      await browserApi.logout();
      // End the Account-owned cache before login navigation so a later Account cannot see it.
      endSession();
      void navigate({ replace: true, to: "/login" });
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : m.shell_unable_to_sign_out());
      setLoggingOut(false);
    }
  }

  const trigger =
    placement === "sidebar" ? (
      <Sidebar.MenuButton
        aria-label={m.shell_account_menu()}
        className="justify-start"
        icon={
          <span className="flex w-8 shrink-0 items-center justify-center" aria-hidden="true">
            <span className="grid size-6 place-items-center rounded-full bg-kumo-tint text-xs font-medium">
              {initials(me.user.displayName)}
            </span>
          </span>
        }
        tooltip={me.user.displayName}
      >
        <span className="min-w-0 flex-1 truncate text-left">{me.user.displayName}</span>
        <Icon className="size-3.5 text-kumo-subtle" name="chevron-up" />
      </Sidebar.MenuButton>
    ) : (
      <Button aria-label={m.shell_account_menu()} className="gap-2" size="compact" variant="ghost">
        <span
          className="grid size-8 place-items-center rounded-full bg-kumo-tint text-sm font-semibold"
          aria-hidden="true"
        >
          {initials(me.user.displayName)}
        </span>
        <span className="hidden max-w-40 truncate sm:inline">{me.user.displayName}</span>
        <Icon name="chevron-down" />
      </Button>
    );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger render={trigger} />
      <DropdownMenu.Content
        align={placement === "sidebar" ? "start" : "end"}
        aria-label={m.shell_account()}
        className={placement === "sidebar" ? "min-w-(--anchor-width)" : undefined}
        side={placement === "sidebar" ? "top" : "bottom"}
      >
        <DropdownMenu.LinkItem
          closeOnClick
          icon={<MenuItemIcon name="laptop" />}
          render={<Link to="/agents/computers" onClick={() => onNavigate?.()} />}
        >
          {m.shell_computers()}
        </DropdownMenu.LinkItem>
        <DropdownMenu.LinkItem
          closeOnClick
          icon={<MenuItemIcon name="user" />}
          render={<Link to="/account" onClick={() => onNavigate?.()} />}
        >
          {m.shell_account()}
        </DropdownMenu.LinkItem>
        {internalToolsOffered ? (
          <DropdownMenu.LinkItem
            closeOnClick
            icon={<MenuItemIcon name="settings" />}
            render={<Link to="/internal" onClick={() => onNavigate?.()} />}
          >
            {m.shell_internal_tools()}
          </DropdownMenu.LinkItem>
        ) : null}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          closeOnClick={false}
          disabled={loggingOut}
          icon={<MenuItemIcon name="sign-out" />}
          variant="danger"
          onClick={() => void logout()}
        >
          {loggingOut ? (
            <span className="flex items-center gap-2">
              <Loader aria-label={m.shell_signing_out()} size="sm" /> {m.shell_signing_out()}
            </span>
          ) : (
            m.shell_sign_out()
          )}
        </DropdownMenu.Item>
        {accountError ? (
          <span className="block px-2 py-1.5 text-sm text-kumo-danger" role="alert">
            {accountError}
          </span>
        ) : null}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

function MenuItemIcon({ name }: { name: IconName }) {
  return (
    <span className="mr-2 grid size-6 shrink-0 place-items-center text-kumo-subtle" aria-hidden="true">
      <Icon name={name} />
    </span>
  );
}

export function agentIdFromPathname(pathname: string): string | undefined {
  const [, root, candidate] = pathname.split("/");
  if (root !== "agents" || !candidate || ACCOUNT_ONLY_AGENT_SEGMENTS.has(candidate)) return undefined;
  return candidate;
}
