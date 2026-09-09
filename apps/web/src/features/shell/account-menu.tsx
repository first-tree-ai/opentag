import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { initials } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Button, DropdownMenu, Icon, Loader, Sidebar, Tooltip } from "../../ui/design-system.js";
import { useAccount } from "../session/session-context.js";
import { MenuItemIcon } from "./menu-item-icon.js";

export function AccountMenu({
  onNavigate,
  placement,
}: {
  onNavigate?: () => void;
  placement: "page" | "sidebar" | "dock";
}) {
  const { endSession, me } = useAccount();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
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
    placement !== "page" ? (
      <Sidebar.MenuButton
        ref={triggerRef}
        aria-label={m.shell_account_menu()}
        className="app-account-trigger justify-start [&>div]:translate-none"
        data-compact={placement === "dock" ? "true" : undefined}
        icon={
          <span className="app-account-icon grid size-6 shrink-0 place-items-center" aria-hidden="true">
            <span className="app-account-avatar grid size-6 place-items-center rounded-full bg-kumo-tint text-xs font-medium">
              {initials(me.user.displayName)}
            </span>
          </span>
        }
      >
        <span className="app-nav-label min-w-0 flex-1 truncate text-left">{me.user.displayName}</span>
        <Icon className="app-nav-label size-3.5 text-kumo-subtle" name="chevron-up" />
      </Sidebar.MenuButton>
    ) : (
      <Button
        ref={triggerRef}
        aria-label={m.shell_account_menu()}
        className="app-account-trigger gap-2"
        size="compact"
        variant="ghost"
      >
        <span
          className="app-account-avatar grid size-8 place-items-center rounded-full bg-kumo-tint text-sm font-semibold"
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
      <Tooltip
        content={m.shell_account_menu()}
        disabled={placement !== "dock" || open}
        side="right"
        render={<DropdownMenu.Trigger render={trigger} />}
      />
      <DropdownMenu.Content
        align={placement === "sidebar" ? "start" : "end"}
        className="app-account-menu"
        // Keep the popup within its owning landmark without introducing a transient navigation region.
        container={triggerRef.current?.closest<HTMLElement>("aside, nav, header, main")}
        positionMethod="fixed"
        style={{ zIndex: 50 }}
        side={placement === "dock" ? "right" : placement === "sidebar" ? "top" : "bottom"}
        sideOffset={placement === "dock" ? 16 : 8}
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
