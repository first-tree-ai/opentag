import { describe, expect, it } from "vitest";
import { InvitationPreviewSchema, InvitationTokenSchema } from "../index.js";

describe("invitation contracts", () => {
  it("returns only bounded public preview fields", () => {
    expect(
      InvitationPreviewSchema.parse({
        workspaceDisplayName: "Example",
        expiresAt: "2026-08-26T00:00:00.000Z",
      }),
    ).toEqual({ workspaceDisplayName: "Example", expiresAt: "2026-08-26T00:00:00.000Z" });
  });

  it("requires a bounded bearer token to redeem an outstanding invitation", () => {
    expect(() => InvitationTokenSchema.parse("short")).toThrow();
    expect(InvitationTokenSchema.parse("A".repeat(43))).toBe("A".repeat(43));
  });
});
