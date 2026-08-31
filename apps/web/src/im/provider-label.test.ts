import { describe, expect, it } from "vitest";
import { messagingProviderLabel } from "./provider-label.js";

describe("messagingProviderLabel", () => {
  it("names the channels OpenTag supports today", () => {
    expect(messagingProviderLabel("feishu")).toBe("Feishu");
    expect(messagingProviderLabel("slack")).toBe("Slack");
  });

  /*
   * Feishu and Lark are separate channels, so no label may present one as another name for the
   * other. This is the assertion that fails if an "also called" apposition ever creeps back in.
   */
  it("never presents one channel as another channel's alias", () => {
    for (const provider of ["feishu", "slack"] as const) {
      expect(messagingProviderLabel(provider)).not.toMatch(/also called|aka|\(/i);
    }
    expect(messagingProviderLabel("feishu")).not.toMatch(/Lark/i);
  });

  it("refuses to label a provider it has never heard of", () => {
    // Only reachable if a provider joins the schema without being given a label here. The switch
    // makes that a compile error first; this covers the runtime edge behind the cast.
    expect(() => messagingProviderLabel("telepathy" as "slack")).toThrow(/Unlabelled messaging provider/);
  });
});
