import { describe, expect, it } from "vitest";
import { ListTeamComputersResponseSchema, TeamMemberSchema } from "../index.js";

describe("Team contracts", () => {
  it("keeps membership role and lifecycle as separate strict fields", () => {
    expect(
      TeamMemberSchema.parse({
        teamId: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
        userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        email: "member@example.com",
        displayName: "Member",
        role: "member",
        status: "left",
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
      }),
    ).toMatchObject({ role: "member", status: "left" });
  });

  it("requires explicit observation time for Computer connection snapshots", () => {
    expect(() => ListTeamComputersResponseSchema.parse({ computers: [{ id: crypto.randomUUID() }] })).toThrow();
  });
});
