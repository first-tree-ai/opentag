import { ImContentV1Schema, TurnFailureReasonSchema } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { failureCardCopy } from "../services/im/im-feedback-card-copy.js";
import { effectsCopy, failureCopy, feedbackLanguage, messageExcerpt } from "../services/im/im-feedback-copy.js";

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

  it("keeps the first twenty characters of what the sender wrote", () => {
    const content = (text: string) =>
      ImContentV1Schema.parse({ version: 1, fallbackText: text, blocks: [{ type: "text", text }] });
    expect(messageExcerpt(content("帮我把这周的周报整理一下，然后发到产品群里给大家看看"))).toBe(
      "帮我把这周的周报整理一下，然后发到产品群…",
    );
    expect(messageExcerpt(content("short\n  text"))).toBe("short text");
  });

  it("only claims nothing ran on authoritative not-started evidence", () => {
    expect(effectsCopy("not_started", "zh")).toBe("任务没有开始，没有执行任何操作。");
    for (const effects of ["may_have_occurred", "completed", null])
      expect(effectsCopy(effects, "zh")).toBe("可能已经执行了部分操作，重发前请先检查结果。");
  });

  it("names when a used-up quota is back, in China time, only when the Client reported a future time", () => {
    // 12:00 in Shanghai.
    const now = new Date("2026-11-11T04:00:00.000Z");
    const quota = (retryAt?: string) =>
      failureCardCopy("provider_quota_exceeded", { ...(retryAt ? { retryAt } : {}), now }).body;
    expect(quota("2026-11-11T07:30:00.000Z")).toEqual({
      zh: "将于 15:30 恢复",
      en: "Available again at 15:30 (UTC+8)",
    });
    expect(quota("2026-11-12T01:05:00.000Z")).toEqual({
      zh: "将于 11月12日 09:05 恢复",
      en: "Available again on Nov 12 at 09:05 (UTC+8)",
    });
    expect(quota()).toEqual({ zh: "额度恢复后请重试", en: "Try again after the quota resets" });
    expect(quota("2026-11-11T03:59:00.000Z")).toEqual(quota());
    expect(quota("not a time")).toEqual(quota());
    expect(
      failureCardCopy("provider_quota_exceeded", {
        retryAt: "2026-11-11T07:30:00.000Z",
        now,
        batchRetryBlocked: true,
        batchSize: 3,
      }).body.zh,
    ).toBe("将于 15:30 恢复（共 3 条消息）");
    // The rate-limit card never names a time.
    expect(failureCardCopy("provider_rate_limited", { retryAt: "2026-11-11T07:30:00.000Z", now }).body.zh).toBe(
      "请稍后重试",
    );
  });
});
