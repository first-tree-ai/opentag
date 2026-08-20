import type { TeamMemberSummary } from "@opentag/shared/browser";
import { browserApi } from "../../api.js";
import { useResource } from "../../lib/resource.js";
import { AsyncState } from "../../ui/async-state.js";
import { RowList } from "../../ui/data-display.js";

export function MembersSettings({ teamId }: { teamId: string }) {
  const state = useResource(() => browserApi.teams.members(teamId), teamId);
  return (
    <AsyncState state={state}>
      {(value) => (
        <RowList items={value.members} itemKey={(member: TeamMemberSummary) => member.userId}>
          {(member: TeamMemberSummary) => (
            <>
              <strong>{member.displayName}</strong>
              <span>{member.role}</span>
            </>
          )}
        </RowList>
      )}
    </AsyncState>
  );
}
