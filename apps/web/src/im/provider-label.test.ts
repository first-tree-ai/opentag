import { describe, expect, it } from "vitest";
import { overwriteGetLocale } from "../paraglide/runtime.js";
import {
  messagingProviderAlternateBrand,
  messagingProviderAlternateBrandInSentence,
  messagingProviderLabel,
  messagingProviderLabelInSentence,
} from "./provider-label.js";

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
   * Chinese sets no space between Chinese characters and one space either side of Latin text, and
   * the same {provider} slot receives both. The template cannot decide that; the label knows its own
   * script, so it carries its own boundary.
   */
  it("spaces a Latin brand inside a Chinese sentence and a Chinese one not at all", () => {
    withLocale("zh", () => {
      expect(messagingProviderLabelInSentence("feishu")).toBe("飞书");
      expect(messagingProviderLabelInSentence("slack")).toBe(" Slack ");
      expect(messagingProviderAlternateBrandInSentence()).toBe(" Lark ");
    });
  });

  /** English already spaces every word, so the in-sentence form must add nothing. */
  it("leaves English untouched", () => {
    withLocale("en", () => {
      expect(messagingProviderLabelInSentence("feishu")).toBe("Lark");
      expect(messagingProviderLabelInSentence("slack")).toBe("Slack");
      expect(messagingProviderAlternateBrandInSentence()).toBe("Feishu");
    });
  });
});
