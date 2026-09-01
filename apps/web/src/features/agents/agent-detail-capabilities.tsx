import { Link } from "@tanstack/react-router";
import { agentIntegrationPreviews, agentSkillPreviews } from "../../mock/agent-detail-capability-data.js";
import * as m from "../../paraglide/messages.js";
import { StatusIndicator, Text } from "../../ui/design-system.js";

export function AgentIntegrationsTab() {
  return import.meta.env.DEV ? <AgentIntegrationsPreview /> : <AgentIntegrationsUnavailable />;
}

export function AgentIntegrationsPreview() {
  return (
    <div className="grid gap-4" data-ui="agent-integrations-preview">
      <PreviewNotice>{m.agents_integrations_preview_description()}</PreviewNotice>
      <ul aria-label={m.agents_integrations_preview_aria()} className="grid gap-3">
        {agentIntegrationPreviews.map((integration) => (
          <li key={integration.name}>
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <strong>{integration.name}</strong>
                <small>{integration.identity}</small>
              </div>
              <StatusIndicator
                detail={integration.connection}
                label={integration.availability}
                tone={integration.availability === "Available" ? "success" : "warning"}
              />
            </header>
            <p>{integration.purpose}</p>
            <dl className="grid gap-2 text-sm text-kumo-subtle">
              <div>
                <dt>{m.agents_capability_scope()}</dt>
                <dd>{integration.scope}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AgentIntegrationsUnavailable() {
  return (
    <NoAgentCapabilityContract kind="Integrations">
      {m.agents_integrations_unavailable_description()}
    </NoAgentCapabilityContract>
  );
}

export function AgentSkillsTab() {
  return import.meta.env.DEV ? <AgentSkillsPreview /> : <AgentSkillsUnavailable />;
}

export function AgentSkillsPreview() {
  return (
    <div className="grid gap-4" data-ui="agent-skills-preview">
      <PreviewNotice>{m.agents_skills_preview_description()}</PreviewNotice>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>{m.agents_skills_assignments()}</p>
        <Link to="/skills">{m.agents_view_skills()}</Link>
      </div>
      <ul aria-label={m.agents_skills_preview_aria()} className="grid gap-3">
        {agentSkillPreviews.map((skill) => (
          <li key={skill.name}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <strong>{skill.name}</strong>
                <small>{m.agents_capability_source({ source: skill.source })}</small>
              </div>
              <StatusIndicator
                label={skill.assignment}
                tone={skill.assignment === "Assigned" ? "success" : "warning"}
              />
            </div>
            <p>{skill.description}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AgentSkillsUnavailable() {
  return (
    <NoAgentCapabilityContract kind="Skills">{m.agents_skills_unavailable_description()}</NoAgentCapabilityContract>
  );
}

function PreviewNotice({ children }: { children: string }) {
  return (
    <aside className="grid gap-1 rounded-md bg-kumo-info-tint p-3 text-sm">
      <strong>{m.agents_preview_data()}</strong>
      <p>{children}</p>
    </aside>
  );
}

function NoAgentCapabilityContract({ children, kind }: { children: string; kind: "Integrations" | "Skills" }) {
  const title =
    kind === "Integrations" ? m.agents_integrations_unavailable_title() : m.agents_skills_unavailable_title();
  return (
    <section
      aria-labelledby={`agent-${kind.toLowerCase()}-unavailable`}
      className="grid gap-2 rounded-lg bg-kumo-recessed p-6 text-center"
    >
      <span className="text-sm text-kumo-subtle">{m.agents_capability_not_available()}</span>
      <Text as="h3" id={`agent-${kind.toLowerCase()}-unavailable`} variant="heading">
        {title}
      </Text>
      <p>{children}</p>
      <p>{m.agents_no_preview_records_production()}</p>
    </section>
  );
}
