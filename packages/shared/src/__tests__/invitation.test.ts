import { describe, expect, it } from "vitest";
import { InvitationPreviewSchema, TeamInvitationSchema } from "../index.js";

describe("invitation contracts", () => {
  it("returns only bounded public preview fields", () => {
    expect(
      InvitationPreviewSchema.parse({
        teamDisplayName: "Example",
        role: "member",
        expiresAt: "2026-08-26T00:00:00.000Z",
      }),
    ).toEqual({ teamDisplayName: "Example", role: "member", expiresAt: "2026-08-26T00:00:00.000Z" });
  });

  it("requires a bounded bearer token for authorized invitation display", () => {
    expect(() =>
      TeamInvitationSchema.parse({
        token: "short",
        inviteUrl: "https://example.com/invite/short",
        role: "member",
        expiresAt: "2026-08-26T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
