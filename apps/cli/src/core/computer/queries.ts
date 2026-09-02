import type { ListAccountComputersResponse } from "@opentag/shared";
import { resolveCommandContext } from "../command/context.js";

export async function listComputers(home?: string): Promise<ListAccountComputersResponse> {
  const context = await resolveCommandContext({ home, requireAuth: true });
  if (!context.api || !context.accessToken) throw new Error("Command context did not resolve an authenticated API");
  return context.api.listAccountComputers(context.accessToken);
}
