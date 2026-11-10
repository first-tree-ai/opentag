import { ImContentV1Schema, TurnFailureReasonSchema } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { failureCardCopy } from "../services/im/im-feedback-card-copy.js";
import { effectsCopy, failureCopy, feedbackLanguage } from "../services/im/im-feedback-copy.js";

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

  it("keeps a frozen batch's own failure card and only appends how many messages it held (R5)", () => {
    expect(failureCardCopy("provider_unavailable", { batchSize: 3 })).toEqual({
      title: { zh: "模型服务暂时不可用", en: "Model service temporarily unavailable" },
      body: { zh: "请稍后重试（共 3 条消息）", en: "Try again later (3 messages)" },
    });
    expect(failureCardCopy("provider_unavailable", { batchSize: 1 })).toEqual(failureCardCopy("provider_unavailable"));
    expect(failureCardCopy("turn_timeout", { batchSize: 2, workspaceBlocked: true }).body.zh).toBe(
      "请在 OpenTag 重试保存或放弃改动（共 2 条消息）",
    );
    const text = failureCopy("provider_quota_exceeded", "zh", { batchSize: 4 });
    expect(text.cause).toBe(failureCopy("provider_quota_exceeded", "zh").cause);
    expect(text.next).toBe(`${failureCopy("provider_quota_exceeded", "zh").next}（共 4 条消息）`);
    expect(failureCopy("provider_failed", "en", { batchSize: 2 }).next).toMatch(/ \(2 messages\)$/u);
  });

  it("only claims nothing ran on authoritative not-started evidence", () => {
    expect(effectsCopy("not_started", "zh")).toBe("任务没有开始，没有执行任何操作。");
    for (const effects of ["may_have_occurred", "completed", null])
      expect(effectsCopy(effects, "zh")).toBe("可能已经执行了部分操作，重发前请先检查结果。");
  });
});
