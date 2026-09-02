import { describe, expect, it } from "vitest";
import { overwriteGetLocale } from "../paraglide/runtime.js";
import { messagingProviderAlternateBrand, messagingProviderLabel, spaceBrandInSentence } from "./provider-label.js";

/** Mirrors the helper in i18n/format.test.ts: run one assertion under a locale, then restore. */
function withLocale(locale: "en" | "zh", callback: () => void): void {
  overwriteGetLocale(() => locale);
  try {
    callback();
  } finally {
    overwriteGetLocale(() => "en");
  }
}

describe("messagingProviderLabel", () => {
  it("names the channels OpenTag supports today", () => {
    expect(messagingProviderLabel("feishu")).toBe("Lark");
    expect(messagingProviderLabel("slack")).toBe("Slack");
  });

  /*
   * A single connect code serves both brands — the vendor detects the tenant during authorization —
   * so the label names the brand this reader knows rather than hedging between them. The earlier
   * version of this test asserted the opposite, that the label must never say Lark, on the premise
   * that a Lark tenant could not authorize a Feishu-domain code. Testing against a real Lark tenant
   * disproved that premise; this asserts what replaced it.
   */
  it("names the brand the reader knows, in their locale", () => {
    withLocale("en", () => {
      expect(messagingProviderLabel("feishu")).toBe("Lark");
      expect(messagingProviderAlternateBrand()).toBe("Feishu");
    });
    withLocale("zh", () => {
      expect(messagingProviderLabel("feishu")).toBe("飞书");
      expect(messagingProviderAlternateBrand()).toBe("Lark");
    });
  });

  /** Slack has one name everywhere, so locale must not touch it. */
  it("leaves a single-brand channel alone in every locale", () => {
    for (const locale of ["en", "zh"] as const) {
      withLocale(locale, () => expect(messagingProviderLabel("slack")).toBe("Slack"));
    }
  });

  it("refuses to label a provider it has never heard of", () => {
    // Only reachable if a provider joins the schema without being given a label here. The switch
    // makes that a compile error first; this covers the runtime edge behind the cast.
    expect(() => messagingProviderLabel("telepathy" as "slack")).toThrow(/Unlabelled messaging provider/);
  });

  /*
   * The cases the previous model got wrong. Padding the label put a space wherever the slot sat,
   * which is right between two runs of text and wrong everywhere else: at the end of a button, or
   * against Chinese punctuation that already carries its own width.
   */
  it("spaces a Latin brand against Chinese text and nothing else", () => {
    withLocale("zh", () => {
      expect(spaceBrandInSentence("断开Slack")).toBe("断开 Slack");
      expect(spaceBrandInSentence("无法断开Slack，请重试。")).toBe("无法断开 Slack，请重试。");
      expect(spaceBrandInSentence("断开飞书")).toBe("断开飞书");
      expect(spaceBrandInSentence("已连接的Slack频道")).toBe("已连接的 Slack 频道");
    });
  });

  /** Running it twice must not widen a gap it already set, since messages compose. */
  it("leaves an already-spaced sentence alone", () => {
    withLocale("zh", () => {
      const once = spaceBrandInSentence("断开Slack");
      expect(spaceBrandInSentence(once)).toBe(once);
      expect(spaceBrandInSentence("同时支持 Lark")).toBe("同时支持 Lark");
    });
  });

  /** English already spaces every word, so the rule must not touch it. */
  it("leaves English untouched", () => {
    withLocale("en", () => {
      expect(spaceBrandInSentence("Disconnect Slack")).toBe("Disconnect Slack");
      expect(messagingProviderLabel("feishu")).toBe("Lark");
      expect(messagingProviderAlternateBrand()).toBe("Feishu");
    });
  });
});
