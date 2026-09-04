/**
 * What a reader actually sees, for both brands, in Chinese.
 *
 * `provider-label.test.ts` pins the two pieces — the brand and the spacing rule — but a passing
 * pair of pieces is not a correct sentence. The defect these cover was exactly that: every helper
 * assertion held while the assembled settings copy read `断开 飞书` and `断开  Slack `, because the
 * template and the label each added a space the other had already accounted for. So these assert
 * finished messages, through the same functions the UI calls, for a Chinese brand and a Latin one.
 */

import { describe, expect, it } from "vitest";
import { withLocale } from "../__tests__/support/with-locale.js";
import { sharedConversationDestination } from "../features/agents/agent-presentation.js";
import { spaceScriptBoundary } from "../i18n/format.js";
import { messagingCliMissingCopy } from "../onboarding-v2/messaging-readiness-copy.js";
import * as m from "../paraglide/messages.js";
import { messagingProviderLabel } from "./provider-label.js";

/** The settings sentences, composed the way `im-tab.tsx` composes them. */
function disconnectCopy(provider: "feishu" | "slack") {
  const providerName = messagingProviderLabel(provider);
  return {
    action: spaceScriptBoundary(m.im_disconnect({ providerName })),
    title: spaceScriptBoundary(m.im_disconnect_title({ providerName })),
    failed: spaceScriptBoundary(m.im_disconnect_failed({ providerName })),
    description: spaceScriptBoundary(m.im_disconnect_description({ providerName })),
  };
}

describe("a brand inside a finished Chinese sentence", () => {
  it("joins a Chinese brand to the text with no space", () => {
    withLocale("zh", () => {
      expect(disconnectCopy("feishu")).toEqual({
        action: "断开飞书",
        title: "断开飞书？",
        failed: "无法断开飞书，请重试。",
        description: "断开飞书后，新消息将不再送达此 Agent，进行中的对话会结束；消息历史会保留。",
      });
      expect(sharedConversationDestination("feishu")).toBe("飞书群聊");
      expect(sharedConversationDestination("feishu", true)).toBe("已连接的飞书群聊");
    });
  });

  it("gives a Latin brand one space on each side, and none against punctuation", () => {
    withLocale("zh", () => {
      expect(disconnectCopy("slack")).toEqual({
        action: "断开 Slack",
        title: "断开 Slack？",
        failed: "无法断开 Slack，请重试。",
        description: "断开 Slack 后，新消息将不再送达此 Agent，进行中的对话会结束；消息历史会保留。",
      });
      expect(sharedConversationDestination("slack")).toBe("Slack 频道");
      expect(messagingCliMissingCopy("slack").startsWith("Slack 消息")).toBe(true);
    });
  });

  it("leaves the English sentences spaced as English already spaces them", () => {
    withLocale("en", () => {
      expect(disconnectCopy("feishu").title).toBe("Disconnect Lark?");
      expect(disconnectCopy("slack").title).toBe("Disconnect Slack?");
    });
  });
});
