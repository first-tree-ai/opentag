import { describe, expect, it } from "vitest";
import { messagingProviderLabel } from "./provider-label.js";

describe("messagingProviderLabel", () => {
  it("names the channels OpenTag supports today", () => {
    expect(messagingProviderLabel("feishu")).toBe("Feishu");
    expect(messagingProviderLabel("slack")).toBe("Slack");
  });

  /*
   * One code is minted against one domain, so a label that named both brands at once would
   * describe something no connect attempt can be. The name follows the brand instead — and where
   * no brand is known, it stays with Feishu rather than hedging.
   */
  it("names one brand at a time, never an apposition", () => {
    for (const provider of ["feishu", "slack"] as const) {
      expect(messagingProviderLabel(provider)).not.toMatch(/also called|aka|\(/i);
    }
    expect(messagingProviderLabel("feishu")).not.toMatch(/Lark/i);
    expect(messagingProviderLabel("feishu", "lark")).not.toMatch(/Feishu/i);
  });

  /*
   * The brand is a property of the tenant, decided before a code is minted. A reader connecting a
   * Lark company is told Lark on every surface that knows it, which is the whole reason the label
   * takes the brand rather than reading it back off a binding that does not exist yet.
   */
  it("follows the brand a connect attempt was minted against", () => {
    expect(messagingProviderLabel("feishu", "lark")).toBe("Lark");
    expect(messagingProviderLabel("feishu", "feishu")).toBe("Feishu");
    // Slack has no regional brand; passing one changes nothing rather than being rejected.
    expect(messagingProviderLabel("slack", "lark")).toBe("Slack");
  });

  it("refuses to label a provider it has never heard of", () => {
    // Only reachable if a provider joins the schema without being given a label here. The switch
    // makes that a compile error first; this covers the runtime edge behind the cast.
    expect(() => messagingProviderLabel("telepathy" as "slack")).toThrow(/Unlabelled messaging provider/);
  });
});
