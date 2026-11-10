import { ImContentV1Schema, TurnFailureReasonSchema } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { failureCardCopy } from "../services/im/im-feedback-card-copy.js";
import { effectsCopy, failureCopy, feedbackLanguage } from "../services/im/im-feedback-copy.js";
import { rejectedInputCode } from "../services/im/im-feedback-store.js";

function content(blocks: unknown[], fallbackText = "") {
  return ImContentV1Schema.parse({ version: 1, fallbackText, blocks });
}

describe("IM failure copy", () => {
  it("follows the language the sender wrote, not a mentioned Bot name", () => {
    expect(feedbackLanguage(content([{ type: "text", text: "帮我看一下 PR" }]))).toBe("zh");
    expect(feedbackLanguage(content([{ type: "text", text: "please check the PR" }]))).toBe("en");
    expect(
      feedbackLanguage(
        content([
          { type: "mention", externalId: "U1", label: "@小助手" },
          { type: "text", text: "please check the PR" },
        ]),
      ),
    ).toBe("en");
    expect(feedbackLanguage(content([], "失败"))).toBe("zh");
  });

  it("gives every failure reason a sentence and next step in both languages without its code", () => {
    for (const code of [...TurnFailureReasonSchema.options, "input_expired", "input_rejected", null, "<raw>"]) {
      for (const language of ["zh", "en"] as const) {
        const { cause, next } = failureCopy(code, language);
        for (const line of [cause, next]) {
          expect(line.length).toBeGreaterThan(0);
          expect(line).not.toMatch(/[a-z]+_[a-z]+/);
          expect(line).not.toContain("<raw>");
          expect(/\p{Script=Han}/u.test(line)).toBe(language === "zh");
        }
      }
    }
  });

  it.each([
    ["provider_rate_limited", "模型服务暂时不可用，任务没有完成。", "稍后再发一次。"],
    ["provider_quota_exceeded", "模型额度用完了，任务没有完成。", "请 Agent 所有者处理后再发一次。"],
    ["turn_timeout", "这个任务超过了时间上限，没有完成。", "可以拆小一点再发。"],
    ["client_shutdown", "执行环境出了问题，任务没有完成。", "再发一次；还不行请联系 Agent 所有者。"],
    ["turn_state_unknown", "无法确认任务是否完成。", "先看看结果，再决定要不要重发。"],
  ])("uses the agreed sentences for %s", (code, cause, next) => {
    expect(failureCopy(code, "zh")).toEqual({ cause, next });
  });

  it("keeps a failed batch's next step and adds the message count, without a retry warning", () => {
    expect(failureCopy("provider_unavailable", "zh", { batchRetryBlocked: true, batchSize: 3 }).next).toBe(
      "稍后再发一次。（共 3 条消息）",
    );
    expect(failureCopy("provider_unavailable", "en", { batchRetryBlocked: true, batchSize: 2 }).next).toBe(
      "Send it again later. (2 messages)",
    );
    const workspace = failureCopy("workspace_failed", "zh", {
      workspaceBlocked: true,
      batchRetryBlocked: true,
      batchSize: 4,
    }).next;
    expect(workspace.endsWith("（共 4 条消息）")).toBe(true);
    for (const language of ["zh", "en"] as const)
      expect(failureCopy("provider_failed", language, { batchRetryBlocked: true }).next).toBe(
        failureCopy("provider_failed", language).next,
      );
    expect(failureCopy("provider_failed", "zh", { batchRetryBlocked: true, batchSize: 2 }).next).not.toContain(
      "这批消息",
    );
  });

  it("says why an undelivered message did not reach the Agent", () => {
    expect(rejectedInputCode("ttl")).toBe("input_expired");
    expect(rejectedInputCode("configuration_unsupported")).toBe("input_unsupported");
    for (const reason of ["invalid_input", "computer_owner_mismatch", "steer_state_unknown", null])
      expect(rejectedInputCode(reason)).toBe("input_rejected");
    expect(failureCardCopy("input_unsupported")).toEqual({
      title: { zh: "消息没能送达", en: "Message not delivered" },
      body: { zh: "Agent 所在电脑的 OpenTag 需要升级", en: "OpenTag on the Agent's computer needs an upgrade" },
    });
    expect(failureCardCopy("input_rejected").body.zh).toBe("请重试");
    expect(failureCopy("input_unsupported", "zh").next).toBe("请 Agent 所有者升级后再发一次。");
  });

  it("only claims nothing ran on authoritative not-started evidence", () => {
    expect(effectsCopy("not_started", "zh")).toBe("任务没有开始，没有执行任何操作。");
    for (const effects of ["may_have_occurred", "completed", null])
      expect(effectsCopy(effects, "zh")).toBe("可能已经执行了部分操作，重发前请先检查结果。");
  });
});
