import { describe, expect, it } from "vitest";
import { messagingProviderLabel } from "./provider-label.js";

describe("messagingProviderLabel", () => {
  /*
   * The English product name, not the identifier. `feishu` stays the Server's vocabulary, so this
   * pair is the whole point of the helper: the id and the label are deliberately different words.
   */
  it("calls the Feishu provider Lark and leaves Slack alone", () => {
    expect(messagingProviderLabel("feishu")).toBe("Lark");
    expect(messagingProviderLabel("slack")).toBe("Slack");
  });

  it("refuses to label a provider it has never heard of", () => {
    // Only reachable if a provider is added to the schema without being given a label here. The
    // switch makes that a compile error first; this covers the runtime edge behind the cast.
    expect(() => messagingProviderLabel("telepathy" as "slack")).toThrow(/Unlabelled messaging provider/);
  });
});
