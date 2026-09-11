import { Link, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { initials } from "../../i18n/format.js";
import { useInternalNavigationVisibility } from "../../internal/navigation-visibility.js";
import * as m from "../../paraglide/messages.js";
import { DropdownMenu, Icon, Sidebar } from "../../ui/design-system.js";
import { useAgentIdentityList } from "../agents/agent-queries.js";
import {
  agentDetailLink,
  agentIntegrationsLink,
  agentSkillsLink,
  agentTasksLink,
  agentUsageLink,
} from "../agents/agent-routes.js";
import { useAccount } from "../session/session-context.js";
import { MenuItemIcon } from "./menu-item-icon.js";

export default function AgentNavigation({ agentId, pathname }: { agentId: string; pathname: string }) {
  const { me } = useAccount();
  const router = useRouter();
  const state = useAgentIdentityList(me.user.id);
  const agents = state.kind === "ready" ? state.value.agents : [];
  const agent = agents.find((candidate) => candidate.id === agentId);
  const internal = useInternalNavigationVisibility();
  const items = [
    { section: "home", icon: "overview", label: m.shell_overview(), link: agentDetailLink(agentId) },
    { section: "tasks", icon: "instructions", label: m.shell_tasks(), link: agentTasksLink(agentId) },
    ...(internal.skills
      ? ([{ section: "skills", icon: "shield", label: m.shell_skills(), link: agentSkillsLink(agentId) }] as const)
      : []),
    ...(internal.integrations
      ? ([
          {
            section: "integrations",
            icon: "integrations",
            label: m.shell_integrations(),
            link: agentIntegrationsLink(agentId),
          },
        ] as const)
      : []),
    { section: "usage", icon: "usage", label: m.shell_usage(), link: agentUsageLink(agentId) },
  ] as const;
  return (
    <>
      <Sidebar.Header className="h-16 border-b-0 px-1.5">
        <Sidebar.Menu className="min-w-0 flex-1">
          <Sidebar.MenuItem>
            <AgentSwitcher agent={agent} agents={agents} pathname={pathname} agentId={agentId} />
          </Sidebar.MenuItem>
        </Sidebar.Menu>
      </Sidebar.Header>
      <Sidebar.Content className="[&_[data-sidebar=viewport]]:px-1.5 [&_[data-sidebar=viewport]]:pt-0">
        <nav aria-label={m.shell_agent()}>
          <Sidebar.Group className="pt-1">
            <Sidebar.Menu className="gap-1">
              {items.map((item) => {
                const active = isAgentSectionActive(pathname, agentId, item.section);
                return (
                  <Sidebar.MenuButton
                    key={item.section}
                    active={active}
                    aria-current={active ? "page" : undefined}
                    className="min-h-11 rounded-lg px-3 font-normal data-[active]:bg-(--brand-soft) data-[active]:font-medium focus-visible:ring-2 focus-visible:ring-kumo-focus [&>div]:translate-none"
                    href={router.buildLocation(item.link).href}
                    icon={
                      <span className="grid size-6 shrink-0 place-items-center text-kumo-subtle" aria-hidden="true">
                        <Icon className="size-4" name={item.icon} />
                      </span>
                    }
                  >
                    {item.label}
                  </Sidebar.MenuButton>
                );
              })}
            </Sidebar.Menu>
          </Sidebar.Group>
        </nav>
      </Sidebar.Content>
    </>
  );
}

/** Preserve the reader's section across Agents, but never a Task or Settings detail. */
function agentSwitchLink(pathname: string, agentId: string) {
  if (pathname.includes("/tasks")) return agentTasksLink(agentId);
  if (pathname.includes("/skills")) return agentSkillsLink(agentId);
  if (pathname.includes("/integrations")) return agentIntegrationsLink(agentId);
  if (pathname.includes("/usage")) return agentUsageLink(agentId);
  return agentDetailLink(agentId);
}

function AgentSwitcher({
  agent,
  agents,
  pathname,
  agentId,
}: {
  agent?: { id: string; displayName: string };
  agents: readonly { id: string; displayName: string }[];
  pathname: string;
  agentId: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        render={
          <Sidebar.MenuButton
            ref={triggerRef}
            aria-label={
              agent ? m.shell_switch_agent_current({ currentAgent: agent.displayName }) : m.shell_switch_agent()
            }
            className="min-h-11 rounded-lg px-3 hover:bg-kumo-fill-hover focus-visible:ring-2 focus-visible:ring-kumo-focus [&>div]:translate-none"
            icon={
              <span
                className="grid size-6 shrink-0 place-items-center rounded-full bg-kumo-tint text-xs font-semibold"
                aria-hidden="true"
              >
                {agent ? initials(agent.displayName) : "A"}
              </span>
            }
            tooltip={agent?.displayName ?? m.shell_agent()}
          >
            <span className="min-w-0 flex-1 text-left">
              <strong className="block truncate text-sm font-semibold">{agent?.displayName ?? m.shell_agent()}</strong>
            </span>
            <Icon className="size-3.5 text-kumo-subtle" name="chevron-down" />
          </Sidebar.MenuButton>
        }
      />
      <DropdownMenu.Content
        align="start"
        className="app-agent-menu w-(--anchor-width) max-w-[calc(100vw-1.5rem)]"
        container={triggerRef.current?.closest<HTMLElement>("aside, nav, header, main")}
        positionMethod="fixed"
        style={{ zIndex: 50 }}
        side="bottom"
      >
        {agents.map((candidate) => (
          <DropdownMenu.LinkItem
            closeOnClick
            icon={
              <span
                className="mr-2 grid size-6 shrink-0 place-items-center rounded-full bg-kumo-tint text-xs font-semibold"
                aria-hidden="true"
              >
                {initials(candidate.displayName)}
              </span>
            }
            key={candidate.id}
            render={
              <Link
                {...(candidate.id === agentId ? { to: pathname } : agentSwitchLink(pathname, candidate.id))}
                onClick={candidate.id === agentId ? (event) => event.preventDefault() : undefined}
              />
            }
            aria-current={candidate.id === agentId ? "true" : undefined}
            className={candidate.id === agentId ? "bg-(--brand-soft)" : undefined}
          >
            <span className="min-w-0 flex-1 truncate">{candidate.displayName}</span>
            {candidate.id === agentId && <Icon name="check" />}
          </DropdownMenu.LinkItem>
        ))}
        <DropdownMenu.Separator />
        <DropdownMenu.LinkItem
          closeOnClick
          icon={<MenuItemIcon name="arrow-left" />}
          render={<Link to="/agents" activeOptions={{ exact: true }} />}
        >
          {m.shell_all_agents()}
        </DropdownMenu.LinkItem>
        <DropdownMenu.LinkItem
          closeOnClick
          icon={<MenuItemIcon name="plus" />}
          render={<Link to="/agents/setup" search={{ action: "create" }} />}
        >
          {m.shell_new_agent()}
        </DropdownMenu.LinkItem>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

export function isAgentSectionActive(
  pathname: string,
  agentId: string,
  section: "home" | "integrations" | "skills" | "tasks" | "usage",
): boolean {
  const root = `/agents/${agentId}`;
  if (section === "home") return isAgentHome(pathname, agentId);
  return pathname === `${root}/${section}` || pathname.startsWith(`${root}/${section}/`);
}

function isAgentHome(pathname: string, agentId: string): boolean {
  const root = `/agents/${agentId}`;
  return pathname === root || pathname === `${root}/`;
}
