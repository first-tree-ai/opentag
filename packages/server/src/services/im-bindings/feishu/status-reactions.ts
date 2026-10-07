import type { Client } from "@larksuiteoapi/node-sdk";
import type { ProviderStatusReactionInput } from "../provider-adapter.js";

const EMOJI = { working: "OnIt", completed: "DONE", failed: "ERROR" } as const;
type ReactionApi = Pick<Client["im"]["v1"]["messageReaction"], "list" | "create" | "delete">;
type Reaction = NonNullable<Awaited<ReturnType<ReactionApi["list"]>>["data"]>["items"][number];

function assertSuccess(result: { code?: number }): void {
  if (result.code !== undefined && result.code !== 0) throw new Error("FEISHU_STATUS_REACTION_FAILED");
}

function ownedReactions(items: Reaction[], appId: string): Array<{ reactionId: string; emoji: string }> {
  return items.flatMap((item) => {
    if (
      item.operator?.operator_type !== "app" ||
      item.operator.operator_id !== appId ||
      !item.reaction_id ||
      !item.reaction_type
    )
      return [];
    return [{ reactionId: item.reaction_id, emoji: item.reaction_type.emoji_type }];
  });
}

async function listReactions(api: ReactionApi, messageId: string): Promise<Reaction[]> {
  const items: Reaction[] = [];
  let pageToken: string | undefined;
  // Bound pagination as well as the enclosing provider deadline; never mutate an incomplete list.
  for (let page = 0; page < 20; page += 1) {
    const response = await api.list({
      path: { message_id: messageId },
      params: { page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    assertSuccess(response);
    if (!response.data) throw new Error("FEISHU_STATUS_REACTION_LIST_INVALID");
    items.push(...response.data.items);
    if (!response.data.has_more) return items;
    if (!response.data.page_token || response.data.page_token === pageToken) break;
    pageToken = response.data.page_token;
  }
  throw new Error("FEISHU_STATUS_REACTION_LIST_INCOMPLETE");
}

export async function syncFeishuStatusReaction(
  api: ReactionApi,
  appId: string,
  input: ProviderStatusReactionInput,
): Promise<void> {
  const path = { message_id: input.messageExternalId };
  const desired = input.status === "cancelled" ? undefined : EMOJI[input.status];
  const own = ownedReactions(await listReactions(api, input.messageExternalId), appId);
  if (desired && !own.some((item) => item.emoji === desired)) {
    assertSuccess(await api.create({ path, data: { reaction_type: { emoji_type: desired } } }));
  }
  for (const item of own) {
    if (Object.values(EMOJI).some((emoji) => emoji === item.emoji) && item.emoji !== desired) {
      assertSuccess(await api.delete({ path: { ...path, reaction_id: item.reactionId } }));
    }
  }
}
