import { describe, expect, it } from "vitest";
import { messagingProviderChoices, messagingProviderLabel } from "./provider-label.js";

describe("messaging provider labels", () => {
  it("uses stable product names for provider ids", () => {
    expect(messagingProviderLabel("feishu")).toBe("Feishu");
    expect(messagingProviderLabel("slack")).toBe("Slack");
  });

  it("formats the complete provider choice list", () => {
    expect(messagingProviderChoices()).toBe("Feishu or Slack");
  });
});
