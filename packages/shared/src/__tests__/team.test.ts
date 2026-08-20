import { describe, expect, it } from "vitest";
import {
  CreateTeamRequestSchema,
  CreateTeamResponseSchema,
  ListTeamComputersResponseSchema,
  TeamMemberAdminConfigSchema,
  TeamMemberSummarySchema,
  TeamProfileSchema,
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

  it("normalizes a Team creation request into a canonical slug and trimmed display name", () => {
    expect(CreateTeamRequestSchema.parse({ name: "  First-Tree  ", displayName: "  First Tree AI  " })).toEqual({
      name: "first-tree",
      displayName: "First Tree AI",
    });
  });

  it("rejects Team creation names that are not URL-safe slugs", () => {
    for (const name of ["not url safe", "-leading-hyphen", "trailing_underscore", "", "a".repeat(65)]) {
      expect(() => CreateTeamRequestSchema.parse({ name, displayName: "Example" })).toThrow();
    }
  });

  it("requires both Team creation fields and rejects unknown ones", () => {
    expect(() => CreateTeamRequestSchema.parse({ name: "example" })).toThrow();
    expect(() => CreateTeamRequestSchema.parse({ displayName: "Example" })).toThrow();
    expect(() => CreateTeamRequestSchema.parse({ name: "example", displayName: "   " })).toThrow();
    expect(() => CreateTeamRequestSchema.parse({ name: "example", displayName: "Example", role: "admin" })).toThrow();
  });

  it("applies the same field limits to Team updates that creation enforces", () => {
    const overlongName = "a".repeat(65);
    const overlongDisplayName = "a".repeat(121);
    expect(() => CreateTeamRequestSchema.parse({ name: overlongName, displayName: "Example" })).toThrow();
    expect(() => UpdateTeamProfileRequestSchema.parse({ name: overlongName })).toThrow();
    expect(() => CreateTeamRequestSchema.parse({ name: "example", displayName: overlongDisplayName })).toThrow();
    expect(() => UpdateTeamProfileRequestSchema.parse({ displayName: overlongDisplayName })).toThrow();
    // A Team that creation accepts at the boundary must stay renameable to the same boundary.
    expect(UpdateTeamProfileRequestSchema.parse({ name: "a".repeat(64) })).toEqual({ name: "a".repeat(64) });
    expect(UpdateTeamProfileRequestSchema.parse({ displayName: "a".repeat(120) })).toEqual({
      displayName: "a".repeat(120),
    });
  });

  it("keeps reading Team rows that predate the writer limits", () => {
    // Older writers validly stored longer values in an unbounded text column. Bounds belong on the writers;
    // rejecting such a row here would only make /me unrecoverable for a Team nobody can still create.
    const legacy = {
      id: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
      name: "a".repeat(200),
      displayName: "a".repeat(300),
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    expect(TeamProfileSchema.parse(legacy)).toMatchObject({ name: legacy.name, displayName: legacy.displayName });
    expect(() => UpdateTeamProfileRequestSchema.parse({ displayName: legacy.displayName })).toThrow();
    expect(() => UpdateTeamProfileRequestSchema.parse({ name: legacy.name })).toThrow();
  });

  it("returns the created Team with the caller already holding the admin role", () => {
    const created = {
      id: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
      name: "first-tree",
      displayName: "First Tree AI",
      role: "admin",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    expect(CreateTeamResponseSchema.parse(created)).toEqual(created);
    expect(() => CreateTeamResponseSchema.parse({ ...created, role: "owner" })).toThrow();
    // Creator-becomes-admin is a hard contract, so a regression returning a member must not pass the boundary.
    expect(() => CreateTeamResponseSchema.parse({ ...created, role: "member" })).toThrow();
  });
});
