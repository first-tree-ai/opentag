import type {
  AgentSetupSnapshot,
  ImBindingAdminDetail,
  ImBindingIdentity,
  ImBindingSummary,
} from "@opentag/shared/browser";
import { slackBotConversationUrl } from "./slack-app-manifest.js";

/** Provider handoff contracts also used by completion; a URL is not proof of native DM delivery. */
export function botConversationUrl(identity: ImBindingIdentity): string | undefined {
  if (!identity.appId.trim()) return undefined;
  if (identity.provider === "slack") {
    return identity.teamId.trim() ? slackBotConversationUrl(identity.appId, identity.teamId) : undefined;
  }
  // The documented Feishu AppLink does not establish an equivalent Lark route.
  if (identity.teamBrand !== "feishu") return undefined;
  const url = new URL("https://applink.feishu.cn/client/bot/open");
  url.searchParams.set("appId", identity.appId);
  return url.toString();
}

/** Accept only the current overview binding and the generation confirmed by its setup read. */
export function matchesBotConversationBinding(
  current: ImBindingSummary,
  snapshot: AgentSetupSnapshot,
  binding: ImBindingAdminDetail | undefined,
): binding is ImBindingAdminDetail {
  const target = snapshot.messaging;
  return Boolean(
    binding &&
      current.bindingState === "active" &&
      snapshot.agent.id === current.agentId &&
      snapshot.agent.status === "active" &&
      target.kind === "ready" &&
      target.provider === current.provider &&
      target.bindingId === current.id &&
      binding.agentId === current.agentId &&
      binding.id === current.id &&
      binding.provider === current.provider &&
      binding.identity.provider === current.provider &&
      binding.credentialGeneration === target.credentialGeneration &&
      binding.bindingState === "active" &&
      !binding.reauthorizationRequired,
  );
}
