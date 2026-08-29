import { useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { browserApi } from "../../../api.js";
import { RuntimeConfigurationForm } from "../../../runtime-configuration.js";
import { Icon, Loader, Text } from "../../../ui/design-system.js";
import { NotFoundPage } from "../../not-found.js";
import { AsyncState, useResource } from "../../resource/use-resource.js";
import type { AgentDetailView } from "../agent-model.js";
import { loadAgentDetail, markAgentDetailUnconfirmed } from "../agent-model.js";
import { AgentComputerSettings } from "./agent-computer-settings.js";
import { AgentManageSettings } from "./agent-manage-settings.js";
import { GeneralConfigForm } from "./general-config-form.js";
import { ImTab } from "./im-tab.js";
import type { AgentSettingsSection } from "./sections.js";
import { agentSettingsGroups, agentSettingsSections, agentSettingsSummary } from "./sections.js";

export function AgentSettingsPage() {
  const { agentId = "", section } = useParams();
  const location = useLocation();
  const routeState = location.state as {
    agent?: AgentDetailView;
    returnLabel?: string;
    returnTo?: string;
  } | null;
  const initialAgent = routeState?.agent?.id === agentId ? routeState.agent : undefined;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const state = useResource(() => loadAgentDetail(agentId), `${agentId}:${refreshVersion}`, {
    initialValue: initialAgent,
    keepPreviousData: true,
    onBackgroundError: markAgentDetailUnconfirmed,
    // Failure exits land here, so the page has to observe recovery on its own; it is where an
    // operator waits while a Computer reconnects or a Provider finishes installing.
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
  const selected = section as AgentSettingsSection | undefined;
  if (selected && !agentSettingsSections.some((item) => item.key === selected)) return <NotFoundPage />;
  return (
    <AsyncState state={state}>
      {(agent) => {
        const backTo = selected ? (routeState?.returnTo ?? `/agents/${agent.id}/settings`) : `/agents/${agent.id}`;
        const backLabel = selected ? (routeState?.returnLabel ?? "Agent settings") : agent.displayName;
        return (
          <section className="grid gap-6">
            <div className="grid gap-4">
              <Link className="inline-flex w-fit items-center gap-2 text-sm text-kumo-link" to={backTo}>
                <Icon name="arrow-left" />
                Back to {backLabel}
              </Link>
              <div className="min-w-0">
                <AgentSettingsContent
                  agent={agent}
                  section={selected}
                  onAgentChanged={() => setRefreshVersion((value) => value + 1)}
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
  const configState = useResource(() => browserApi.agentConfig(agent.id), `${agent.id}:${section}`);
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
  const configState = useResource(() => browserApi.agentConfig(agent.id), `${agent.id}:settings-overview`);
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
              <section className="grid gap-3" key={group.key} aria-labelledby={`agent-settings-${group.key}`}>
                <Text as="h2" id={`agent-settings-${group.key}`} variant="heading">
                  {group.label}
                </Text>
                <div className="grid overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
                  {agentSettingsSections
                    .filter((item) => item.group === group.key)
                    .map((item) => {
                      const content = (
                        <>
                          <span
                            className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint"
                            aria-hidden="true"
                          >
                            <Icon name={item.icon} />
                          </span>
                          <span className="grid min-w-0 flex-1 gap-1">
                            <strong>{item.label}</strong>
                            <small>{agentSettingsSummary(agent, config, item.key)}</small>
                          </span>
                        </>
                      );
                      const computerReady =
                        item.key === "computer" && agent.availability.dependencies.computer.state === "ready";
                      if (computerReady) {
                        return (
                          <div
                            className="flex items-center gap-3 border-b border-kumo-line p-4 last:border-b-0"
                            key={item.key}
                          >
                            {content}
                          </div>
                        );
                      }
                      return (
                        <Link
                          className="flex items-center gap-3 border-b border-kumo-line p-4 last:border-b-0"
                          key={item.key}
                          to={`/agents/${agent.id}/settings/${item.key}`}
                        >
                          {content}
                          <span
                            className="ml-auto flex shrink-0 items-center gap-2 text-kumo-subtle"
                            aria-hidden="true"
                          >
                            {item.key === "computer" ? <small>Review</small> : null}
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
