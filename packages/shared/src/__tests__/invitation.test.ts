import { describe, expect, it } from "vitest";
import { AdminInvitationSchema, InvitationPreviewSchema } from "../index.js";

describe("invitation contracts", () => {
  it("returns only bounded public preview fields", () => {
    expect(
      InvitationPreviewSchema.parse({
        workspaceDisplayName: "Example",
        expiresAt: "2026-08-26T00:00:00.000Z",
      }),
    ).toEqual({ workspaceDisplayName: "Example", expiresAt: "2026-08-26T00:00:00.000Z" });
  });

  it("requires a bounded bearer token for authorized invitation display", () => {
    expect(() =>
      AdminInvitationSchema.parse({
        token: "short",
        inviteUrl: "https://example.com/invites/short",
        expiresAt: "2026-08-26T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
