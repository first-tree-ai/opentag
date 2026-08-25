import type { ListWorkspaceComputersResponse } from "@opentag/shared";

export function formatComputerList(response: ListWorkspaceComputersResponse): string {
  if (response.computers.length === 0) return "No Computers registered";
  return response.computers
    .map((computer) =>
      [
        computer.displayName,
        computer.computerId,
        computer.connectionStatus,
        computer.platform,
        computer.lastSeenAt,
      ].join("\t"),
    )
    .join("\n");
}
