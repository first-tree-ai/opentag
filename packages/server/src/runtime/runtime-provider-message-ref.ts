import type { RuntimeProviderMessageRef } from "@opentag/shared";
import type { imBindings, imMessages } from "../db/schema/index.js";

type RuntimeMessage = Pick<
  typeof imMessages.$inferSelect,
  "channelId" | "externalMessageId" | "providerContext" | "authorKind" | "authorExternalId"
>;

export function runtimeProviderMessageRef(
  message: RuntimeMessage,
  binding: typeof imBindings.$inferSelect,
): RuntimeProviderMessageRef {
  if (!binding.externalAppId || !binding.externalBotId) throw new Error("IM_BINDING_IDENTITY_INCOMPLETE");
  if (message.providerContext.provider === "feishu") {
    const { provider: _provider, ...context } = message.providerContext;
    return {
      provider: "feishu",
      teamBrand: binding.externalTeamBrand === "lark" ? "lark" : "feishu",
      appId: binding.externalAppId,
      botOpenId: binding.externalBotId,
      chatId: message.channelId,
      messageId: message.externalMessageId,
      ...context,
    };
  }
  if (!binding.externalTeamId) throw new Error("IM_BINDING_IDENTITY_INCOMPLETE");
  const { provider: _provider, ...context } = message.providerContext;
  const authorUserId = slackHumanAuthorUserId(message, binding);
  return {
    provider: "slack",
    appId: binding.externalAppId,
    teamId: binding.externalTeamId,
    ...(binding.externalEnterpriseId ? { enterpriseId: binding.externalEnterpriseId } : {}),
    botUserId: binding.externalBotId,
    channelId: message.channelId,
    messageTs: message.externalMessageId,
    ...context,
    ...(authorUserId ? { authorUserId } : {}),
  };
}

function slackHumanAuthorUserId(
  message: Pick<RuntimeMessage, "authorKind" | "authorExternalId">,
  binding: Pick<typeof imBindings.$inferSelect, "externalBotId">,
): string | undefined {
  if (message.authorKind !== "human") return undefined;
  if (!message.authorExternalId) return undefined;
  if (message.authorExternalId === binding.externalBotId) return undefined;
  return message.authorExternalId;
}
