import { describe, expect, it } from "vitest";
import {
  ListTeamComputersResponseSchema,
  TeamMemberAdminConfigSchema,
  TeamMemberSummarySchema,
  UpdateTeamProfileRequestSchema,
} from "../index.js";

describe("Team contracts", () => {
  it("keeps membership role and lifecycle as separate strict fields", () => {
    expect(
      TeamMemberAdminConfigSchema.parse({
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

  it("rejects admin-only membership fields from the member-safe projection", () => {
    expect(() =>
      TeamMemberSummarySchema.parse({
        userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        displayName: "Member",
        role: "member",
        email: "member@example.com",
      }),
    ).toThrow();
  });

  it("normalizes partial Team profile updates and requires at least one field", () => {
    expect(UpdateTeamProfileRequestSchema.parse({ name: "  First-Tree  " })).toEqual({ name: "first-tree" });
    expect(UpdateTeamProfileRequestSchema.parse({ displayName: "  First Tree AI  " })).toEqual({
      displayName: "First Tree AI",
    });
    expect(() => UpdateTeamProfileRequestSchema.parse({})).toThrow();
    expect(() => UpdateTeamProfileRequestSchema.parse({ name: "not url safe" })).toThrow();
    expect(() => UpdateTeamProfileRequestSchema.parse({ displayName: "   " })).toThrow();
  });
});
