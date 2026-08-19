import type { ListComputersResponse } from "@opentag/shared";

export function formatComputerList(response: ListComputersResponse): string {
  if (response.computers.length === 0) return "No Computers registered";
  return response.computers
    .map((computer) =>
      [
        computer.displayName,
        computer.id,
        computer.connectionStatus,
        `${computer.platform}/${computer.arch}`,
        computer.clientVersion,
        computer.lastSeenAt,
      ].join("\t"),
    )
    .join("\n");
}
