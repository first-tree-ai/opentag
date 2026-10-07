import type { WebClient } from "@slack/web-api";
import type { ProviderStatusReactionInput } from "../provider-adapter.js";

const EMOJI = { working: "eyes", completed: "white_check_mark", failed: "warning" } as const;

function isSlackError(error: unknown, expected: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "error" in error.data &&
    error.data.error === expected
  );
}

/** Mutate only this bot's reserved status reactions; contextual and other users' reactions survive. */
export async function syncSlackStatusReaction(
  api: Pick<WebClient["reactions"], "add" | "remove">,
  input: ProviderStatusReactionInput,
): Promise<void> {
  const target = { channel: input.channelId, timestamp: input.messageExternalId };
  const desired = input.status === "cancelled" ? undefined : EMOJI[input.status];
  if (desired) {
    try {
      await api.add({ ...target, name: desired });
    } catch (error) {
      if (!isSlackError(error, "already_reacted")) throw error;
    }
  }
  // Always remove obsolete reserved statuses, including an add that succeeded before a timeout.
  for (const name of Object.values(EMOJI)) {
    if (name === desired) continue;
    try {
      await api.remove({ ...target, name });
    } catch (error) {
      if (!isSlackError(error, "no_reaction")) throw error;
    }
  }
}
