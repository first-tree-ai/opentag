import { Link, Navigate, useParams } from "react-router-dom";
import { buttonClassName, Text } from "../../ui/design-system.js";
import { NotFoundPage } from "../not-found.js";
import { AsyncState, useResource } from "../resource/use-resource.js";
import { AgentObjectHeader } from "./agent-detail-page.js";
import { loadAgentDetail, markAgentDetailUnconfirmed } from "./agent-model.js";

export function LegacyAgentSectionRedirect() {
  const { agentId = "", legacySection = "" } = useParams();
  const destinations: Record<string, string> = {
    general: `/agents/${agentId}`,
    runtime: `/agents/${agentId}/settings/execution`,
    im: `/agents/${agentId}/settings/messaging`,
  };
  const destination = destinations[legacySection];
  if (destination) return <Navigate replace to={destination} />;
  if (legacySection === "integrations" || legacySection === "skills") {
    return <LegacyAgentCapabilityPage capability={legacySection} />;
  }
  return <NotFoundPage />;
}

export function LegacyAgentCapabilityPage({ capability }: { capability: "integrations" | "skills" }) {
  const { agentId = "" } = useParams();
  const state = useResource(() => loadAgentDetail(agentId), agentId, {
    onBackgroundError: markAgentDetailUnconfirmed,
  });
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
              <Link className={buttonClassName()} to={`/agents/${agent.id}`}>
                Back to {agent.displayName}
              </Link>
              <Link className={buttonClassName({ variant: "secondary" })} to={`/${capability}`}>
                Browse {label}
              </Link>
            </div>
          </div>
        </section>
      )}
    </AsyncState>
  );
}
