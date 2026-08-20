import type { AgentDetail } from "@opentag/shared/browser";
import { DefinitionList } from "../../../ui/data-display.js";

export function AccessTab({ agent }: { agent: AgentDetail }) {
  return (
    <DefinitionList
      rows={[
        ["Safe read", "All active Team members"],
        ["Use", "All active Team members (fixed v0.1 policy)"],
        ["Manage", agent.viewerCapabilities.canManage ? "Team Admins · you can manage" : "Team Admins"],
      ]}
    />
  );
}
