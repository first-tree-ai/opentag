import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { browserApi } from "../../../api.js";
import { queryKeys } from "../../../query/keys.js";
import { Icon, Loader, Text } from "../../../ui/design-system.js";
import { NotFoundPage } from "../../not-found.js";
import { AsyncState, toResourceState } from "../../resource/resource-state.js";
import type { AgentDetailView } from "../agent-model.js";
import { useAgentDetailView } from "../agent-queries.js";
import { agentDetailLink, agentSettingsLink, agentSettingsSectionLink } from "../agent-routes.js";
import { AgentComputerSettings } from "./agent-computer-settings.js";
import { AgentManageSettings } from "./agent-manage-settings.js";
import { GeneralConfigForm } from "./general-config-form.js";
import { ImTab } from "./im-tab.js";
import { RuntimeConfigurationForm } from "./runtime-configuration.js";
import type { AgentSettingsSection } from "./sections.js";
import { agentSettingsGroups, agentSettingsSections, agentSettingsSummary } from "./sections.js";

export function AgentSettingsPage({ agentId, section }: { agentId: string; section?: string }) {
  const routeState = useRouterState({ select: (state) => state.location.state });
  const initialAgent = routeState.agent?.id === agentId ? routeState.agent : undefined;
  const queryClient = useQueryClient();
  // Failure exits land here, so the page has to observe recovery on its own; it is where an
  // operator waits while a Computer reconnects or a Provider finishes installing.
  const state = useAgentDetailView(agentId, { watched: true, initialAgent });
  const selected = section as AgentSettingsSection | undefined;
  if (selected && !agentSettingsSections.some((item) => item.key === selected)) return <NotFoundPage />;
  return (
    <AsyncState state={state}>
      {(agent) => {
        const returnAgentId = routeState.returnAgentId;
        const back = selected
          ? returnAgentId
            ? agentDetailLink(returnAgentId)
            : agentSettingsLink(agent.id)
          : agentDetailLink(agent.id);
        const backLabel = selected ? (routeState.returnLabel ?? "Agent settings") : agent.displayName;
        return (
          <section className="grid gap-6">
            <div className="grid gap-4">
              <Link className="inline-flex w-fit items-center gap-2 text-sm text-kumo-link" {...back}>
                <Icon name="arrow-left" />
                Back to {backLabel}
              </Link>
              <div className="min-w-0">
                <AgentSettingsContent
                  agent={agent}
                  section={selected}
                  // A write can change the Agent and its config together, so both are dropped.
                  onAgentChanged={() => void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all(agentId) })}
                />
              </div>
            </div>
          </section>
        );
      }}
    </AsyncState>
  );
}

export function AgentSettingsContent({
  agent,
  section,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  section: AgentSettingsSection | undefined;
  onAgentChanged: () => void;
}) {
  if (!section) return <AgentSettingsOverview agent={agent} />;
  if (section === "messaging") return <ImTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (section === "computer") return <AgentComputerSettings agent={agent} onAgentChanged={onAgentChanged} />;
  return <AgentConfigSettingsContent agent={agent} section={section} onAgentChanged={onAgentChanged} />;
}

export function AgentConfigSettingsContent({
  agent,
  section,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  section: Exclude<AgentSettingsSection, "computer" | "messaging">;
  onAgentChanged: () => void;
}) {
  // The section is not part of the key: the config does not vary by section, so switching between
  // them reads what is already cached instead of asking again.
  const configState = toResourceState(
    useQuery({ queryKey: queryKeys.agents.config(agent.id), queryFn: () => browserApi.agentConfig(agent.id) }),
  );
  return (
    <AsyncState state={configState}>
      {(config) => {
        if (section === "identity") {
          return <GeneralConfigForm initialConfig={config} onAgentChanged={onAgentChanged} />;
        }
        if (section === "instructions" || section === "execution") {
          return (
            <RuntimeConfigurationForm
              initialConfig={config}
              save={(input) => browserApi.updateAgent(config.id, input)}
              section={section}
            />
          );
        }
        return <AgentManageSettings agent={agent} initialConfig={config} onAgentChanged={onAgentChanged} />;
      }}
    </AsyncState>
  );
}

export function AgentSettingsOverview({ agent }: { agent: AgentDetailView }) {
  const configState = toResourceState(
    useQuery({ queryKey: queryKeys.agents.config(agent.id), queryFn: () => browserApi.agentConfig(agent.id) }),
  );
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Text as="h1" size="lg" variant="heading">
          Agent settings
        </Text>
      </header>
      <AsyncState loading={<AgentSettingsDirectoryLoading />} state={configState}>
        {(config) => (
          <div className="grid gap-6">
            {agentSettingsGroups.map((group) => (
              <section
                className={group.label ? "mt-4 grid gap-3 border-t border-kumo-line pt-2" : "grid gap-3"}
                key={group.key}
                aria-label={group.label ?? "Agent setup"}
                aria-labelledby={group.label ? `agent-settings-${group.key}` : undefined}
              >
                {group.label ? (
                  <Text as="h2" id={`agent-settings-${group.key}`} variant="heading">
                    {group.label}
                  </Text>
                ) : null}
                <div className="grid overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
                  {agentSettingsSections
                    .filter((item) => item.group === group.key)
                    .map((item) => {
                      const content = (
                        <>
                          <span
                            className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint"
                            aria-hidden="true"
                            data-ui="agent-settings-entry-icon"
                          >
                            <Icon name={item.icon} />
                          </span>
                          <span className="grid min-w-0 flex-1 gap-1">
                            <strong>{item.label}</strong>
                            <small>{agentSettingsSummary(agent, config, item.key)}</small>
                          </span>
                        </>
                      );
                      /*
                       * Every row opens its page. A row that is a link only sometimes cannot be
                       * predicted from looking at the list, and the Computer page is worth reading
                       * whether or not the Computer currently needs attention.
                       */
                      const computerNeedsReview =
                        item.key === "computer" && agent.availability.dependencies.computer.state !== "ready";
                      return (
                        <Link
                          className="flex items-center gap-3 border-b border-kumo-line p-4 last:border-b-0"
                          key={item.key}
                          data-ui="agent-settings-entry"
                          {...agentSettingsSectionLink(agent.id, item.key)}
                        >
                          {content}
                          <span
                            className="ml-auto flex shrink-0 items-center gap-2 text-kumo-subtle"
                            aria-hidden="true"
                          >
                            {computerNeedsReview ? <small>Review</small> : null}
                            <Icon name="chevron-right" />
                          </span>
                        </Link>
                      );
                    })}
                </div>
              </section>
            ))}
          </div>
        )}
      </AsyncState>
    </div>
  );
}

export function AgentSettingsDirectoryLoading() {
  return (
    <div aria-label="Loading Agent settings" className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
      <span aria-hidden="true">
        <Loader />
      </span>
      <span>Loading Agent settings…</span>
    </div>
  );
}
