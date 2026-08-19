import type { MeMembership, MeResponse } from "@opentag/shared";

export function selectTeam(me: MeResponse, requestedTeamName?: string): MeMembership {
  if (requestedTeamName) {
    const selected = me.memberships.find((membership) => membership.teamName === requestedTeamName);
    if (!selected) throw new Error(`Team "${requestedTeamName}" is not available to the current user`);
    return selected;
  }
  if (me.memberships.length === 1) {
    const selected = me.memberships[0];
    if (!selected) throw new Error("No active Team membership is available");
    return selected;
  }
  if (me.memberships.length === 0) throw new Error("No active Team membership is available");
  const names = me.memberships
    .map((membership) => membership.teamName)
    .sort()
    .join(", ");
  throw new Error(`Multiple Teams are available; use --team <name>. Available Teams: ${names}`);
}
