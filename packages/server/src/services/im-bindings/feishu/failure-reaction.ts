import type { Client } from "@larksuiteoapi/node-sdk";

export const FEISHU_FAILURE_EMOJI = "CrossMark";
type ReactionClient = Pick<Client["im"]["v1"]["messageReaction"], "create" | "list" | "delete">;

/** Re-list on every attempt: a lost API response must neither duplicate nor strand a reaction. */
export async function setFeishuFailureReaction(
  api: ReactionClient,
  appId: string,
  messageId: string,
  failed: boolean,
): Promise<void> {
  const owned = await listOwnedReactions(api, appId, messageId);
  if (failed && owned.length === 0) {
    const response = await api.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: FEISHU_FAILURE_EMOJI } },
    });
    if (response.code !== 0) throw new Error("FEISHU_FAILURE_REACTION_CREATE_FAILED");
  }
  if (!failed) {
    for (const reactionId of owned) {
      const response = await api.delete({ path: { message_id: messageId, reaction_id: reactionId } });
      if (response.code !== 0) throw new Error("FEISHU_FAILURE_REACTION_DELETE_FAILED");
    }
  }
}

type Reaction = NonNullable<Awaited<ReturnType<ReactionClient["list"]>>["data"]>["items"][number];

function ownedReactionId(item: Reaction, appId: string): string | undefined {
  if (
    item.operator?.operator_type !== "app" ||
    item.operator.operator_id !== appId ||
    item.reaction_type?.emoji_type !== FEISHU_FAILURE_EMOJI
  )
    return;
  return item.reaction_id;
}

async function listOwnedReactions(api: ReactionClient, appId: string, messageId: string): Promise<string[]> {
  const owned: string[] = [];
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const response = await api.list({
      path: { message_id: messageId },
      params: { reaction_type: FEISHU_FAILURE_EMOJI, page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    if (response.code !== 0 || !response.data) throw new Error("FEISHU_FAILURE_REACTION_LIST_FAILED");
    for (const item of response.data.items) {
      const id = ownedReactionId(item, appId);
      if (id) owned.push(id);
    }
    pageToken = nextPage(response.data.has_more, response.data.page_token, tokens);
  } while (pageToken);
  return owned;
}

function nextPage(hasMore: boolean, token: string, tokens: Set<string>): string | undefined {
  if (!hasMore) return;
  if (!token || tokens.has(token) || tokens.size >= 100) throw new Error("FEISHU_FAILURE_REACTION_PAGINATION_INVALID");
  tokens.add(token);
  return token;
}
