import { Link } from "react-router-dom";
import { agentIntegrationPreviews, agentSkillPreviews } from "./mock/agent-detail-capability-data.js";
import { StatusIndicator } from "./ui/design-system.js";

export function AgentIntegrationsTab() {
  return import.meta.env.DEV ? <AgentIntegrationsPreview /> : <AgentIntegrationsUnavailable />;
}

export function AgentIntegrationsPreview() {
  return (
    <div className="agent-capability-preview">
      <PreviewNotice>
        These examples design the Agent-level connection view. They are not connections from your Workspace.
      </PreviewNotice>
      <ul aria-label="Preview Agent integrations" className="agent-integration-list">
        {agentIntegrationPreviews.map((integration) => (
          <li key={integration.name}>
            <header className="agent-capability-item-heading">
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
            <dl className="agent-capability-facts">
              <div>
                <dt>Scope</dt>
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
      OpenTag cannot yet load external service connections assigned to an individual Agent.
    </NoAgentCapabilityContract>
  );
}

export function AgentSkillsTab() {
  return import.meta.env.DEV ? <AgentSkillsPreview /> : <AgentSkillsUnavailable />;
}

export function AgentSkillsPreview() {
  return (
    <div className="agent-capability-preview">
      <PreviewNotice>
        These example assignments show how Agent skills relate to the Workspace Skills list. No assignments are saved.
      </PreviewNotice>
      <div className="agent-capability-list-heading">
        <p>Skill assignments</p>
        <Link to="/skills">View Workspace Skills</Link>
      </div>
      <ul aria-label="Preview Agent skills" className="agent-skill-list">
        {agentSkillPreviews.map((skill) => (
          <li key={skill.name}>
            <div className="agent-capability-item-heading">
              <div>
                <strong>{skill.name}</strong>
                <small>{skill.source} source</small>
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
    <NoAgentCapabilityContract kind="Skills">
      OpenTag cannot yet load reusable skills assigned to an individual Agent.
    </NoAgentCapabilityContract>
  );
}

function PreviewNotice({ children }: { children: string }) {
  return (
    <aside className="agent-capability-preview-note">
      <strong>Preview data</strong>
      <p>{children}</p>
    </aside>
  );
}

function NoAgentCapabilityContract({ children, kind }: { children: string; kind: "Integrations" | "Skills" }) {
  return (
    <section aria-labelledby={`agent-${kind.toLowerCase()}-unavailable`} className="agent-capability-unavailable">
      <span className="settings-state-label">Not available</span>
      <h3 id={`agent-${kind.toLowerCase()}-unavailable`}>Agent {kind} are not available yet</h3>
      <p>{children}</p>
      <p>No preview records are shown in production.</p>
    </section>
  );
}
