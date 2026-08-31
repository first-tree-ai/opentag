import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useSyncExternalStore } from "react";
import { initials } from "../../i18n/format.js";
import {
  DropdownMenu,
  Icon,
  type IconName,
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "../../ui/design-system.js";
import type { AgentListItem } from "../agents/agent-model.js";
import { useAgentListView } from "../agents/agent-queries.js";
import {
  agentDetailLink,
  agentIntegrationsLink,
  agentSkillsLink,
  agentTasksLink,
  agentUsageLink,
} from "../agents/agent-routes.js";
import { useAccount } from "../session/session-context.js";
import { AgentReturnEntry } from "./agent-return-entry.js";
import { ShellMain } from "./shell-main.js";

const AGENT_SIDEBAR_MOBILE_QUERY = "(max-width: 767px)";

export default function AgentShell({
  agentId,
  renderAccountMenu,
}: {
  agentId: string;
  renderAccountMenu: (onNavigate: () => void) => ReactNode;
}) {
  const isMobileAgentShell = useIsMobileAgentShell();

  return (
    <SidebarProvider
      className="h-full min-h-0 overflow-hidden bg-kumo-canvas"
      collapsible={isMobileAgentShell ? "icon" : "none"}
      defaultOpen
      variant="floating"
    >
      <AgentShellContent agentId={agentId} renderAccountMenu={renderAccountMenu} />
    </SidebarProvider>
  );
}

function AgentShellContent({
  agentId,
  renderAccountMenu,
}: {
  agentId: string;
  renderAccountMenu: (onNavigate: () => void) => ReactNode;
}) {
  const { me } = useAccount();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  const agentsState = useAgentListView(me.user.id);
  const agents = agentsState.kind === "ready" ? agentsState.value.agents : [];
  const agent = agents.find((candidate) => candidate.id === agentId);

  function closeMobile() {
    setOpenMobile(false);
  }

  function openAgent(targetAgentId: string) {
    closeMobile();
    if (pathname.includes("/tasks")) {
      void navigate(agentTasksLink(targetAgentId));
      return;
    }
    if (pathname.includes("/skills")) {
      void navigate(agentSkillsLink(targetAgentId));
      return;
    }
    if (pathname.includes("/integrations")) {
      void navigate(agentIntegrationsLink(targetAgentId));
      return;
    }
    if (pathname.includes("/usage")) {
      void navigate(agentUsageLink(targetAgentId));
      return;
    }
    void navigate(agentDetailLink(targetAgentId));
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 bg-kumo-canvas" data-ui="agent-shell">
      <Sidebar
        aria-label="Agent navigation"
        className="bg-kumo-canvas md:m-2 md:mr-0 md:h-[calc(100%-1rem)] md:rounded-lg md:shadow-xs"
        contentClassName="bg-kumo-canvas md:rounded-lg"
        fullScreenOnMobile
      >
        <Sidebar.Header className="border-b-0">
          <Sidebar.Menu className="min-w-0 flex-1">
            <Sidebar.MenuItem>
              <AgentSwitcher
                agent={agent}
                agents={agents}
                onAllAgents={() => {
                  closeMobile();
                  void navigate({ to: "/agents" });
                }}
                onNewAgent={() => {
                  closeMobile();
                  void navigate({ to: "/agents/new" });
                }}
                onOpenAgent={openAgent}
              />
            </Sidebar.MenuItem>
          </Sidebar.Menu>
          <Sidebar.Close className="sm:hidden" />
        </Sidebar.Header>
        <Sidebar.Content>
          <nav aria-label="Agent">
            <Sidebar.Group>
              <Sidebar.Menu>
                <AgentNavItem
                  active={isAgentSectionActive(pathname, agentId, "home")}
                  icon="home"
                  label="Home"
                  onClick={() => {
                    closeMobile();
                    void navigate(agentDetailLink(agentId));
                  }}
                />
                <AgentNavItem
                  active={isAgentSectionActive(pathname, agentId, "tasks")}
                  icon="instructions"
                  label="Tasks"
                  onClick={() => {
                    closeMobile();
                    void navigate(agentTasksLink(agentId));
                  }}
                />
                <AgentNavItem
                  active={isAgentSectionActive(pathname, agentId, "skills")}
                  icon="shield"
                  label="Skills"
                  onClick={() => {
                    closeMobile();
                    void navigate(agentSkillsLink(agentId));
                  }}
                />
                <AgentNavItem
                  active={isAgentSectionActive(pathname, agentId, "integrations")}
                  icon="integrations"
                  label="Integrations"
                  onClick={() => {
                    closeMobile();
                    void navigate(agentIntegrationsLink(agentId));
                  }}
                />
                <AgentNavItem
                  active={isAgentSectionActive(pathname, agentId, "usage")}
                  icon="usage"
                  label="Usage"
                  onClick={() => {
                    closeMobile();
                    void navigate(agentUsageLink(agentId));
                  }}
                />
              </Sidebar.Menu>
            </Sidebar.Group>
          </nav>
        </Sidebar.Content>
        <Sidebar.Footer>
          <Sidebar.Menu className="min-w-0 flex-1">
            <Sidebar.MenuItem>{renderAccountMenu(closeMobile)}</Sidebar.MenuItem>
          </Sidebar.Menu>
        </Sidebar.Footer>
      </Sidebar>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-kumo-canvas md:ml-2" data-ui="app-main">
        <header className="app-mobile-header shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-base px-4 py-3">
          <span className="min-w-0 truncate font-semibold text-kumo-strong">{agent?.displayName ?? "Agent"}</span>
          <SidebarTrigger aria-label="Open Agent navigation" title="Open Agent navigation" />
        </header>
        <ShellMain>
          {isAgentHome(pathname, agentId) ? <AgentReturnEntry /> : null}
          <Outlet />
        </ShellMain>
      </div>
    </div>
  );
}

function useIsMobileAgentShell(): boolean {
  return useSyncExternalStore(subscribeToAgentShellViewport, isMobileAgentShellViewport, () => false);
}

function subscribeToAgentShellViewport(onChange: () => void): () => void {
  const mediaQuery = window.matchMedia(AGENT_SIDEBAR_MOBILE_QUERY);
  mediaQuery.addEventListener("change", onChange);
  return () => mediaQuery.removeEventListener("change", onChange);
}

function isMobileAgentShellViewport(): boolean {
  return window.matchMedia(AGENT_SIDEBAR_MOBILE_QUERY).matches;
}

function AgentSwitcher({
  agent,
  agents,
  onAllAgents,
  onNewAgent,
  onOpenAgent,
}: {
  agent?: AgentListItem;
  agents: AgentListItem[];
  onAllAgents: () => void;
  onNewAgent: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Sidebar.MenuButton
            aria-label={`Switch Agent${agent ? `, current Agent ${agent.displayName}` : ""}`}
            className="h-12 py-1"
            icon={
              <span
                className="grid size-8 shrink-0 place-items-center rounded-full bg-kumo-tint text-sm font-semibold group-data-[state=collapsed]/sidebar:size-4 group-data-[state=collapsed]/sidebar:text-xs"
                aria-hidden="true"
              >
                {agent ? initials(agent.displayName) : "A"}
              </span>
            }
            tooltip={agent?.displayName ?? "Agent"}
          >
            <span className="grid min-w-0 flex-1 gap-0.5 text-left">
              <strong className="truncate">{agent?.displayName ?? "Agent"}</strong>
              <span className="truncate text-xs font-normal text-kumo-subtle">{sidebarAgentStatus(agent)}</span>
            </span>
            <Icon name="chevron-down" />
          </Sidebar.MenuButton>
        }
      />
      <DropdownMenu.Content align="start" aria-label="Switch Agent" className="min-w-(--anchor-width)" side="bottom">
        {agents.map((candidate) => (
          <DropdownMenu.Item
            icon={
              <span
                className="mr-2 grid size-6 shrink-0 place-items-center rounded-full bg-kumo-tint text-xs font-semibold"
                aria-hidden="true"
              >
                {initials(candidate.displayName)}
              </span>
            }
            key={candidate.id}
            onClick={() => onOpenAgent(candidate.id)}
            selected={candidate.id === agent?.id}
          >
            <span className="min-w-0 flex-1 truncate">{candidate.displayName}</span>
          </DropdownMenu.Item>
        ))}
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={<MenuItemIcon name="arrow-left" />} onClick={onAllAgents}>
          All Agents
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={<MenuItemIcon name="plus" />} onClick={onNewAgent}>
          New Agent
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

function sidebarAgentStatus(agent?: AgentListItem): string {
  if (!agent) return "Loading…";
  if (agent.status === "suspended") return "Paused";
  if (agent.activity.state === "working") return "Working";
  if (agent.availability.state === "ready") return "Ready";
  if (agent.availability.state === "setting_up") return "Setting up";
  if (agent.availability.state === "not_connected") return "Setup required";
  if (agent.availability.state === "action_required") return "Action needed";
  return "Status unknown";
}

function AgentNavItem({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <Sidebar.MenuButton
      active={active}
      aria-current={active ? "page" : undefined}
      icon={
        <span className="flex w-8 shrink-0 items-center justify-center" aria-hidden="true">
          <Icon name={icon} />
        </span>
      }
      onClick={onClick}
    >
      {label}
    </Sidebar.MenuButton>
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

function MenuItemIcon({ name }: { name: IconName }) {
  return (
    <span className="mr-2 grid size-6 shrink-0 place-items-center text-kumo-subtle" aria-hidden="true">
      <Icon name={name} />
    </span>
  );
}
