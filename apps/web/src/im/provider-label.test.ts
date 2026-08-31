import { ImProviderSchema } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { messagingProviderChoices, messagingProviderLabel } from "./provider-label.js";

describe("messagingProviderLabel", () => {
  it("names the channels OpenTag supports today", () => {
    expect(messagingProviderLabel("feishu")).toBe("Feishu");
    expect(messagingProviderLabel("slack")).toBe("Slack");
  });

  /*
   * The Feishu/Lark brand switch is not something a first connect can resolve, so a label that
   * named both would promise a domain we cannot mint yet. This is the assertion that fails if an
   * apposition ever creeps back into the helper.
   */
  it("never names a brand the connect flow cannot deliver", () => {
    for (const provider of ["feishu", "slack"] as const) {
      expect(messagingProviderLabel(provider)).not.toMatch(/also called|aka|\(/i);
    }
    expect(messagingProviderLabel("feishu")).not.toMatch(/Lark/i);
  });

  /*
   * Pinned to the schema rather than to the sentence, because the point of the helper is that the
   * set follows `ImProviderSchema`. Asserting the literal "Feishu or Slack" would pass for a
   * hand-written string too, which is the mistake the helper exists to prevent.
   */
  it("names every channel the schema declares, joined into prose", () => {
    const expected = ImProviderSchema.options.map(messagingProviderLabel);
    const rendered = messagingProviderChoices();
    for (const label of expected) expect(rendered).toContain(label);
    expect(rendered).toBe(
      expected.length > 1 ? `${expected.slice(0, -1).join(", ")} or ${expected.at(-1)}` : (expected.at(-1) ?? ""),
    );
  });

  it("refuses to label a provider it has never heard of", () => {
    // Only reachable if a provider joins the schema without being given a label here. The switch
    // makes that a compile error first; this covers the runtime edge behind the cast.
    expect(() => messagingProviderLabel("telepathy" as "slack")).toThrow(/Unlabelled messaging provider/);
  });
});
