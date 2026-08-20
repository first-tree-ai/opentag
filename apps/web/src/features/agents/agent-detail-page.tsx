import type { AgentDetail } from "@opentag/shared/browser";
import { NavLink, useParams } from "react-router-dom";
import { browserApi } from "../../api.js";
import { titleCase } from "../../lib/format.js";
import { useResource } from "../../lib/resource.js";
import { NotFoundPage } from "../../routes/fallback-pages.js";
import { AsyncState } from "../../ui/async-state.js";
import { EmptyState } from "../../ui/empty-state.js";
import { Page } from "../../ui/page.js";
import { AccessTab } from "./tabs/access-tab.js";
import { GeneralTab } from "./tabs/general-tab.js";
import { ImTab } from "./tabs/im-tab.js";
import { RuntimeTab } from "./tabs/runtime-tab.js";

const agentTabs = ["general", "runtime", "im", "resources", "integrations", "access"] as const;

export function AgentDetailPage() {
  const { agentId = "", tab = "general" } = useParams();
  const state = useResource(() => browserApi.agents.get(agentId), agentId);
  if (!agentTabs.includes(tab as (typeof agentTabs)[number])) return <NotFoundPage />;
  return (
    <AsyncState state={state}>
      {(agent) => (
        <Page title={agent.displayName} eyebrow={agent.name}>
          <nav className="tabs" aria-label="Agent settings">
            {agentTabs.map((item) => (
              <NavLink to={`/agents/${agentId}/${item}`} key={item}>
                {titleCase(item)}
              </NavLink>
            ))}
          </nav>
          <AgentTab agent={agent} tab={tab} />
        </Page>
      )}
    </AsyncState>
  );
}

function AgentTab({ agent, tab }: { agent: AgentDetail; tab: string }) {
  if (tab === "general") return <GeneralTab agent={agent} />;
  if (tab === "runtime") return <RuntimeTab agent={agent} />;
  if (tab === "im") return <ImTab agent={agent} />;
  if (tab === "resources")
    return (
      <EmptyState title="No Team Resources assigned">
        The Team Resource model is not enabled in this release.
      </EmptyState>
    );
  if (tab === "integrations")
    return (
      <EmptyState title="No Agent Integrations supported">
        IM bot connections are managed separately on the IM tab.
      </EmptyState>
    );
  if (tab === "access") return <AccessTab agent={agent} />;
  return <NotFoundPage />;
}
