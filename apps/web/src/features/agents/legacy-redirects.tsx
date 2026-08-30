import { Link } from "@tanstack/react-router";
import { buttonClassName, Text } from "../../ui/design-system.js";
import { Redirect } from "../navigation/redirect.js";
import { NotFoundPage } from "../not-found.js";
import { AsyncState } from "../resource/use-resource.js";
import { AgentObjectHeader } from "./agent-detail-page.js";
import { useAgentDetailView } from "./agent-queries.js";
import { agentDetailLink, agentSettingsSectionLink } from "./agent-routes.js";

export function LegacyAgentSectionRedirect({ agentId, legacySection }: { agentId: string; legacySection: string }) {
  if (legacySection === "general") return <Redirect replace {...agentDetailLink(agentId)} />;
  if (legacySection === "runtime") {
    return <Redirect replace {...agentSettingsSectionLink(agentId, "execution")} />;
  }
  if (legacySection === "im") return <Redirect replace {...agentSettingsSectionLink(agentId, "messaging")} />;
  if (legacySection === "integrations" || legacySection === "skills") {
    return <LegacyAgentCapabilityPage agentId={agentId} capability={legacySection} />;
  }
  return <NotFoundPage />;
}

export function LegacyAgentCapabilityPage({
  agentId,
  capability,
}: {
  agentId: string;
  capability: "integrations" | "skills";
}) {
  const state = useAgentDetailView(agentId);
  const label = capability === "integrations" ? "integrations" : "skills";
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="grid gap-6">
          <AgentObjectHeader agent={agent} />
          <div className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line">
            <header className="grid gap-2">
              <Text as="h2" variant="heading">
                Agent {label} are not available here
              </Text>
              <Text as="p" variant="secondary">
                OpenTag does not currently show {label} assigned to {agent.displayName}. The shared catalog is separate
                from this Agent.
              </Text>
            </header>
            <div className="flex flex-wrap gap-3">
              <Link className={buttonClassName()} {...agentDetailLink(agent.id)}>
                Back to {agent.displayName}
              </Link>
              <Link
                className={buttonClassName({ variant: "secondary" })}
                to={capability === "integrations" ? "/integrations" : "/skills"}
              >
                Browse {label}
              </Link>
            </div>
          </div>
        </section>
      )}
    </AsyncState>
  );
}
